package zombie;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import se.krka.kahlua.vm.JavaFunction;
import se.krka.kahlua.vm.LuaClosure;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import zombie.Lua.Event;
import zombie.Lua.LuaEventManager;
import zombie.Lua.LuaManager;
import zombie.core.Core;
import zombie.core.SpriteRenderer;
import zombie.core.opengl.RenderThread;
import zombie.gameStates.MainScreenState;

/** Original startup entry and read-only lifecycle, frontend and loading observations. */
public final class BrowserOriginalBoot {
    private static long uiQueued;
    private static volatile long mainMenuConsumed;
    private static volatile long appearanceConsumed;
    private static volatile Throwable renderFailure;
    private static JavaFunction uiObserver;
    private static LuaClosure uiObserverClosure;
    private static se.krka.kahlua.vm.KahluaTable termsButtonObserved;
    private static final java.util.Map<String, se.krka.kahlua.vm.KahluaTable> frontendControls = new java.util.HashMap<>();
    private static String lastState;
    private static Path ownedRoot;
    private static String lastLoading;
    private static long loadingSequence;
    private static int avatarObservationFrames;
    private static long lastResourceObservation;
    public static native void report(String json);
    public static native boolean stopRequested();

    public static void main(String[] args) {
        try {
            if (args.length != 1) throw new IllegalArgumentException("Owned root required");
            Path root = Path.of(args[0]);
            ownedRoot = root.toAbsolutePath().normalize();
            port.host.SqliteFiles.configure(root.toString());
            Files.createDirectories(root.resolve("cache"));
            Files.createDirectories(root.resolve("tmp"));
            System.setProperty("org.sqlite.tmpdir", root.resolve("tmp").toString());
            System.setProperty("org.sqlite.lib.path", "/app");
            System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
            if (!"/app".equals(System.getProperty("user.dir"))
                    || !root.toString().equals(System.getProperty("user.home")))
                throw new IllegalStateException("Fresh read-only media and owned writable home required");
            System.setProperty("zomboid.steam", "0");
            Core.soundDisabled = true;
            ZomboidFileSystem.instance.setCacheDir(root.resolve("cache").toString());
            zombie.debug.DebugLog.getInstance().setStdOut(System.out);
            zombie.debug.DebugLog.getInstance().setStdErr(System.err);
            zombie.core.random.RandStandard.INSTANCE.init();
            zombie.core.random.RandLua.INSTANCE.init();
            org.lwjglx.opengl.Display.init();
            if (System.getProperty("lokiUrl") != null)
                throw new IllegalStateException("Original remote logging branch is outside this offline admission");
            zombie.debug.DebugLog.getInstance().init();
            zombie.core.logger.LoggerManager.init();
            Core.getInstance().saveOptions();
            new BrowserLifecycleController(root, 30000,
                    text -> report("{\"ownerEvent\":" + quote(text) + "}")).run();
            throw new IllegalStateException("Original owner loop unexpectedly returned");
        } catch (Throwable failure) {
            failure.printStackTrace();
            java.io.StringWriter trace = new java.io.StringWriter();
            failure.printStackTrace(new java.io.PrintWriter(trace));
            report("{\"javaFailed\":true,\"error\":" + quote(trace.toString()) + "}");
        }
    }

