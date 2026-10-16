package port.runtime;

import java.io.File;
import java.io.IOException;
import java.nio.file.ClosedWatchServiceException;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.ProviderMismatchException;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.nio.file.Watchable;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/** Polls actual default-provider directories. Browser files live in TeaVM's memory filesystem. */
public final class PollingWatchService implements WatchService {
    private final Map<Path, Key> registrations = new HashMap<>();
    private final ArrayDeque<Key> ready = new ArrayDeque<>();
    private final Thread poller;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private boolean closed;

    private PollingWatchService() {
        poller = new Thread(this::run, "virtual-filesystem-watcher");
        poller.setDaemon(true);
        poller.start();
    }

    public static WatchService create(FileSystem filesystem) {
        if (filesystem != FileSystems.getDefault()) throw new UnsupportedOperationException("Default filesystem watches only");
        return new PollingWatchService();
    }

    public static WatchKey register(Path path, WatchService service, WatchEvent.Kind<?>... kinds) throws IOException {
        return register(path, service, kinds, new WatchEvent.Modifier[0]);
    }

    public static WatchKey register(Path path, WatchService service, WatchEvent.Kind<?>[] kinds,
            WatchEvent.Modifier[] modifiers) throws IOException {
        Objects.requireNonNull(path);
        Objects.requireNonNull(service);
        Objects.requireNonNull(kinds);
        Objects.requireNonNull(modifiers);
        if (!(service instanceof PollingWatchService) || path.getFileSystem() != FileSystems.getDefault()) {
            throw new ProviderMismatchException();
        }
        Set<WatchEvent.Kind<?>> interests = new HashSet<>();
        for (WatchEvent.Kind<?> kind : kinds) {
            Objects.requireNonNull(kind);
            if (kind == StandardWatchEventKinds.OVERFLOW) continue;
            if (kind != StandardWatchEventKinds.ENTRY_CREATE && kind != StandardWatchEventKinds.ENTRY_DELETE
                    && kind != StandardWatchEventKinds.ENTRY_MODIFY) throw new UnsupportedOperationException("Unsupported watch kind");
            interests.add(kind);
        }
        if (interests.isEmpty()) throw new IllegalArgumentException("No entry event kinds specified");
        for (WatchEvent.Modifier modifier : modifiers) {
            Objects.requireNonNull(modifier);
            throw new UnsupportedOperationException("Watch modifiers are not supported");
        }
        PollingWatchService watcher = (PollingWatchService) service;
        watcher.lock.lock();
        try {
            watcher.checkOpen();
            Files.readAttributes(path, java.nio.file.attribute.BasicFileAttributes.class);
            if (!Files.isDirectory(path)) throw new NotDirectoryException(path.toString());
            Path identity = path.toAbsolutePath().normalize();
            Key existing = watcher.registrations.get(identity);
            if (existing != null && existing.valid) {
                existing.interests = interests;
                return existing;
            }
            Key key = watcher.new Key(path, identity, interests, snapshot(identity));
            watcher.registrations.put(identity, key);
            return key;
        } finally { watcher.lock.unlock(); }
    }

    private void run() {
        try {
            while (true) {
                Thread.sleep(25);
                lock.lock();
                try {
                    if (closed) return;
                    scan();
                } finally { lock.unlock(); }
            }
        } catch (RuntimeException failure) {
            close();
        } catch (InterruptedException stopped) {
            lock.lock();
            try {
                if (!closed) {
                    // A lost polling worker must wake consumers instead of silently stopping delivery.
                    closed = true;
                    for (Key key : registrations.values()) key.valid = false;
                    registrations.clear();
                    ready.clear();
                    changed.signalAll();
                }
            } finally { lock.unlock(); }
        }
    }

    private static Map<Path, Stamp> snapshot(Path path) throws IOException {
        File directory = path.toFile();
        File[] children = directory.listFiles();
        if (children == null) throw new IOException("Watched directory is inaccessible: " + path);
        Map<Path, Stamp> result = new HashMap<>();
        for (File child : children) {
            result.put(path.getFileSystem().getPath(child.getName()), new Stamp(child.lastModified(), child.length(), child.isDirectory()));
        }
        return result;
    }

    private void scan() {
        for (Key key : new ArrayList<>(registrations.values())) {
            if (!key.valid) continue;
            Map<Path, Stamp> current;
            try { current = snapshot(key.identity); }
            catch (IOException inaccessible) {
                key.valid = false;
                registrations.remove(key.identity);
                key.signal();
                continue;
            }
            for (Map.Entry<Path, Stamp> entry : current.entrySet()) {
                Stamp previous = key.snapshot.get(entry.getKey());
                if (previous == null) key.event(StandardWatchEventKinds.ENTRY_CREATE, entry.getKey());
                else if (!previous.same(entry.getValue())) key.event(StandardWatchEventKinds.ENTRY_MODIFY, entry.getKey());
            }
            for (Path previous : key.snapshot.keySet()) {
                if (!current.containsKey(previous)) key.event(StandardWatchEventKinds.ENTRY_DELETE, previous);
            }
            key.snapshot = current;
        }
    }

