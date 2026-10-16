package port.runtime;

import java.io.IOException;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.teavm.jso.JSBody;
import org.teavm.runtime.fs.VirtualFile;
import org.teavm.runtime.fs.VirtualFileAccessor;
import org.teavm.runtime.fs.VirtualFileSystem;
import org.teavm.runtime.fs.VirtualFileSystemProvider;

/** Immutable, preloaded installed-media mount; other paths retain the previous in-memory filesystem. */
public final class BrowserAssets implements VirtualFileSystem {
    private final VirtualFileSystem previous;
    private final Map<String, Entry> entries = new HashMap<>();

    private BrowserAssets(VirtualFileSystem previous) {
        this.previous = previous;
    }

    /** Host fetch and SHA-256 validation must complete before this bootstrap is called. */
    public static void mount() {
        VirtualFileSystem previous = VirtualFileSystemProvider.getInstance();
        if (previous instanceof BrowserAssets) throw new IllegalStateException("Assets already mounted");
        int count = validateHost();
        BrowserAssets filesystem = new BrowserAssets(previous);
        filesystem.entries.put("/media", new Entry(null, 0));
        for (int index = 0; index < count; index++) {
            String path = hostPath(index);
            int size = hostSize(index);
            byte[] bytes = new byte[size];
            for (int offset = 0; offset < size; offset++) bytes[offset] = (byte) hostByte(index, offset);
            if (filesystem.entries.put(path, new Entry(bytes, (long) hostModified(index))) != null)
                throw new IllegalArgumentException("Duplicate asset path");
            int slash = path.lastIndexOf('/');
            while (slash > 0) {
                String parent = path.substring(0, slash);
                Entry entry = filesystem.entries.get(parent);
                if (entry != null && entry.data != null) throw new IllegalArgumentException("Asset parent is a file");
                filesystem.entries.putIfAbsent(parent, new Entry(null, 0));
                slash = parent.lastIndexOf('/');
            }
        }
        VirtualFileSystemProvider.setInstance(filesystem);
    }

    public static int contentHash(String path) {
        VirtualFileSystem filesystem = VirtualFileSystemProvider.getInstance();
        if (!(filesystem instanceof BrowserAssets)) throw new IllegalStateException("Assets not mounted");
        Entry entry = ((BrowserAssets) filesystem).entries.get(((BrowserAssets) filesystem).normalize(path));
        if (entry == null || entry.data == null) throw new IllegalArgumentException("Not a mounted asset file");
        return Arrays.hashCode(entry.data);
    }

    @Override public String getUserDir() { return previous.getUserDir(); }
    @Override public boolean isWindows() { return previous.isWindows(); }
    @Override public boolean isCaseSensitive() { return previous.isCaseSensitive(); }
    @Override public String[] getRoots() { return previous.getRoots(); }
    @Override public String canonicalize(String path) { return normalize(path); }
    @Override public VirtualFile getFile(String path) { return new Node(normalize(path)); }

    private String normalize(String path) {
        Objects.requireNonNull(path);
        if (!path.startsWith("/")) path = previous.getUserDir() + "/" + path;
        java.util.ArrayList<String> parts = new java.util.ArrayList<>();
        for (String part : path.split("/")) {
            if (part.isEmpty() || part.equals(".")) continue;
            if (part.equals("..")) { if (!parts.isEmpty()) parts.remove(parts.size() - 1); }
            else parts.add(part);
        }
        return "/" + String.join("/", parts);
    }
    private static boolean mounted(String path) { return path.equals("/media") || path.startsWith("/media/"); }
    private String child(String parent, String name) { return normalize(parent + "/" + name); }