    /** Observes original post-UI rendering; does not invoke UI/game frame methods itself. */
    static void bootReady() {
        if (Thread.currentThread() != GameWindow.gameThread || uiObserver != null)
            throw new IllegalStateException("Original owner and one observer required");
        uiObserver = (frame, args) -> {
            if (Thread.currentThread() != GameWindow.gameThread)
                throw new IllegalStateException("Original UI producer required");
            String state = state();
            long sequence = ++uiQueued;
            reportTermsControl(sequence);
            boolean appearanceVisible = reportFrontend(sequence);
            SpriteRenderer.instance.drawGeneric(new zombie.core.textures.TextureDraw.GenericDrawer() {
                @Override public void render() {
                    try {
                        if (Thread.currentThread() != RenderThread.renderThread)
                            throw new IllegalStateException("Actual original render consumer required");
                        int error = org.lwjgl.opengl.GL11.glGetError();
                        if (error != 0) throw new IllegalStateException("Original UI render GL error: " + error);
                        if (state.equals(MainScreenState.class.getName())) mainMenuConsumed++;
                        if (appearanceVisible) appearanceConsumed++;
                        report("{\"originalUiConsumed\":" + sequence + ",\"producerState\":" + quote(state)
                                + ",\"mainMenuConsumed\":" + mainMenuConsumed + ",\"appearanceVisible\":" + appearanceVisible
                                + ",\"appearanceConsumed\":" + appearanceConsumed + ",\"glError\":" + error + "}");
                    } catch (Throwable failure) {
                        renderFailure = failure;
                        failure.printStackTrace();
                        report("{\"renderFailed\":true,\"error\":" + quote(failure.toString()) + "}");
                        if (failure instanceof RuntimeException runtime) throw runtime;
                        if (failure instanceof Error error) throw error;
                        throw new IllegalStateException(failure);
                    }
                }
            });
            return 0;
        };
        LuaManager.env.rawset("BrowserBootPostUIObserver", uiObserver);
        if (LuaCompiler.rewriteEvents)
            throw new IllegalStateException("Original event rewrite mode would suppress observer registration");
        Event event = originalPostUiEvent();
        int before = event.callbacks.size();
        uiObserverClosure = createObserverClosure();
        if (event.callbacks.stream().anyMatch(callback -> callback == uiObserverClosure))
            throw new IllegalStateException("Observer closure was already registered");
        LuaManager.env.rawset("BrowserBootPostUIClosure", uiObserverClosure);
        lua("Events.OnPostUIDraw.Add(BrowserBootPostUIClosure)");
        if (event.callbacks.size() != before + 1
                || event.callbacks.stream().filter(callback -> callback == uiObserverClosure).count() != 1)
            throw new IllegalStateException("Original event did not retain exactly the owned Lua closure");
        report("{\"originalUiObserverRegistered\":true,\"callbacksBefore\":" + before
                + ",\"callbacksAfter\":" + event.callbacks.size() + ",\"exactClosurePresent\":true}");
        report("{\"originalBootReady\":true,\"registeredStates\":" + GameWindow.states.states.size()
                + ",\"texturePacks\":" + GameWindow.texturePacks.size() + "}");
    }

    static void observeState() {
        if (GameWindow.gameThread != Thread.currentThread()) throw new IllegalStateException("Actual owner required");
        if (renderFailure != null) throw new IllegalStateException("Original UI consumer failed", renderFailure);
        long now = System.nanoTime();
        if (lastResourceObservation == 0 || now - lastResourceObservation >= 5_000_000_000L) {
            lastResourceObservation = now;
            report("{\"resourceTelemetry\":{\"observedAt\":" + System.currentTimeMillis()
                    + ",\"directBuffers\":" + ownedDirectBuffers() + "}}");
        }
        observeLoading();
        String current = state();
        if (!current.equals(lastState)) {
            lastState = current;
            report("{\"originalState\":" + quote(current) + "}");
        }
    }

    /** Scanned only by the original observation producer at the bounded resource cadence. */
    private static String ownedDirectBuffers() {
        long[] allocation = port.host.SpriteGraphics.allocationSnapshot();
        return "{\"count\":" + allocation[0] + ",\"capacityBytes\":" + allocation[1] + "}";
    }

