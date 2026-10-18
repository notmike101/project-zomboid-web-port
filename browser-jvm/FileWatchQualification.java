import java.nio.file.*;
import java.util.*;
import zombie.DebugFileWatcher;
import zombie.PredicatedFileWatcher;
import zombie.ZomboidFileSystem;

/** Original game watcher lifecycle, real owned filesystem changes and original debounce. */
public final class FileWatchQualification {
    public static native void report(String json);
    public static native void remoteMutation(int phase);
    private static int checks;
    private static String stage = "initial";
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }
    private static Object field(DebugFileWatcher watcher, String name) throws Exception {
        var field = DebugFileWatcher.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(watcher);
    }
    private static void awaitChange(DebugFileWatcher watcher, List<String> observed, int count) throws Exception {
        long end = System.nanoTime() + 6_000_000_000L;
        while (observed.size() < count && System.nanoTime() < end) {
            watcher.update();
            Thread.sleep(10);
        }
        check(observed.size() == count, "Actual original debounce/callback count " + count + ": " + observed);
    }
    public static void main(String[] args) throws Exception {
        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        Path root = Path.of(args[1]).toAbsolutePath().normalize();
        NioWatchQualification.main(new String[]{args[0], root.resolve("nio").toString()});
        boolean remote = args.length > 2;
        Path media = remote ? Path.of(args[2]) : root.resolve("media");
        if (!remote) Files.createDirectories(media.resolve("sub"));
        var fs = ZomboidFileSystem.instance;
        fs.setCacheDir(root.resolve("cache").toString());
        DebugFileWatcher watcher = null;
        WatchService service = null;
        try {
            stage = "original-filesystem-init";
            fs.init();
            check(Path.of(fs.getMediaRootPath()).equals(media), "Original media root follows actual working directory");
            check(fs.base.canonicalFile.toPath().equals(media.getParent()), "Original base is actual configured working directory");
            stage = "original-watcher-init";
            watcher = DebugFileWatcher.instance;
            watcher.init();
            check(!zombie.core.Core.getInstance().isNoSave() && !zombie.network.GameClient.client && !zombie.network.GameServer.server, "Original offline/save policy unchanged");
            check(watcher.isInitialized(), "Original watcher initialized itself");
            service = (WatchService) field(watcher,"watcher");
            check(service != null, "Actual watch service retained");
            var keys = (Map<?,?>) field(watcher,"watchkeyMapping");
            check(keys.size() == 3, "Original recursive media + messaging registration");
            List<String> observed = new ArrayList<>();
            Path message = Path.of(fs.getMessagingDir()).resolve("observed.txt");
            check(message.startsWith(root), "Actual messaging path remains owned");
            PredicatedFileWatcher callback = new PredicatedFileWatcher(path -> path.endsWith("observed.txt"), observed::add);
            watcher.add(callback);
            stage = "original-create-callback";
            Files.writeString(message,"first");
            awaitChange(watcher,observed,1);
            check(observed.get(0).equals(message.toString()), "Original callback receives actual canonical file path");
            stage = "original-modify-callback";
            Files.writeString(message,"second");
            awaitChange(watcher,observed,2);
            check(Files.readString(message).equals("second"), "Actual modified content");
            stage = "original-recursive-registration";
            Path created = media.resolve("new-child");
            if (remote) remoteMutation(0); else Files.createDirectory(created);
            long end = System.nanoTime() + 4_000_000_000L;
            while (keys.size() < 4 && System.nanoTime() < end) { watcher.update(); Thread.sleep(10); }
            check(keys.size() == 4, "Original update recursively registered actual new directory");
            if (remote) remoteMutation(1); else Files.writeString(created.resolve("observed.txt"),"nested");
            awaitChange(watcher,observed,3);
            check(observed.get(2).equals(created.resolve("observed.txt").toString()), "Original nested file callback");
            if (remote) {
                check(Files.readString(created.resolve("observed.txt")).equals("nested"), "Actual served content");
                remoteMutation(2);
                awaitChange(watcher,observed,4);
                check(Files.readString(created.resolve("observed.txt")).equals("modified-remote"), "Actual HTTP cache refreshed before original callback");
                check(Files.size(created.resolve("observed.txt")) == 15, "Actual HTTP stat cache refreshed");
                remoteMutation(3);
                long deletedDeadline = System.nanoTime() + 4_000_000_000L;
                while (Files.exists(created.resolve("observed.txt")) && System.nanoTime() < deletedDeadline) Thread.sleep(10);
                check(!Files.exists(created.resolve("observed.txt")), "Actual remote deletion invalidates cached existence");
            }
            watcher.remove(callback);
            if (remote) {
                stage = "unsupported-http-scope";
                try (WatchService unsupported = FileSystems.getDefault().newWatchService()) {
                    boolean rejected = false;
                    try { Path.of("/app").register(unsupported, StandardWatchEventKinds.ENTRY_CREATE); }
                    catch (java.io.IOException expected) { rejected = true; }
                    check(rejected, "Original IOException rejects an unserved HTTP watch scope");
                }
            }
            stage = "closed";
            String json = "{\"pass\":true,\"checks\":"+checks+",\"callbacks\":"+observed.size()+",\"registered\":"+keys.size()+",\"originalDebounce\":true}";
            if (args[0].equals("browser")) report(json); else System.out.println(json);
        } catch (Throwable error) {
            error.printStackTrace();
            String json = "{\"pass\":false,\"checks\":"+checks+",\"stage\":\""+stage+"\",\"error\":\""+error.toString().replace("\\","\\\\").replace("\"","\\\"")+"\"}";
            if (args[0].equals("browser")) report(json); else System.out.println(json);
        } finally {
            if (service != null) service.close();
        }
    }
}