    private final class Node implements VirtualFile {
        private final String path;
        Node(String path) { this.path = path; }
        private VirtualFile delegate() { return previous.getFile(path); }
        private Entry entry() { return entries.get(path); }
        @Override public String getName() { return path.substring(path.lastIndexOf('/') + 1); }
        @Override public boolean isDirectory() { return mounted(path) ? entry() != null && entry().data == null : delegate().isDirectory(); }
        @Override public boolean isFile() { return mounted(path) ? entry() != null && entry().data != null : delegate().isFile(); }
        @Override public String[] listFiles() {
            if (!mounted(path) && !path.equals("/")) return delegate().listFiles();
            if (!isDirectory()) return null;
            Set<String> children = new LinkedHashSet<>();
            if (path.equals("/")) {
                String[] existing = delegate().listFiles();
                if (existing != null) children.addAll(Arrays.asList(existing));
                children.add("media");
            } else {
                for (String candidate : entries.keySet()) {
                    if (candidate.startsWith(path + "/")) {
                        String suffix = candidate.substring(path.length() + 1);
                        if (!suffix.contains("/")) children.add(suffix);
                    }
                }
            }
            return children.toArray(new String[0]);
        }
        @Override public VirtualFileAccessor createAccessor(boolean readable, boolean writable, boolean append) {
            if (!mounted(path)) return delegate().createAccessor(readable, writable, append);
            return !readable || writable || append || !isFile() ? null : new Accessor(entry().data);
        }
        @Override public boolean createFile(String name) throws IOException {
            return !mounted(path) && !mounted(child(path, name)) && delegate().createFile(name);
        }
        @Override public boolean createDirectory(String name) {
            return !mounted(path) && !mounted(child(path, name)) && delegate().createDirectory(name);
        }
        @Override public boolean delete() { return !mounted(path) && !path.equals("/") && delegate().delete(); }
        @Override public boolean adopt(VirtualFile source, String name) {
            if (mounted(path) || mounted(child(path, name))) return false;
            if (source instanceof BrowserAssets.Node) {
                Node node = (Node) source;
                if (mounted(node.path) || node.path.equals("/")) return false;
                return delegate().adopt(node.delegate(), name);
            }
            return delegate().adopt(source, name);
        }
        @Override public boolean canRead() { return mounted(path) ? entry() != null : delegate().canRead(); }
        @Override public boolean canWrite() { return !mounted(path) && delegate().canWrite(); }
        @Override public long lastModified() { return mounted(path) ? entry() == null ? 0 : entry().modified : delegate().lastModified(); }
        @Override public boolean setLastModified(long modified) { return !mounted(path) && delegate().setLastModified(modified); }
        @Override public boolean setReadOnly(boolean readOnly) { return mounted(path) ? entry() != null && readOnly : delegate().setReadOnly(readOnly); }
        @Override public int length() { return mounted(path) ? isFile() ? entry().data.length : 0 : delegate().length(); }
    }

    private static final class Entry {
        final byte[] data;
        final long modified;
        Entry(byte[] data, long modified) { this.data = data; this.modified = modified; }
    }
    private static final class Accessor implements VirtualFileAccessor {
        private final byte[] data;
        private int position;
        private boolean closed;
        Accessor(byte[] data) { this.data = data; }
        private void open() throws IOException { if (closed) throw new IOException("Asset stream closed"); }
        @Override public int read(byte[] buffer, int offset, int count) throws IOException {
            open();
            Objects.checkFromIndexSize(offset, count, buffer.length);
            int length = Math.max(0, Math.min(count, data.length - position));
            System.arraycopy(data, Math.min(position, data.length), buffer, offset, length);
            position += length;
            return length;
        }
        @Override public int tell() throws IOException { open(); return position; }
        @Override public void seek(int target) throws IOException { open(); if (target < 0) throw new IOException("Negative position"); position = target; }
        @Override public void skip(int amount) throws IOException {
            long target = (long) position + amount;
            if (target < 0 || target > Integer.MAX_VALUE) throw new IOException("Asset position out of range");
            seek((int) target);
        }
        @Override public int size() throws IOException { open(); return data.length; }
        @Override public void write(byte[] buffer, int offset, int count) throws IOException { open(); throw new IOException("Read-only asset"); }
        @Override public void resize(int size) throws IOException { open(); throw new IOException("Read-only asset"); }
        @Override public void close() { closed = true; }
        @Override public void flush() throws IOException { open(); }
    }

    @JSBody(script = """
            if (!(self.portAssetFiles instanceof Map) || !Array.isArray(self.portAssetManifest)) throw new Error('Asset host missing');
            const seen = new Set();
            for (const entry of self.portAssetManifest) {
                if (typeof entry.path !== 'string' || !entry.path.startsWith('/media/') || entry.path.includes('\\\\')
                    || entry.path.includes('\\0') || entry.path.split('/').slice(1).some(p => !p || p === '.' || p === '..')
                    || seen.has(entry.path) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > 16777216
                    || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('Invalid asset manifest');
                const bytes = self.portAssetFiles.get(entry.path);
                if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size) throw new Error('Asset bytes differ from manifest');
                seen.add(entry.path);
            }
            if (!seen.size || seen.size !== self.portAssetFiles.size) throw new Error('Asset manifest coverage differs');
            return seen.size;
            """)
    private static native int validateHost();
    @JSBody(params = "index", script = "return self.portAssetManifest[index].path;") private static native String hostPath(int index);
    @JSBody(params = "index", script = "return self.portAssetManifest[index].size;") private static native int hostSize(int index);
    @JSBody(params = "index", script = "return self.portAssetManifest[index].mtime;") private static native double hostModified(int index);
    @JSBody(params = {"index", "offset"}, script = "return self.portAssetFiles.get(self.portAssetManifest[index].path)[offset];")
    private static native int hostByte(int index, int offset);
}