    /** Reads intended writable paths and existing ancestors; creates no directories. */
    static String ownedPaths() {
        try {
            if (Thread.currentThread() != GameWindow.gameThread)
                throw new IllegalStateException("Path observations require original game owner");
            if (!ownedRoot.toString().equals(System.getProperty("user.home")) || Core.getInstance().isNoSave()
                    || zombie.network.GameClient.client || zombie.network.GameServer.server)
                throw new IllegalStateException("Owned offline saving context changed");
            String cache = contained(ZomboidFileSystem.instance.getCacheDir());
            // Original getSaveDir ensures a directory and getGameModeCacheDir can set Sandbox.
            // Read the same original fields/path expression without invoking either mutator.
            String saves = contained(Path.of(cache, "Saves").toString());
            String current = Core.gameMode == null || Core.gameSaveWorld == null ? null
                    : contained(Path.of(saves, Core.gameMode, Core.gameSaveWorld).toString());
            String tmp = contained(System.getProperty("org.sqlite.tmpdir"));
            return "{\"valid\":true,\"root\":" + quote(ownedRoot.toString()) + ",\"cache\":" + quote(cache)
                    + ",\"saves\":" + quote(saves) + ",\"current\":" + (current == null ? "null" : quote(current)) + ",\"tmp\":" + quote(tmp)
                    + ",\"gameMode\":" + (Core.gameMode == null ? "null" : quote(Core.gameMode)) + ",\"noSave\":false}";
        } catch (java.io.IOException error) { throw new IllegalStateException("Owned path observation failed", error); }
    }

    private static String contained(String value) throws java.io.IOException {
        if (value == null) throw new IllegalStateException("Missing original writable path");
        Path intended = Path.of(value).toAbsolutePath().normalize();
        if (!intended.startsWith(ownedRoot) || intended.equals(ownedRoot))
            throw new IllegalStateException("Original writable path escapes owned root: " + intended);
        Path ancestor = intended;
        while (!Files.exists(ancestor)) {
            ancestor = ancestor.getParent();
            if (ancestor == null) throw new IllegalStateException("Writable path has no existing ancestor");
        }
        if (!ancestor.toRealPath().startsWith(ownedRoot.toRealPath()))
            throw new IllegalStateException("Original writable ancestor escapes owned root: " + ancestor);
        return intended.toString();
    }

    /** Original loading flags are read only; Thread state is informational, never readiness. */
    private static void observeLoading() {
        Object current = GameWindow.states.current;
        if (!(current instanceof zombie.gameStates.GameLoadingState)) return;
        try {
            Class<?> type = zombie.gameStates.GameLoadingState.class;
            boolean done = loadingBoolean(type, "done");
            boolean shown = loadingBoolean(type, "showedClickToSkip");
            boolean error = loadingBoolean(type, "unexpectedError");
            Thread loader = zombie.gameStates.GameLoadingState.loader;
            Boolean busy = done ? zombie.iso.WorldStreamer.instance.isBusy() : null;
            Boolean animations = Boolean.FALSE.equals(busy)
                    ? zombie.core.skinnedmodel.ModelManager.instance.isLoadingAnimations() : null;
            boolean ready = done && shown && !error && Boolean.FALSE.equals(busy) && Boolean.FALSE.equals(animations);
            String json = "{\"loadingWitness\":true,\"state\":" + quote(state()) + ",\"done\":" + done
                    + ",\"showedClickToSkip\":" + shown + ",\"unexpectedError\":" + error
                    + ",\"worldStreamerBusy\":" + busy + ",\"animationsLoading\":" + animations
                    + ",\"readyForPhysicalClick\":" + ready + ",\"loaderPresent\":" + (loader != null)
                    + ",\"loaderAlive\":" + (loader != null && loader.isAlive())
                    + ",\"loaderIdentity\":" + (loader == null ? 0 : System.identityHashCode(loader))
                    + ",\"threadStateInformational\":" + (loader == null ? "null" : quote(loader.getState().toString()))
                    + ",\"currentCellPresent\":" + (zombie.iso.IsoWorld.instance.currentCell != null)
                    + ",\"leftDown\":" + zombie.input.Mouse.isButtonDown(0)
                    + ",\"okToSaveOnExit\":" + GameWindow.okToSaveOnExit + ",\"ownedPaths\":" + ownedPaths() + "}";
            if (!json.equals(lastLoading)) {
                lastLoading = json;
                report(json.substring(0, json.length() - 1) + ",\"loadingSequence\":" + (++loadingSequence) + "}");
            }
        } catch (ReflectiveOperationException error) { throw new IllegalStateException("Original loading observation failed", error); }
    }