    private void checkOpen() { if (closed) throw new ClosedWatchServiceException(); }

    @Override public WatchKey poll() {
        lock.lock();
        try {
            checkOpen();
            scan();
            return ready.poll();
        } finally { lock.unlock(); }
    }

    @Override public WatchKey take() throws InterruptedException {
        lock.lockInterruptibly();
        try {
        while (true) {
            checkOpen();
            if (Thread.interrupted()) throw new InterruptedException();
            Key key = ready.poll();
            if (key != null) return key;
            changed.await();
        }
        } finally { lock.unlock(); }
    }

    @Override public WatchKey poll(long timeout, TimeUnit unit) throws InterruptedException {
        long remaining = Objects.requireNonNull(unit).toNanos(timeout);
        long start = System.nanoTime();
        lock.lockInterruptibly();
        try {
        while (true) {
            checkOpen();
            if (Thread.interrupted()) throw new InterruptedException();
            Key key = ready.poll();
            if (key != null || remaining <= 0) return key;
            changed.awaitNanos(remaining);
            long elapsed = System.nanoTime() - start;
            remaining = elapsed >= unit.toNanos(timeout) ? 0 : unit.toNanos(timeout) - elapsed;
        }
        } finally { lock.unlock(); }
    }

    @Override public void close() {
        lock.lock();
        try {
            if (closed) return;
            closed = true;
            for (Key key : registrations.values()) key.valid = false;
            registrations.clear();
            ready.clear();
            changed.signalAll();
        } finally { lock.unlock(); }
        poller.interrupt();
    }

    private final class Key implements WatchKey {
        private final Path path;
        private final Path identity;
        private Set<WatchEvent.Kind<?>> interests;
        private Map<Path, Stamp> snapshot;
        private final List<WatchEvent<?>> events = new ArrayList<>();
        private boolean valid = true;
        private boolean signalled;
        Key(Path path, Path identity, Set<WatchEvent.Kind<?>> interests, Map<Path, Stamp> snapshot) {
            this.path = path;
            this.identity = identity;
            this.interests = interests;
            this.snapshot = snapshot;
        }
        private void signal() {
            if (!signalled) {
                signalled = true;
                ready.add(this);
                changed.signalAll();
            }
        }
        private void event(WatchEvent.Kind<Path> kind, Path context) {
            if (!interests.contains(kind)) return;
            if (!events.isEmpty()) {
                Event<?> last = (Event<?>) events.get(events.size() - 1);
                if (last.kind == StandardWatchEventKinds.OVERFLOW || last.kind == kind && Objects.equals(last.context, context)) {
                    if (last.count < Integer.MAX_VALUE) last.count++;
                    signal();
                    return;
                }
            }
            if (events.size() >= 512) {
                events.clear();
                events.add(new Event<>(StandardWatchEventKinds.OVERFLOW, null));
            } else events.add(new Event<>(kind, context));
            signal();
        }
        @Override public boolean isValid() { lock.lock(); try { return valid; } finally { lock.unlock(); } }
        @Override public List<WatchEvent<?>> pollEvents() {
            lock.lock();
            try {
                List<WatchEvent<?>> result = new ArrayList<>(events);
                events.clear();
                return result;
            } finally { lock.unlock(); }
        }
        @Override public boolean reset() {
            lock.lock();
            try {
                if (!valid) return false;
                if (signalled) {
                    if (events.isEmpty()) signalled = false;
                    else if (!ready.contains(this)) ready.add(this);
                    changed.signalAll();
                }
                return true;
            } finally { lock.unlock(); }
        }
        @Override public void cancel() {
            lock.lock();
            try {
                if (!valid) return;
                valid = false;
                registrations.remove(identity);
            } finally { lock.unlock(); }
        }
        @Override public Watchable watchable() { return path; }
    }

    private static final class Event<T> implements WatchEvent<T> {
        private final Kind<T> kind;
        private final T context;
        private int count = 1;
        Event(Kind<T> kind, T context) { this.kind = kind; this.context = context; }
        @Override public Kind<T> kind() { return kind; }
        @Override public T context() { return context; }
        @Override public int count() { return count; }
    }
    private static final class Stamp {
        private final long modified;
        private final long size;
        private final boolean directory;
        Stamp(long modified, long size, boolean directory) { this.modified = modified; this.size = size; this.directory = directory; }
        boolean same(Stamp other) { return modified == other.modified && size == other.size && directory == other.directory; }
    }
}
