import java.nio.file.*;
import java.util.concurrent.*;
import java.util.zip.*;
import se.krka.kahlua.vm.KahluaTable;
import zombie.GameWindow;
import zombie.Lua.LuaManager;
import zombie.core.Core;
import zombie.gameStates.MainScreenState;
import zombie.ui.UIElement;
import port.host.*;

/** Owns an original menu component; loading/world initialization is a separate frontier. */
public final class BrowserMenuSession implements AutoCloseable {
    private MainScreenState menu;
    private boolean entered;
    private final java.util.List<String> luaErrors = new java.util.ArrayList<>();
    private final java.util.logging.Logger logger = java.util.logging.Logger.getLogger(LuaManager.class.getName());
    private final java.util.logging.Handler errors = new java.util.logging.Handler() {
        public void publish(java.util.logging.LogRecord record) {
            if (record.getLevel().intValue() >= java.util.logging.Level.SEVERE.intValue()) luaErrors.add(record.getMessage());
        }
        public void flush() { }
        public void close() { }
    };
    public long frames;

    public static String quote(String text) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (character == '"' || character == '\\') {
                result.append('\\').append(character);
            } else if (character < 0x20) {
                result.append("\\u");
                String hex = Integer.toHexString(character);
                result.append("0".repeat(4 - hex.length())).append(hex);
            } else {
                result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private static void progress(String stage) {
        BrowserMenu.report("{\"progress\":" + quote(stage) + "}");
    }

    private static int exceptionCount() throws Exception {
        var field = zombie.core.logger.ExceptionLogger.class.getDeclaredField("exceptionCount");
        field.setAccessible(true);
        return field.getInt(null);
    }

    private static void installRuntimeLogTransport() throws Exception {
        var stream = new java.io.PrintStream(new java.io.OutputStream() {
            private final java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream();
            @Override public void write(int value) {
                System.out.write(value);
                if (value == '\n') {
                    BrowserMenu.report("{\"progress\":\"original-runtime-log\",\"line\":"
                            + quote(line.toString(java.nio.charset.StandardCharsets.UTF_8)) + "}");
                    line.reset();
                } else line.write(value);
            }
        }, true, java.nio.charset.StandardCharsets.UTF_8);
        zombie.debug.DebugLog.getInstance().setStdOut(stream);
        zombie.debug.DebugLog.getInstance().setStdErr(stream);
        zombie.debug.DebugLog.setLogEnabled(zombie.debug.DebugType.General, true);
        zombie.debug.DebugType.General.setLogSeverity(zombie.debug.LogSeverity.Error);
        zombie.debug.DebugType.General.getLogStream().setLogSeverity(zombie.debug.LogSeverity.Error);
    }

    public void open(String root) throws Exception {
        progress("owned-browser-filesystem");
        logger.addHandler(errors);
        installRuntimeLogTransport();
        SqliteFiles.configure(root);
        Files.createDirectories(Path.of(root, "tmp"));
        Files.createDirectories(Path.of(root, "cache"));
        System.setProperty("org.sqlite.tmpdir", root + "/tmp");
        System.setProperty("org.sqlite.lib.path", "/app");
        System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
        zombie.ZomboidFileSystem.instance.setCacheDir(root + "/cache");
        zombie.util.PZSQLUtils.init();
        progress("original-jdbc-ready");
        // Same original -nosound browser component mode as the existing play profile.
        Core.soundDisabled = true;
        zombie.SoundManager.instance = new zombie.DummySoundManager();
        zombie.AmbientStreamManager.instance = new zombie.DummyAmbientStreamManager();
        zombie.audio.BaseSoundBank.instance = new zombie.audio.DummySoundBank();
        BrowserContentBootstrap.mountAssets();
        progress("mount-client-assets");
        BrowserContentBootstrap.mountClientAssets();
        BrowserFontBootstrap.mountAssets();
        progress("mount-animation-assets");
        BrowserModelBootstrap.mount();
        try (var zip = new ZipInputStream(Files.newInputStream(Path.of("/app/menu-assets.jar")))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (entry.isDirectory()) continue;
                Path work = Path.of("/files/work");
                Path target = work.resolve(entry.getName()).normalize();
                if (!target.startsWith(work.resolve("media"))) throw new IllegalArgumentException("Menu archive boundary");
                Files.createDirectories(target.getParent());
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        progress("original-lua-content");
        BrowserWorldBootstrap.initializeLua();
        for (String row : Files.readAllLines(Path.of("/app/menu-map-files.tsv"))) {
            String[] fields = row.split("\t");
            if (fields.length != 3 || !fields[0].matches("[a-f0-9]{64}") || !fields[2].startsWith("media/maps/")
                    || fields[2].contains("..") || fields[2].contains("\\")) throw new IllegalArgumentException("Map manifest boundary");
            zombie.ZomboidFileSystem.instance.activeFileMap.put(fields[2].toLowerCase(java.util.Locale.ENGLISH), "/app/" + fields[2]);
        }
        zombie.worldMap.WorldMapDataAssetManager.instance.create(zombie.worldMap.WorldMapData.ASSET_TYPE, GameWindow.assetManagers);
        BrowserContentBootstrap.loadDefinitions();
        BrowserModelBootstrap.initializeModels(BrowserMenuSession::progress);
        BrowserContentBootstrap.gameBoot();
        zombie.core.skinnedmodel.population.HairStyles.init();
        zombie.core.skinnedmodel.population.BeardStyles.init();
        GameWindow.fileSystem.mountTexturePack("UI2", GameWindow.texturePackTextures, 2);
        org.lwjglx.input.Keyboard.create();
        Core.getInstance().initGlobalShader();
        zombie.core.SpriteRenderer.instance.create();
        zombie.ui.UIManager.init();
        Object[] observer = LuaManager.thread.pcall(se.krka.kahlua.luaj.compiler.LuaCompiler.loadstring(
                "BrowserMenuTicks=0; Events.OnFETick.Add(function() BrowserMenuTicks=BrowserMenuTicks+1 end)", "browser-menu-observer", LuaManager.env), new Object[0]);
        if (!Boolean.TRUE.equals(observer[0])) throw new IllegalStateException("Front-end event observer failed");
        menu = new MainScreenState();
        if (!GameWindow.states.states.isEmpty() || GameWindow.states.current != null)
            throw new IllegalStateException("Expected unoccupied original state machine");
        GameWindow.states.forceNextState(menu);
        GameWindow.states.update();
        entered = true;
        progress("original-menu-entered");
    }

    public long ticks() {
        if (LuaManager.env == null) return 0;
        Object value = LuaManager.env.rawget("BrowserMenuTicks");
        return value instanceof Number number ? number.longValue() : 0;
    }

    private static KahluaTable instance(String name) {
        Object type = LuaManager.env.rawget(name);
        return type instanceof KahluaTable table && table.rawget("instance") instanceof KahluaTable value ? value : null;
    }

    private static String button(KahluaTable table, String name) {
        if (table != null && table.rawget(name) instanceof KahluaTable child
                && child.rawget("javaObject") instanceof UIElement element && element.isVisible()) {
            return "{\"x\":" + (element.getAbsoluteX() + element.getWidth() / 2)
                    + ",\"y\":" + (element.getAbsoluteY() + element.getHeight() / 2) + "}";
        }
        return "null";
    }

    private static String setup() {
        KahluaTable screen = instance("MapSpawnSelect");
        if (screen == null || !(screen.rawget("javaObject") instanceof UIElement element) || !element.isVisible()) return "null";
        if (!(screen.rawget("mapPanel") instanceof KahluaTable panel)
                || !(panel.rawget("javaObject") instanceof zombie.worldMap.UIWorldMap map))
            throw new IllegalStateException("Original spawn map panel missing");
        var data = map.getWorldMap();
        return "{\"screen\":\"MapSpawnSelect\",\"loaded\":" + map.getAPIv3().isDataLoaded()
                + ",\"data\":" + data.getDataCount() + ",\"images\":" + data.getImagesCount()
                + ",\"minX\":" + data.getMinXInCells() + ",\"minY\":" + data.getMinYInCells()
                + ",\"maxX\":" + data.getMaxXInCells() + ",\"maxY\":" + data.getMaxYInCells() + "}";
    }

    private static int thumbnailsReady(boolean visible) {
        if (!visible) return 0;
        int ready = 0;
        for (String name : new String[] {"Apocalypse", "Outbreak", "Rising", "Extinction", "Sandbox", "Challenges"}) {
            var texture = zombie.core.textures.Texture.getSharedTexture("media/ui/playstyleIcons/" + name + ".png");
            if (texture != null && texture.isFailure()) throw new IllegalStateException("Original mode thumbnail failed: " + name);
            if (texture != null && texture.isReady()) ready++;
        }
        return ready;
    }

    private static String modePanels(KahluaTable screen) {
        if (screen == null || !(screen.rawget("panels") instanceof KahluaTable panels)) return "[]";
        StringBuilder result = new StringBuilder("[");
        for (int index = 1; index <= panels.len(); index++) {
            if (!(panels.rawget(index) instanceof KahluaTable panel)
                    || !(panel.rawget("javaObject") instanceof UIElement element))
                throw new IllegalStateException("Original mode panel missing: " + index);
            if (index > 1) result.append(',');
            Object borderAlpha = panel.rawget("borderColor") instanceof KahluaTable border ? border.rawget("a") : null;
            result.append("{\"index\":").append(index)
                    .append(",\"title\":").append(quote(String.valueOf(panel.rawget("title"))))
                    .append(",\"visible\":").append(element.isVisible())
                    .append(",\"x\":").append(element.getAbsoluteX())
                    .append(",\"y\":").append(element.getAbsoluteY())
                    .append(",\"width\":").append(element.getWidth())
                    .append(",\"height\":").append(element.getHeight())
                    .append(",\"selected\":").append(Boolean.TRUE.equals(panel.rawget("selected")))
                    .append(",\"mouseOver\":").append(Boolean.TRUE.equals(panel.rawget("mouseOver")))
                    .append(",\"alpha\":").append(quote(String.valueOf(panel.rawget("alpha"))))
                    .append(",\"borderAlpha\":").append(quote(String.valueOf(borderAlpha)))
                    .append('}');
        }
        return result.append(']').toString();
    }

    public void step() throws Exception {
        // Do not execute an unqualified new loading/world closure from this component.
        if (GameWindow.states.forceNext != null && GameWindow.states.forceNext != menu)
            throw new UnsupportedOperationException("Original loading state requires world/save service qualification");
        BrowserMouse.poll();
        BrowserKeyboardEvents.poll();
        zombie.input.Mouse.poll();
        zombie.input.Mouse.update();
        zombie.input.GameKeyboard.poll();
        zombie.input.GameKeyboard.update();
        GameWindow.GameInput.updateGameThread();
        Core.getInstance().DoFrameReady();
        zombie.worldMap.WorldMapImages.checkLoadingQueue();
        GameWindow.fileSystem.updateAsyncTransactions();
        zombie.ui.UIManager.update();
        // A final original UI callback can request LoadingQueueState in this same frame.
        // Check again before the original state machine can enter that new closure.
        if (GameWindow.states.forceNext != null && GameWindow.states.forceNext != menu)
            throw new UnsupportedOperationException("Original loading state requires world/save service qualification");
        GameWindow.states.update();
        zombie.core.SpriteRenderer.instance.NewFrame();
        GameWindow.states.render();
        if (!luaErrors.isEmpty()) throw new IllegalStateException("Original menu Lua error: " + luaErrors.get(0));
        int originalExceptions = exceptionCount();
        if (originalExceptions != 0) throw new IllegalStateException("Original menu logged exceptions: " + originalExceptions);
        int error = org.lwjgl.opengl.GL11.glGetError();
        if (error != 0) throw new IllegalStateException("Original menu GL error " + error);
        frames++;
        KahluaTable main = instance("MainScreen");
        KahluaTable next = instance("NewGameScreen");
        boolean newGame = next != null && next.rawget("javaObject") instanceof UIElement element && element.isVisible();
        BrowserMenu.report("{\"snapshot\":true,\"frames\":" + frames + ",\"frontEndTicks\":" + ticks()
                + ",\"originalExceptions\":" + originalExceptions
                + ",\"mouseDown\":" + zombie.input.Mouse.isLeftDown()
                + ",\"mouseX\":" + zombie.input.Mouse.getX() + ",\"mouseY\":" + zombie.input.Mouse.getY()
                + ",\"solo\":" + button(main, "survivalOption") + ",\"next\":" + button(next, "nextButton")
                + ",\"newGameVisible\":" + newGame + ",\"thumbnailsReady\":" + thumbnailsReady(newGame)
                + ",\"modePanels\":" + modePanels(next)
                + ",\"setup\":" + setup() + "}");
    }

    @Override
    public void close() throws Exception {
        Throwable failure = null;
        try {
            if (entered) menu.exit();
        } catch (Throwable error) { failure = error; }
        try {
            var singleton = zombie.savefile.AccountDBHelper.class.getDeclaredField("instance");
            singleton.setAccessible(true);
            Object account = singleton.get(null);
            if (account != null) {
                var connection = zombie.savefile.AccountDBHelper.class.getDeclaredField("conn");
                connection.setAccessible(true);
                java.sql.Connection db = (java.sql.Connection) connection.get(account);
                if (db != null) db.close();
            }
            if (SqliteSupport.identities() != 0 || SqliteSupport.pendingFailures() != 0)
                throw new IllegalStateException("Owned menu SQLite handles remain");
        } catch (Throwable error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        try { BrowserFontBootstrap.close(); }
        catch (Throwable error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        try {
            var field = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");
            field.setAccessible(true);
            var executor = (ExecutorService) field.get(GameWindow.fileSystem);
            executor.shutdown();
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Asset executor did not stop");
        } catch (Throwable error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        logger.removeHandler(errors);
        if (!luaErrors.isEmpty() && failure == null) failure = new IllegalStateException("Original menu Lua errors: " + luaErrors.size());
        if (failure != null) throw new Exception("Original menu cleanup failed", failure);
    }
}