    private static boolean loadingBoolean(Class<?> type, String name) throws ReflectiveOperationException {
        var field = type.getDeclaredField(name);
        if (field.getType() != boolean.class || !java.lang.reflect.Modifier.isStatic(field.getModifiers()))
            throw new IllegalStateException("Unexpected original loading field: " + name);
        field.setAccessible(true);
        return field.getBoolean(null);
    }

    static void finishJava() throws Exception {
        observeState();
        if (mainMenuConsumed == 0) throw new IllegalStateException("No original initial menu UI was consumed");
        if (uiObserver != null) {
            if (LuaCompiler.rewriteEvents)
                throw new IllegalStateException("Original event rewrite mode would suppress observer removal");
            Event event = originalPostUiEvent();
            int before = event.callbacks.size();
            if (uiObserverClosure == null
                    || event.callbacks.stream().filter(callback -> callback == uiObserverClosure).count() != 1
                    || LuaManager.env.rawget("BrowserBootPostUIClosure") != uiObserverClosure
                    || LuaManager.env.rawget("BrowserBootPostUIObserver") != uiObserver)
                throw new IllegalStateException("Original observer closure or bridge ownership changed");
            lua("Events.OnPostUIDraw.Remove(BrowserBootPostUIClosure)");
            if (event.callbacks.size() != before - 1
                    || event.callbacks.stream().anyMatch(callback -> callback == uiObserverClosure))
                throw new IllegalStateException("Original event did not remove exactly the owned Lua closure");
            report("{\"originalUiObserverRemoved\":true,\"callbacksBefore\":" + before
                    + ",\"callbacksAfter\":" + event.callbacks.size() + ",\"exactClosureAbsent\":true}");
            LuaManager.env.rawset("BrowserBootPostUIClosure", null);
            uiObserverClosure = null;
            LuaManager.env.rawset("BrowserBootPostUIObserver", null);
            uiObserver = null;
            frontendControls.clear();
        }
        long deadline = System.currentTimeMillis() + 30000;
        observeAssetDrain("start");
        try {
            while (GameWindow.fileSystem.hasWork() && System.currentTimeMillis() < deadline) {
                GameWindow.fileSystem.updateAsyncTransactions();
                SpriteRenderer.instance.notifyRenderStateQueue();
                Thread.sleep(1);
            }
            if (GameWindow.fileSystem.hasWork()) throw new IllegalStateException("Original async work remains");
        } finally {
            observeAssetDrain("end");
        }
        RenderThread.invokeOnRenderContext(() -> {});
        var field = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");
        field.setAccessible(true);
        ExecutorService executor = (ExecutorService) field.get(GameWindow.fileSystem);
        if (executor.isShutdown()) throw new IllegalStateException("Asset executor closed before original render shutdown");
        observeState();
        var count = zombie.core.logger.ExceptionLogger.class.getDeclaredField("exceptionCount");
        count.setAccessible(true);
        int actualExceptions = count.getInt(null);
        if (actualExceptions != 0) throw new IllegalStateException("Original exception count changed: " + actualExceptions);
        report("{\"javaBoundaryCompleted\":true,\"mainMenuConsumed\":" + mainMenuConsumed
                + ",\"exceptionCount\":" + actualExceptions
                + ",\"assetExecutorShutdownBeforeRenderShutdown\":" + executor.isShutdown()
                + ",\"assetWorkBeforeRenderShutdown\":" + GameWindow.fileSystem.hasWork()
                + ",\"assetExecutorLifetime\":\"original-VM-exit\",\"originalFullShutdownQualified\":false}");
    }

