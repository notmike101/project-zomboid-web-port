package probe;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.ClosedWatchServiceException;
import java.nio.file.FileSystems;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.StandardWatchEventKinds;
import java.nio.file.WatchEvent;
import java.nio.file.WatchKey;
import java.nio.file.WatchService;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Semantic event checks: operating systems may coalesce or repeat events differently. */
public final class WatchProbe {
    public static void main(String[] args) throws Exception {
        File root = File.createTempFile("teavm-watch-", ".tmp");
        if (!root.delete() || !root.mkdir()) throw new IOException("Cannot allocate owned watch directory");
        String[] names = {"create", "modify", "delete", "reregister-filter", "reset-requeue", "cancel", "close-wakes-take", "interrupt-and-validation"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        try {
            for (int i = 0; i < names.length; i++) {
                File directory = new File(root, "case" + i);
                if (!directory.mkdir()) throw new IOException("Cannot create case directory");
                File child = new File(directory, "event.bin");
                if (i == 1 || i == 2 || i == 7) write(child, false);
                int flags = 0;
                try (WatchService service = FileSystems.getDefault().newWatchService()) {
                    Path path = directory.toPath();
                    WatchKey key = path.register(service, StandardWatchEventKinds.ENTRY_CREATE,
                            StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE);
                    if (!key.isValid() || !key.watchable().equals(path) || !key.pollEvents().isEmpty()) throw new AssertionError("Initial key state");
                    if (i <= 2) {
                        if (i == 2) { if (!child.delete()) throw new IOException("Delete failed"); }
                        else write(child, i == 1);
                        WatchEvent.Kind<Path> kind = i == 0 ? StandardWatchEventKinds.ENTRY_CREATE : i == 1 ? StandardWatchEventKinds.ENTRY_MODIFY : StandardWatchEventKinds.ENTRY_DELETE;
                        awaitEvent(service, kind, child.getName());
                        flags = 1;
                    } else if (i == 3) {
                        if (path.register(service, StandardWatchEventKinds.ENTRY_DELETE) != key) throw new AssertionError("Registration identity changed");
                        write(child, false);
                        if (service.poll(75, TimeUnit.MILLISECONDS) != null) throw new AssertionError("Unrequested create event");
                        if (!child.delete()) throw new IOException("Delete failed");
                        awaitEvent(service, StandardWatchEventKinds.ENTRY_DELETE, child.getName());
                        flags = 3;
                    } else if (i == 4) {
                        write(child, false);
                        WatchKey signalled = service.poll(3, TimeUnit.SECONDS);
                        if (signalled != key || signalled.pollEvents().isEmpty()) throw new AssertionError("Missing first signal");
                        File second = new File(directory, "second.bin");
                        write(second, false);
                        if (service.poll(75, TimeUnit.MILLISECONDS) != null) throw new AssertionError("Signalled key queued twice");
                        if (!key.reset()) throw new AssertionError("Reset failed");
                        awaitEvent(service, StandardWatchEventKinds.ENTRY_CREATE, second.getName());
                        flags = 7;
                    } else if (i == 5) {
                        key.cancel(); key.cancel();
                        if (key.isValid() || key.reset()) throw new AssertionError("Cancelled key remained valid");
                        write(child, false);
                        if (service.poll(75, TimeUnit.MILLISECONDS) != null) throw new AssertionError("Cancelled watch delivered events");
                        flags = 15;
                    } else if (i == 6) {
                        int[] outcome = {0};
                        Thread consumer = new Thread(() -> {
                            try { service.take(); outcome[0] = -1; }
                            catch (ClosedWatchServiceException expected) { outcome[0] = 1; }
                            catch (InterruptedException failure) { outcome[0] = -2; }
                        });
                        consumer.start(); Thread.sleep(50); service.close(); consumer.join(2000);
                        if (consumer.isAlive() || outcome[0] != 1 || key.isValid()) throw new AssertionError("Close did not wake take");
                        try { service.poll(); throw new AssertionError(); } catch (ClosedWatchServiceException expected) { }
                        flags = 31;
                    } else {
                        try { child.toPath().register(service, StandardWatchEventKinds.ENTRY_CREATE); throw new AssertionError(); } catch (NotDirectoryException expected) { }
                        try { path.register(service, new WatchEvent.Kind<?>[0]); throw new AssertionError(); } catch (IllegalArgumentException expected) { }
                        try { path.register(service, (WatchEvent.Kind<?>[]) null); throw new AssertionError(); } catch (NullPointerException expected) { }
                        int[] outcome = {0};
                        Thread consumer = new Thread(() -> {
                            try { service.take(); outcome[0] = -1; }
                            catch (InterruptedException expected) { outcome[0] = 1; }
                        });
                        consumer.start(); Thread.sleep(50); consumer.interrupt(); consumer.join(2000);
                        if (consumer.isAlive() || outcome[0] != 1) throw new AssertionError("Interrupt did not wake take");
                        flags = 63;
                    }
                }
                if (i != 0) json.append(',');
                json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"semanticFlags\":");
                append(json, flags);
                json.append(",\"caseIndex\":");
                append(json, i);
                json.append("}}");
            }
        } finally {
            File[] directories = root.listFiles();
            if (directories == null) throw new IOException("Cannot inspect owned watch directory");
            for (File directory : directories) {
                File[] files = directory.listFiles();
                if (files == null) throw new IOException("Cannot inspect owned case directory");
                for (File file : files) if (!file.delete()) throw new IOException("Cannot delete owned watch file");
                if (!directory.delete()) throw new IOException("Cannot delete owned case directory");
            }
            if (!root.delete()) throw new IOException("Cannot delete owned watch directory");
        }
        System.out.println(json.append("]}"));
    }

    private static void write(File file, boolean append) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file, append)) { output.write(new byte[]{1, 2, 3}); }
    }
    private static void awaitEvent(WatchService service, WatchEvent.Kind<Path> kind, String name) throws Exception {
        long start = System.nanoTime();
        while (System.nanoTime() - start < TimeUnit.SECONDS.toNanos(3)) {
            WatchKey key = service.poll(1, TimeUnit.SECONDS);
            if (key == null) continue;
            List<WatchEvent<?>> events = key.pollEvents();
            boolean found = false;
            for (WatchEvent<?> event : events) {
                if (event.kind() == kind && event.count() > 0 && event.context() instanceof Path
                        && !((Path) event.context()).isAbsolute() && event.context().toString().equals(name)) found = true;
            }
            if (!key.reset()) throw new AssertionError("Key unexpectedly invalid");
            if (found) return;
        }
        throw new AssertionError("Missing " + kind.name() + " for " + name);
    }
    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
