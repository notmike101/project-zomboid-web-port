import java.nio.file.*;
import java.util.concurrent.TimeUnit;
import java.util.HashSet;
import java.util.Set;

/** Exercises the actual JDK filesystem event service within one owned directory. */
public final class NioWatchQualification {
    public static native void report(String json);
    private static boolean browser;
    private static String stage = "initial";
    private static int checks;
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }
    private static String quote(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
    private static void awaitEvent(WatchService service, WatchEvent.Kind<Path> kind, String name) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
        while (System.nanoTime() < deadline) {
            WatchKey key = service.poll(200, TimeUnit.MILLISECONDS);
            if (key == null) continue;
            boolean found = false;
            for (WatchEvent<?> event : key.pollEvents()) {
                if (event.kind() == kind && event.context().toString().equals(name)) found = true;
            }
            check(key.reset(), "Actual watched directory remains valid");
            if (found) return;
        }
        throw new AssertionError("Missing actual " + kind.name() + " for " + name);
    }
    private static void awaitEvents(WatchService service, String... wanted) throws Exception {
        Set<String> pending = new HashSet<>(java.util.List.of(wanted));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
        while (!pending.isEmpty() && System.nanoTime() < deadline) {
            WatchKey key = service.poll(200, TimeUnit.MILLISECONDS);
            if (key == null) continue;
            for (WatchEvent<?> event : key.pollEvents()) pending.remove(event.kind().name() + ":" + event.context());
            check(key.reset(), "Live event batch key");
        }
        check(pending.isEmpty(), "Missing event batch " + pending);
    }
    public static void main(String[] args) {
        if (args[0].equals("vm-exit")) {
            try {
                WatchService watch = FileSystems.getDefault().newWatchService();
                WatchKey key = Path.of(args[1]).register(watch, StandardWatchEventKinds.ENTRY_CREATE);
                check(key.isValid(), "Actual process-lifetime watch registered");
                Thread.sleep(100);
                report("{\"pass\":true,\"stage\":\"before-system-exit\",\"watchOpen\":true}");
                System.exit(0);
                throw new AssertionError("System.exit returned");
            } catch (Exception error) {
                throw new RuntimeException("Actual process-lifetime watch qualification failed", error);
            }
        }
        browser = args[0].equals("browser");
        Path root = Path.of(args[1]).toAbsolutePath().normalize();
        String provider = FileSystems.getDefault().provider().getClass().getName();
        String result;
        try {
            stage = "owned-directory";
            Files.createDirectories(root);
            stage = "create-watch-service";
            try (WatchService watch = FileSystems.getDefault().newWatchService()) {
                stage = "register";
                WatchKey registered = root.register(watch, StandardWatchEventKinds.ENTRY_CREATE,
                        StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE);
                check(registered.isValid(), "Original watch key registered");
                Path file = root.resolve("observed.txt");
                stage = "create-event";
                Files.writeString(file, "first");
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_CREATE, "observed.txt");
                stage = "modify-event";
                Files.writeString(file, "second");
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_MODIFY, "observed.txt");
                check(Files.readString(file).equals("second"), "Actual modified content");
                stage = "delete-event";
                Files.delete(file);
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_DELETE, "observed.txt");
                check(!Files.exists(file), "Actual deleted file");
                stage = "duplicate-registration";
                check(root.register(watch, StandardWatchEventKinds.ENTRY_CREATE,
                        StandardWatchEventKinds.ENTRY_MODIFY, StandardWatchEventKinds.ENTRY_DELETE) == registered,
                        "Original duplicate registration reuses key");
                stage = "unicode-rename";
                Path unicode = root.resolve("unicode-\u03a9-\ud83d\ude03.txt"), renamed = root.resolve("renamed.txt");
                Files.writeString(unicode, "unicode");
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_CREATE, unicode.getFileName().toString());
                Files.move(unicode, renamed);
                awaitEvents(watch, "ENTRY_DELETE:" + unicode.getFileName(), "ENTRY_CREATE:renamed.txt");
                Files.delete(renamed);
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_DELETE, "renamed.txt");
                stage = "directory-events";
                Path directory = root.resolve("child");
                Files.createDirectory(directory);
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_CREATE, "child");
                Files.delete(directory);
                awaitEvent(watch, StandardWatchEventKinds.ENTRY_DELETE, "child");
                registered.cancel();
                check(!registered.isValid(), "Original key cancellation");
            }
            stage = "directory-invalidation";
            Path invalidated = root.resolve("invalidated");
            Files.createDirectory(invalidated);
            try (WatchService watch = FileSystems.getDefault().newWatchService()) {
                WatchKey key = invalidated.register(watch, StandardWatchEventKinds.ENTRY_CREATE);
                Files.delete(invalidated);
                check(watch.poll(4, TimeUnit.SECONDS) == key, "Deleted directory signals original key");
                check(!key.isValid() && !key.reset(), "Original deleted key invalidation");
            }
            stage = "closed-service";
            WatchService closed = FileSystems.getDefault().newWatchService();
            closed.close();
            boolean caught = false;
            try { closed.poll(); } catch (ClosedWatchServiceException expected) { caught = true; }
            check(caught, "Original closed service exception");
            stage = "closed";
            result = "{\"pass\":true,\"checks\":" + checks + ",\"provider\":" + quote(provider) + ",\"stage\":" + quote(stage) + "}";
        } catch (Throwable error) {
            result = "{\"pass\":false,\"checks\":" + checks + ",\"provider\":" + quote(provider)
                    + ",\"stage\":" + quote(stage) + ",\"errorClass\":" + quote(error.getClass().getName())
                    + ",\"error\":" + quote(String.valueOf(error.getMessage())) + "}";
        }
        if (browser) report(result); else System.out.println(result);
    }
}