    /** Two owner-thread snapshots only; never polls, consumes a future, or changes a queue. */
    private static void observeAssetDrain(String phase) {
        try {
            if (Thread.currentThread() != GameWindow.gameThread)
                throw new IllegalStateException("Asset snapshot requires actual game owner");
            Object fs = GameWindow.fileSystem;
            var pendingField = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("pending");
            var progressField = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("inProgress");
            var executorField = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");
            if (pendingField.getType() != java.util.ArrayList.class || progressField.getType() != java.util.ArrayList.class
                    || executorField.getType() != ExecutorService.class)
                throw new IllegalStateException("Unexpected original filesystem observation descriptors");
            pendingField.setAccessible(true);
            progressField.setAccessible(true);
            executorField.setAccessible(true);
            var executor = (ExecutorService) executorField.get(fs);
            report("{\"assetDrainSnapshot\":" + quote(phase)
                    + ",\"pending\":" + queueSnapshot((java.util.ArrayList<?>) pendingField.get(fs))
                    + ",\"inProgress\":" + queueSnapshot((java.util.ArrayList<?>) progressField.get(fs))
                    + ",\"executorShutdown\":" + executor.isShutdown()
                    + ",\"executorTerminated\":" + executor.isTerminated()
                    + ",\"addedQueueObserved\":false}");
        } catch (Throwable observationFailure) {
            try { report("{\"assetDrainObservationFailed\":true,\"error\":" + quote(observationFailure.toString()) + "}"); }
            catch (Throwable reportFailure) {
                // Diagnostics must not replace a primary original drain error or its transport.
                try { System.err.println("ERROR: asset drain observation/report failed: " + observationFailure + "; " + reportFailure); }
                catch (Throwable ignored) { }
            }
        }
    }

    private static String queueSnapshot(java.util.ArrayList<?> queue) throws Exception {
        var counts = new java.util.LinkedHashMap<String, Integer>();
        var samples = new java.util.ArrayList<String>();
        int done = 0;
        java.lang.reflect.Field taskField = null, futureField = null;
        for (Object item : queue) {
            if (!item.getClass().getName().equals("zombie.fileSystem.FileSystemImpl$AsyncItem"))
                throw new IllegalStateException("Unexpected original async item");
            if (taskField == null) {
                taskField = item.getClass().getDeclaredField("task");
                futureField = item.getClass().getDeclaredField("future");
                if (taskField.getType() != zombie.fileSystem.FileTask.class
                        || futureField.getType() != java.util.concurrent.FutureTask.class)
                    throw new IllegalStateException("Unexpected original async item descriptors");
                taskField.setAccessible(true);
                futureField.setAccessible(true);
            }
            Object task = taskField.get(item);
            var future = (java.util.concurrent.FutureTask<?>) futureField.get(item);
            if (future != null && future.isDone()) done++;
            String type = task == null ? "null" : task.getClass().getName();
            counts.merge(type, 1, Integer::sum);
            if (samples.size() < 4) {
                String name = null;
                // These exact inspected implementations only read the existing asset path/string.
                if (task != null && task.getClass() == zombie.core.skinnedmodel.model.FileTask_LoadAnimation.class)
                    name = ((zombie.core.skinnedmodel.model.FileTask_LoadAnimation) task).getRawFileName();
                if (task != null && task.getClass() == zombie.core.skinnedmodel.model.FileTask_LoadMesh.class)
                    name = ((zombie.core.skinnedmodel.model.FileTask_LoadMesh) task).getRawFileName();
                if (task != null && task.getClass() == zombie.asset.FileTask_LoadImageData.class)
                    name = ((zombie.asset.FileTask_LoadImageData) task).getErrorMessage();
                boolean truncated = name != null && name.length() > 256;
                if (truncated) name = name.substring(0, 256);
                samples.add("{\"type\":" + quote(type) + ",\"file\":" + (name == null ? "null" : quote(name))
                        + ",\"fileTruncated\":" + truncated + "}");
            }
        }
        var types = new java.util.ArrayList<String>();
        counts.forEach((name, count) -> types.add(quote(name) + ":" + count));
        return "{\"size\":" + queue.size() + ",\"futureDone\":" + done
                + ",\"types\":{" + String.join(",", types) + "},\"samples\":[" + String.join(",", samples) + "]}";
    }

