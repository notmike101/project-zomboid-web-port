package zombie;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.function.Consumer;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import zombie.Lua.LuaManager;
import zombie.core.opengl.RenderThread;
import zombie.gameStates.GameLoadingState;

/** Owns the original browser lifecycle and observes its real producer and render owners. */
public final class BrowserLifecycleController {
    private final Path root;
    private final long closeBoundNanos;
    private final Consumer<String> report;
    private final BrowserLifecycleBoot boot = new BrowserLifecycleBoot();
    private final CountDownLatch published = new CountDownLatch(1);
    private final Field caught = field(zombie.core.logger.ExceptionLogger.class, "exceptionCount", int.class);
    private final Field loadingError = field(GameLoadingState.class, "unexpectedError", boolean.class);
    private volatile Throwable failure;
    private volatile long closeRequestedAt;
    private Thread actualOwner;
    private int initialExceptions;
    private final Logger luaLogger = Logger.getLogger(LuaManager.class.getName());
    private final Handler luaErrors = new Handler() {
        @Override public void publish(LogRecord record) {
            if (record.getLevel().intValue() >= Level.SEVERE.intValue())
                fail(new IllegalStateException("Original Lua failure: " + record.getMessage()));
        }
        @Override public void flush() { }
        @Override public void close() { }
    };

    public BrowserLifecycleController(Path ownedRoot, long closeBoundMillis, Consumer<String> output) {
        if (closeBoundMillis <= 0 || closeBoundMillis > 60000 || output == null)
            throw new IllegalArgumentException("Owned root, output and 1..60000 ms close bound required");
        root = ownedRoot.toAbsolutePath().normalize();
        closeBoundNanos = closeBoundMillis * 1_000_000L;
        report = output;
    }

    /** Host bookkeeping only; original close is deferred until the actual loader terminates. */
    public synchronized void requestClose() {
        if (closeRequestedAt == 0) closeRequestedAt = System.nanoTime();
    }

