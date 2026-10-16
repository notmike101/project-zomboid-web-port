package org.teavm.classlib.java.nio.channels;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import org.teavm.classlib.java.io.TFile;
import org.teavm.runtime.fs.VirtualFile;
import org.teavm.runtime.fs.VirtualFileAccessor;
import org.teavm.runtime.fs.VirtualFileSystemProvider;
import org.teavm.classlib.java.nio.TByteBuffer;
import org.teavm.classlib.java.nio.file.TOpenOption;
import org.teavm.classlib.java.nio.file.TStandardOpenOption;
import org.teavm.classlib.java.nio.file.TPath;
import org.teavm.classlib.java.nio.file.TFileAlreadyExistsException;
import org.teavm.classlib.java.nio.file.TNoSuchFileException;
import org.teavm.classlib.java.nio.file.attribute.TFileAttribute;

/** Actual module VFS IO, with single-agent locks; no durable or cross-process guarantees. */
public class TFileChannel implements TSeekableByteChannel {
    private static final ArrayList<TFileLock> LOCKS = new ArrayList<>();
    private final VirtualFileAccessor file;
    private final TFile path;
    private final String key;
    private final boolean readable, writable, append, deleteOnClose;
    private java.io.Closeable owner;
    private boolean open = true;
    private TFileChannel(TFile path, boolean readable, boolean writable, boolean append, boolean deleteOnClose) throws IOException {
        this.path = path; this.readable = readable; this.writable = writable;
        this.append = append; this.deleteOnClose = deleteOnClose;
        key = path.getCanonicalPath();
        VirtualFile target = VirtualFileSystemProvider.getInstance().getFile(key);
        // Writable non-append VFS accessors truncate at construction. Open preserving
        // contents, then establish the channel's own initial position explicitly.
        file = target.createAccessor(readable, writable, writable);
        if (file == null) throw new java.io.FileNotFoundException(key);
        file.seek(append ? file.size() : 0);
    }
    /** Shares a stream's already-open accessor, position, and close ownership without reopening its path. */
    public TFileChannel(VirtualFileAccessor accessor, TFile path, boolean append, java.io.Closeable owner) throws IOException {
        this.file = accessor; this.path = path; this.append = append; this.owner = owner;
        key = path.getCanonicalPath();
        readable = false; writable = true; deleteOnClose = false;
        open = accessor != null;
    }
    public static TFileChannel open(TPath path, TOpenOption... options) throws IOException {
        Objects.requireNonNull(options);
        Set<TOpenOption> set = new HashSet<>();
        for (TOpenOption option : options) set.add(Objects.requireNonNull(option));
        return open(path, set, new TFileAttribute<?>[0]);
    }
    public static TFileChannel open(TPath path, Set<? extends TOpenOption> options, TFileAttribute<?>... attrs) throws IOException {
        Objects.requireNonNull(path); Objects.requireNonNull(options); Objects.requireNonNull(attrs);
        if (attrs.length != 0) throw new UnsupportedOperationException("VFS file attributes");
        boolean read = false, write = false, append = false, create = false, createNew = false, truncate = false, delete = false;
        for (TOpenOption option : options) {
            Objects.requireNonNull(option);
            if (!(option instanceof TStandardOpenOption)) throw new UnsupportedOperationException("Open option: " + option);
            switch ((TStandardOpenOption) option) {
                case READ: read = true; break;
                case WRITE: write = true; break;
                case APPEND: append = true; write = true; break;
                case CREATE: create = true; break;
                case CREATE_NEW: createNew = true; break;
                case TRUNCATE_EXISTING: truncate = true; break;
                case DELETE_ON_CLOSE: delete = true; break;
                case SPARSE: break; // Hint permitted to be ignored by the provider.
                default: throw new UnsupportedOperationException("VFS cannot guarantee synchronous persistence");
            }
        }
        if (append && (read || truncate)) throw new IllegalArgumentException("APPEND with READ or TRUNCATE_EXISTING");
        if (!read && !write) read = true;
        TFile target = new TFile(path.toAbsolutePath().normalize().toString());
        if (write && createNew) {
            if (!target.createNewFile()) throw new TFileAlreadyExistsException(target.toString());
        } else if (!target.exists()) {
            if (write && create) target.createNewFile();
            else throw new TNoSuchFileException(target.toString());
        }
        TFileChannel result = new TFileChannel(target, read, write, append, delete);
        if (write && truncate) {
            try { result.file.resize(0); }
            catch (IOException error) { result.close(); throw error; }
        }
        return result;
    }
    private void ensureOpen() throws IOException { if (!open) throw new TClosedChannelException(); }
    private void beginIO() throws IOException {
        ensureOpen();
        if (Thread.currentThread().isInterrupted()) { close(); throw new TClosedByInterruptException(); }
    }
    @Override public boolean isOpen() { return open; }
    @Override public int read(TByteBuffer dst) throws IOException {
        ensureOpen(); if (!readable) throw new TNonReadableChannelException();
        Objects.requireNonNull(dst);
        if (dst.isReadOnly()) throw new IllegalArgumentException("Read-only buffer");
        beginIO();
        if (!dst.hasRemaining()) return 0;
        byte[] bytes = new byte[Math.min(dst.remaining(), 8192)];
        int count = file.read(bytes, 0, bytes.length);
        if (count == 0) count = -1;
        if (count > 0) dst.put(bytes, 0, count);
        return count;
    }
    @Override public int write(TByteBuffer src) throws IOException {
        ensureOpen(); if (!writable) throw new TNonWritableChannelException();
        Objects.requireNonNull(src); beginIO();
        int count = Math.min(src.remaining(), 8192);
        if (count == 0) return 0;
        if (append) file.seek(file.size());
        if ((long) file.tell() + count > Integer.MAX_VALUE) throw new IOException("VFS file size exceeds supported integer range");
        byte[] bytes = new byte[count];
        int start = src.position();
        for (int i = 0; i < count; i++) bytes[i] = src.get(start + i);
        file.write(bytes, 0, count); src.position(start + count); return count;
    }
    @Override public long position() {
        try { beginIO(); return append ? file.size() : file.tell(); }
        catch (IOException error) { return TFileChannel.<RuntimeException, Long>rethrow(error); }
    }
    @SuppressWarnings("unchecked")
    private static <E extends Throwable, R> R rethrow(Throwable error) throws E { throw (E) error; }
    @Override public TFileChannel position(long position) throws IOException {
        ensureOpen(); if (position < 0) throw new IllegalArgumentException(); beginIO();
        if (position > Integer.MAX_VALUE) throw new IOException("VFS position exceeds supported integer range");
        file.seek((int) position); return this;
    }
    @Override public long size() throws IOException { beginIO(); return file.size(); }
    @Override public TFileChannel truncate(long size) throws IOException {
        ensureOpen(); if (size < 0) throw new IllegalArgumentException();
        if (!writable) throw new TNonWritableChannelException();
        beginIO(); if (size < file.size()) file.resize((int) size);
        if (file.tell() > size) file.seek((int) size);
        return this;
    }
    public final TFileLock tryLock() throws IOException { return tryLock(0, Long.MAX_VALUE, false); }
    public TFileLock tryLock(long position, long size, boolean shared) throws IOException {
        ensureOpen();
        if (shared && !readable) throw new TNonReadableChannelException();
        if (!shared && !writable) throw new TNonWritableChannelException();
        if (size == 0) size = Long.MAX_VALUE - Math.max(0, position);
        TFileLock lock = new TFileLock(this, position, size, shared);
        for (TFileLock existing : LOCKS) {
            if (existing.channel().key.equals(key) && existing.overlaps(position, size)) throw new TOverlappingFileLockException();
        }
        LOCKS.add(lock); return lock;
    }
    public final TFileLock lock() throws IOException { return lock(0, Long.MAX_VALUE, false); }
    public TFileLock lock(long position, long size, boolean shared) throws IOException {
        TFileLock result = tryLock(position, size, shared);
        if (Thread.currentThread().isInterrupted()) { close(); throw new TFileLockInterruptionException(); }
        return result;
    }
    void release(TFileLock lock) { LOCKS.remove(lock); }
    @Override public void close() throws IOException {
        if (!open) return;
        open = false;
        for (int i = LOCKS.size() - 1; i >= 0; i--) {
            TFileLock lock = LOCKS.get(i);
            if (lock.channel() == this) { lock.invalidate(); LOCKS.remove(i); }
        }
        try { if (owner != null) owner.close(); else file.close(); }
        finally { if (deleteOnClose && path.exists() && !path.delete()) throw new IOException("Cannot delete channel file"); }
    }
}