    private static String state() {
        return GameWindow.states.current == null ? "none" : GameWindow.states.current.getClass().getName();
    }

    /** Reads the real original Lua control and Java bounds; never invokes its action or changes acceptance. */
    private static void reportTermsControl(long sequence) {
        Object type = LuaManager.env.rawget("ISTermsOfServiceUI");
        Object instance = type instanceof se.krka.kahlua.vm.KahluaTable table ? table.rawget("instance") : null;
        Object panel = instance instanceof se.krka.kahlua.vm.KahluaTable table ? table.rawget("javaObject") : null;
        boolean visible = panel instanceof zombie.ui.UIElement element && element.isReallyVisible();
        if (!visible) {
            report("{\"termsControl\":true,\"sequence\":" + sequence + ",\"visible\":false}");
            return;
        }
        Object button = ((se.krka.kahlua.vm.KahluaTable) instance).rawget("buttonAccept");
        if (!(button instanceof se.krka.kahlua.vm.KahluaTable table)
                || !(table.rawget("javaObject") instanceof zombie.ui.UIElement element))
            throw new IllegalStateException("Original visible terms panel lacks actual accept control");
        if (termsButtonObserved == null) termsButtonObserved = table;
        if (termsButtonObserved != table) throw new IllegalStateException("Original observed terms button identity changed");
        report("{\"termsControl\":true,\"sequence\":" + sequence
                + ",\"identity\":\"ISTermsOfServiceUI.instance.buttonAccept\",\"visible\":" + element.isReallyVisible()
                + ",\"enabled\":" + Boolean.TRUE.equals(table.rawget("enable"))
                + ",\"buttonIdentity\":" + System.identityHashCode(termsButtonObserved)
                + ",\"buttonPressed\":" + Boolean.TRUE.equals(table.rawget("pressed"))
                + ",\"mouseX\":" + zombie.input.Mouse.getXA() + ",\"mouseY\":" + zombie.input.Mouse.getYA()
                + ",\"leftDown\":" + zombie.input.Mouse.isLeftDown()
                + ",\"x\":" + element.getAbsoluteX() + ",\"y\":" + element.getAbsoluteY()
                + ",\"width\":" + element.getWidth() + ",\"height\":" + element.getHeight()
                + ",\"screenWidth\":" + Core.getInstance().getScreenWidth()
                + ",\"screenHeight\":" + Core.getInstance().getScreenHeight() + "}");
    }