    /** All mounts, native services, persisted options and watch transport must exist before entry. */
    public void run() throws Exception {
        Path canonicalRoot = root.toRealPath();
        Path cache = Path.of(ZomboidFileSystem.instance.getCacheDir()).toRealPath();
        require(canonicalRoot.equals(root) && cache.startsWith(root) && !cache.equals(root),
                "Canonical owned cache must precede display/options initialization");
        require(GameWindow.gameThread == null && MainThread.mainThread == null,
                "Fresh original owners required");
        initialExceptions = caught.getInt(null);
        require(initialExceptions == 0 && !loadingError.getBoolean(null), "Fresh error-free VM required");
        luaLogger.addHandler(luaErrors);
        Thread.UncaughtExceptionHandler oldGlobal = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            fail(error);
            GameWindow.uncaughtException(thread, error);
        });
        try {
            RenderThread.init();
            registerOriginalAssetManagers();
            actualOwner = MainThread.init(
                    () -> callback(() -> { published.await(); boot.start(root); BrowserOriginalBoot.bootReady(); }),
                    () -> callback(this::step),
                    () -> callback(this::exit),
                    this::uncaught);
            try {
                require(actualOwner != null && actualOwner == MainThread.mainThread,
                        "Original producer must return its real owner");
                GameWindow.gameThread = actualOwner;
            } finally { published.countDown(); }
            report.accept("actual-original-main-owner-published");
            Thread joiner = new Thread(() -> {
                try {
                    actualOwner.join();
                    require(!actualOwner.isAlive(), "Actual original owner join did not finish");
                    report.accept("actual-original-main-owner-joined; failed=" + (failure != null));
                } catch (Throwable error) { fail(error); }
            }, "BrowserLifecycleOwnerJoin");
            joiner.setDaemon(true);
            joiner.start();
            // Original renderLoop ends in System.exit; Java finally is not external exit proof.
            RenderThread.renderLoop();
        } finally {
            luaLogger.removeHandler(luaErrors);
            Thread.setDefaultUncaughtExceptionHandler(oldGlobal);
        }
        throw new IllegalStateException("Original renderLoop unexpectedly returned; no completion claim", failure);
    }

    private void step() throws Exception {
        observe();
        BrowserOriginalBoot.observeState();
        if (BrowserOriginalBoot.stopRequested()) requestClose();
        long requested = closeRequestedAt;
        Thread loader = GameLoadingState.loader;
        if (requested != 0 && (loader == null || !loader.isAlive())) {
            GameWindow.closeRequested = true;
            return;
        }
        if (requested != 0 && System.nanoTime() - requested >= closeBoundNanos)
            throw new IllegalStateException("Loader still owns work at close deadline; VM teardown required");
        boot.step();
        observe();
    }

    private void observe() throws Exception {
        if (failure != null) throw new IllegalStateException("Original lifecycle failure", failure);
        require(caught.getInt(null) == initialExceptions, "Original caught exception count changed");
        require(!loadingError.getBoolean(null), "Original loading worker failed");
        BrowserOriginalBoot.ownedPaths();
        if (GameWindow.okToSaveOnExit) {
            Path save = Path.of(ZomboidFileSystem.instance.getCurrentSaveDir()).toRealPath();
            require(save.startsWith(root) && !save.equals(root), "Actual save must stay inside owned root");
        }
    }

    /** Selected original offline GameWindow.exit producer order, without inactive native free. */
    private void exit() throws Exception {
        Thread loader = GameLoadingState.loader;
        if (loader != null) loader.join(1000);
        require(loader == null || !loader.isAlive(), "Live loader: no resource teardown or clean-exit claim");
        require(loader == null || GameWindow.okToSaveOnExit,
                "Loading began without an original completed world; partial cleanup unqualified");
        observe();
        require(GameWindow.okToSaveOnExit || zombie.iso.IsoWorld.instance.currentCell == null,
                "Partial world cleanup is unqualified; VM teardown required");
        if (GameWindow.okToSaveOnExit) {
            require(!zombie.pathfind.nativeCode.PathfindNative.useNativeCode,
                    "Only the genuinely selected Java pathfinding owner is hosted");
            zombie.iso.WorldStreamer.instance.quit();
            if (zombie.savefile.PlayerDB.isAllow()) {
                zombie.savefile.PlayerDB.getInstance().saveLocalPlayersForce();
                zombie.savefile.PlayerDB.getInstance().canSavePlayers = false;
            }
            GameWindow.save(true);
            if (zombie.iso.IsoWorld.instance.currentCell != null) {
                zombie.Lua.LuaEventManager.triggerEvent("OnPostSave");
                zombie.Lua.LuaEventManager.triggerEvent("OnPostSave");
            }
            zombie.iso.LightingThread.instance.stop();
            MapCollisionData.instance.stop();
            zombie.characters.animals.AnimalPopulationManager.getInstance().stop();
            zombie.popman.ZombiePopulationManager.instance.stop();
            zombie.pathfind.PolygonalMap2.instance.stop();
            ZombieSpawnRecorder.instance.quit();
        }
        if (zombie.savefile.PlayerDB.isAvailable()) zombie.savefile.PlayerDB.getInstance().close();
        if (zombie.savefile.ClientPlayerDB.isAvailable()) zombie.savefile.ClientPlayerDB.getInstance().close();
        zombie.network.GameClient.instance.Shutdown();
        zombie.core.znet.SteamUtils.shutdown();
        zombie.core.logger.ZipLogs.addZipFile(true);
        require(!GameWindow.fileSystem.hasWork(), "Actual asset work remains at exit");
        observe();
        BrowserOriginalBoot.finishJava();
        observe();
        boot.ownerExited();
        report.accept("original-game-exit-callback-completed; external-join-and-host-teardown-required");
    }

    private void uncaught(Thread thread, Throwable error) {
        fail(error);
        try { GameWindow.uncaughtException(thread, error); }
        finally {
            try { boot.ownerExited(); }
            catch (Exception notificationError) { fail(notificationError); }
            report.accept("original-game-owner-failed; VM-teardown-required");
        }
    }

    private synchronized void fail(Throwable error) {
        if (failure == null) failure = error;
        else if (failure != error) failure.addSuppressed(error);
        try { BrowserOriginalBoot.reportFailure(failure); }
        catch (Throwable observationError) {
            if (observationError != failure) {
                try { failure.addSuppressed(observationError); }
                catch (Throwable ignored) { /* Observation must not replace the original failure. */ }
            }
        }
    }

    private void callback(Action action) {
        try { action.run(); }
        catch (RuntimeException failure) { throw failure; }
        catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    @FunctionalInterface private interface Action { void run() throws Exception; }

    private static Field field(Class<?> owner, String name, Class<?> type) {
        try {
            Field result = owner.getDeclaredField(name);
            require(result.getType() == type && java.lang.reflect.Modifier.isStatic(result.getModifiers()),
                    "Unexpected original observation descriptor");
            result.setAccessible(true);
            return result;
        } catch (ReflectiveOperationException failure) { throw new IllegalStateException(failure); }
    }

    private static void registerOriginalAssetManagers() {
        var managers = GameWindow.assetManagers;
        zombie.core.skinnedmodel.model.AiSceneAssetManager.instance.create(zombie.core.skinnedmodel.model.AiSceneAsset.ASSET_TYPE, managers);
        zombie.core.textures.AnimatedTextureIDAssetManager.instance.create(zombie.core.textures.AnimatedTextureID.ASSET_TYPE, managers);
        zombie.core.skinnedmodel.model.AnimationAssetManager.instance.create(zombie.core.skinnedmodel.model.AnimationAsset.ASSET_TYPE, managers);
        zombie.core.skinnedmodel.advancedanimation.AnimNodeAssetManager.instance.create(zombie.core.skinnedmodel.advancedanimation.AnimNodeAsset.ASSET_TYPE, managers);
        zombie.core.skinnedmodel.population.ClothingItemAssetManager.instance.create(zombie.core.skinnedmodel.population.ClothingItem.ASSET_TYPE, managers);
        zombie.core.skinnedmodel.model.MeshAssetManager.instance.create(zombie.core.skinnedmodel.model.ModelMesh.ASSET_TYPE, managers);
        zombie.core.skinnedmodel.model.ModelAssetManager.instance.create(zombie.core.skinnedmodel.model.Model.ASSET_TYPE, managers);
        zombie.core.textures.NinePatchTextureAssetManager.instance.create(zombie.core.textures.NinePatchTexture.ASSET_TYPE, managers);
        zombie.core.physics.PhysicsShapeAssetManager.instance.create(zombie.core.physics.PhysicsShape.ASSET_TYPE, managers);
        zombie.core.textures.TextureIDAssetManager.instance.create(zombie.core.textures.TextureID.ASSET_TYPE, managers);
        zombie.core.textures.TextureAssetManager.instance.create(zombie.core.textures.Texture.ASSET_TYPE, managers);
        zombie.worldMap.WorldMapDataAssetManager.instance.create(zombie.worldMap.WorldMapData.ASSET_TYPE, managers);
    }

    private static void require(boolean value, String message) {
        if (!value) throw new IllegalStateException(message);
    }
}