    /** Reads existing frontend tables after original UI work; never invokes their handlers. */
    private static boolean reportFrontend(long sequence) {
        Object mainClass = LuaManager.env.rawget("MainScreen");
        if (!(mainClass instanceof se.krka.kahlua.vm.KahluaTable klass)
                || !(klass.rawget("instance") instanceof se.krka.kahlua.vm.KahluaTable main)) return false;
        StringBuilder controls = new StringBuilder();
        frontendControl(controls, main, "survivalOption", "solo", false);
        String[][] panels = {{"soloScreen", "mode", "nextButton"},
                {"worldSelect", "world", "nextButton"}, {"mapSpawnSelect", "spawn", "nextButton"},
                {"charCreationProfession", "profession", "playButton"},
                {"charCreationMain", "appearance", "playButton"}};
        for (String[] path : panels) {
            if (main.rawget(path[0]) instanceof se.krka.kahlua.vm.KahluaTable panel)
                frontendControl(controls, panel, path[2], path[1], true);
        }
        String prospective = "null";
        if (Core.gameMode != null && main.rawget("mapSpawnSelect") instanceof se.krka.kahlua.vm.KahluaTable spawnName
                && spawnName.rawget("javaObject") instanceof zombie.ui.UIElement spawnElement && spawnElement.isReallyVisible()
                && spawnName.rawget("textEntry") instanceof se.krka.kahlua.vm.KahluaTable entry
                && entry.rawget("javaObject") instanceof zombie.ui.UITextBox2 text) {
            String name = LuaManager.GlobalObject.sanitizeWorldName(text.getText());
            if (!name.isEmpty() && !name.equals(".") && !name.equals("..")) {
                try {
                    String target = contained(Path.of(ZomboidFileSystem.instance.getCacheDir(), "Saves", java.util.Objects.requireNonNull(Core.gameMode, "Original game mode"), name).toString());
                    prospective = "{\"name\":" + quote(name) + ",\"path\":" + quote(target)
                            + ",\"exists\":" + Files.exists(Path.of(target)) + "}";
                } catch (java.io.IOException error) { throw new IllegalStateException("Prospective owned path failed", error); }
            }
        }
        String preview = "null";
        if (main.rawget("mapSpawnSelect") instanceof se.krka.kahlua.vm.KahluaTable spawn
                && spawn.rawget("mapPanel") instanceof se.krka.kahlua.vm.KahluaTable map) {
            Object pyramid = map.rawget("pyramidFileName");
            preview = "{\"pyramidFileName\":" + (pyramid == null ? "null" : quote(pyramid.toString()))
                    + ",\"hasResetView\":" + Boolean.TRUE.equals(map.rawget("hasResetView")) + "}";
        }
        Object mode = null;
        if (main.rawget("soloScreen") instanceof se.krka.kahlua.vm.KahluaTable solo
                && solo.rawget("selectedItem") instanceof se.krka.kahlua.vm.KahluaTable item
                && item.rawget("data") instanceof se.krka.kahlua.vm.KahluaTable data) mode = data.rawget("mode");
        report("{\"frontend\":true,\"ownedPaths\":" + ownedPaths() + ",\"sequence\":" + sequence + ",\"controls\":[" + controls
                + "],\"mouseX\":" + zombie.input.Mouse.getXA() + ",\"mouseY\":" + zombie.input.Mouse.getYA()
                + ",\"leftDown\":" + zombie.input.Mouse.isLeftDown() + ",\"spawnPreview\":" + preview
                + ",\"prospectiveSave\":" + prospective
                + ",\"selectedMode\":" + (mode == null ? "null" : quote(mode.toString())) + "}");
        boolean appearanceVisible = main.rawget("charCreationMain") instanceof se.krka.kahlua.vm.KahluaTable appearance
                && appearance.rawget("javaObject") instanceof zombie.ui.UIElement panel && panel.isReallyVisible();
        if (appearanceVisible) {
            int observation = ++avatarObservationFrames;
            if (observation == 1 || observation == 60 || observation == 180) {
                var appearance = (se.krka.kahlua.vm.KahluaTable) main.rawget("charCreationMain");
                if (!(appearance.rawget("avatarPanel") instanceof se.krka.kahlua.vm.KahluaTable avatar)
                        || !(avatar.rawget("avatarPanel") instanceof se.krka.kahlua.vm.KahluaTable model)
                        || !(model.rawget("javaObject") instanceof zombie.ui.UI3DModel previewModel))
                    throw new IllegalStateException("Original appearance preview is absent");
                try {
                    report("{\"avatarDiagnostic\":true,\"sequence\":" + sequence + ",\"snapshot\":"
                            + quote(port.host.BrowserAvatarDiagnostics.snapshot(previewModel)) + "}");
                } catch (ReflectiveOperationException error) { throw new IllegalStateException("Original avatar observation failed", error); }
            }
        }
        return appearanceVisible;
    }

    private static void frontendControl(StringBuilder out, se.krka.kahlua.vm.KahluaTable owner,
            String field, String id, boolean button) {
        if (!(owner.rawget(field) instanceof se.krka.kahlua.vm.KahluaTable table)
                || !(table.rawget("javaObject") instanceof zombie.ui.UIElement element)
                || !element.isReallyVisible()) return;
        if (frontendControls.putIfAbsent(id, table) != null && frontendControls.get(id) != table)
            throw new IllegalStateException("Original frontend control was replaced: " + id);
        if (out.length() != 0) out.append(',');
        out.append("{\"id\":").append(quote(id)).append(",\"identity\":").append(System.identityHashCode(table))
                .append(",\"button\":").append(button).append(",\"enabled\":")
                .append(!button || Boolean.TRUE.equals(table.rawget("enable")))
                .append(",\"pressed\":").append(Boolean.TRUE.equals(table.rawget("pressed")))
                .append(",\"x\":").append(element.getAbsoluteX()).append(",\"y\":").append(element.getAbsoluteY())
                .append(",\"width\":").append(element.getWidth()).append(",\"height\":").append(element.getHeight())
                .append(",\"screenWidth\":").append(Core.getInstance().getScreenWidth())
                .append(",\"screenHeight\":").append(Core.getInstance().getScreenHeight()).append('}');
    }

    /** Reads the existing original registry; never creates an event or changes its callbacks. */
    private static Event originalPostUiEvent() {
        try {
            var field = LuaEventManager.class.getDeclaredField("EventMap");
            field.setAccessible(true);
            Object value = ((java.util.Map<?, ?>) field.get(null)).get("OnPostUIDraw");
            if (!(value instanceof Event event))
                throw new IllegalStateException("Original post-UI event is absent");
            return event;
        } catch (ReflectiveOperationException failure) { throw new IllegalStateException(failure); }
    }

    /** Creates an actual Lua closure; registering the JavaFunction itself is silently ignored. */
    private static LuaClosure createObserverClosure() {
        try {
            LuaClosure factory = LuaCompiler.loadstring("return function() BrowserBootPostUIObserver() end",
                    "browser-boot-post-ui-closure", LuaManager.env);
            Object[] result = LuaManager.thread.pcall(factory, new Object[0]);
            if (result.length < 2 || !Boolean.TRUE.equals(result[0]) || !(result[1] instanceof LuaClosure closure))
                throw new IllegalStateException("Observer factory did not return an actual Lua closure");
            return closure;
        } catch (java.io.IOException failure) { throw new IllegalStateException(failure); }
    }

    private static void lua(String source) {
        try {
            var closure = se.krka.kahlua.luaj.compiler.LuaCompiler.loadstring(source, "browser-boot-observer", LuaManager.env);
            Object[] values = LuaManager.thread.pcall(closure, new Object[0]);
            if (!Boolean.TRUE.equals(values[0])) throw new IllegalStateException("Original observer registration/removal failed");
        } catch (java.io.IOException failure) { throw new IllegalStateException(failure); }
    }

    /** Captures the actual owner throwable before original uncaught handling can exit the VM. */
    static void reportFailure(Throwable failure) {
        java.io.StringWriter trace = new java.io.StringWriter();
        failure.printStackTrace(new java.io.PrintWriter(trace));
        report("{\"javaFailed\":true,\"error\":" + quote(trace.toString()) + "}");
    }

    private static String quote(String text) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            if (value == '"' || value == '\\') result.append('\\').append(value);
            else if (value < 32) result.append(String.format("\\u%04x", (int) value));
            else result.append(value);
        }
        return result.append('"').toString();
    }
}
