package zombie;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import zombie.Lua.LuaEventManager;
import zombie.Lua.LuaManager;
import zombie.core.Core;
import zombie.core.opengl.RenderThread;

/** Preserves original startup ordering on the actual browser lifecycle owner. */
public final class BrowserLifecycleBoot {
    private final Method renameSaves = originalVoid("renameSaveFolders");
    private final Method requiredLibraries = originalVoid("checkRequiredLibraries");
    private final Method selectInitialShader = originalVoid("lambda$init$0");
    private final Method shared = originalVoid("initShared");
    private final Method enter = originalVoid("enter");
    private final Method resetShader = originalVoid("lambda$mainThreadStart$0");
    private final Method step = originalVoid("mainThreadStep");
    private final Field currentTime = originalLong("currentTime");
    private final Method exited = originalVoid("onGameThreadExited");

    /** Called only after the real MainThread return-value/startup publication handshake. */
    public void start(Path ownedRoot) throws Exception {
        requireOwner();
        require(RenderThread.isRunning(), "Actual render owner must already be running");
        require("0".equals(System.getProperty("zomboid.steam")) && Core.soundDisabled != Boolean.getBoolean("pz.browser.audio"),
                "Original offline/audio branch must be configured before boot");
        require(System.getProperty("nosave") == null && !Core.getInstance().isNoSave(), "Saving stays enabled");
        require(System.getProperty("server") == null && System.getProperty("nozombies") == null
                && !zombie.network.GameServer.server && !zombie.network.GameClient.client,
                "Offline original zombie-enabled branch only");
        require(System.getProperty("debug") == null && System.getProperty("imgui") == null
                && System.getProperty("imguidebugviewports") == null && !Core.debug
                && !Core.useViewports && !Core.imGui,
                "Debug desktop startup branches require separate admission");
        require(LuaManager.env == null && GameWindow.states.current == null
                && GameWindow.states.states.isEmpty(), "Fresh original bootstrap required");
        Path root = ownedRoot.toRealPath();
        Path cache = Path.of(ZomboidFileSystem.instance.getCacheDir()).toRealPath();
        require(cache.startsWith(root) && !cache.equals(root), "Existing cache must be inside owned root");

        // Original mainThreadInit producers, selected original audio branch.
        zombie.debug.DebugOptions.instance.init();
        zombie.debug.DebugOptions.instance.pathfindUseNativeCode.setValue(false);
        require(!zombie.debug.DebugOptions.instance.pathfindUseNativeCode.getValue(),
                "Original Java backend option must actually read false in release mode");
        GameProfiler.init();
        SoundManager.instance = new DummySoundManager();
        AmbientStreamManager.instance = new DummyAmbientStreamManager();
        zombie.audio.BaseSoundBank.instance = new zombie.audio.DummySoundBank();
        zombie.core.raknet.VoiceManager.instance.loadConfig();
        zombie.core.textures.TextureID.useCompressionOption = Core.safeModeForced
                || Core.getInstance().getOptionTextureCompression();
        zombie.core.textures.TextureID.useCompression = zombie.core.textures.TextureID.useCompressionOption;
        SoundManager.instance.setSoundVolume(Core.getInstance().getOptionSoundVolume() / 10.0f);
        SoundManager.instance.setMusicVolume(Core.getInstance().getOptionMusicVolume() / 10.0f);
        SoundManager.instance.setAmbientVolume(Core.getInstance().getOptionAmbientVolume() / 10.0f);
        SoundManager.instance.setVehicleEngineVolume(Core.getInstance().getOptionVehicleEngineVolume() / 10.0f);
        phase("ZFS.init.before");
        ZomboidFileSystem.instance.init();
        phase("ZFS.init.after");
        DebugFileWatcher.instance.init();
        call(renameSaves);

        // Original GameWindow.init producer order; only inactive desktop PathfindNative.init omitted.
        Core.getInstance().initGlobalShader();
        RenderThread.invokeOnRenderContext(() -> unchecked(selectInitialShader));
        phase("initFonts.initial.before");
        GameWindow.initFonts();
        phase("initFonts.initial.after");
        phase("requiredLibraries.before");
        call(requiredLibraries);
        phase("requiredLibraries.after");
        phase("nativeSubsystems.before");
        phase("SteamUtils.init.before");
        zombie.core.znet.SteamUtils.init();
        phase("SteamUtils.init.after");
        phase("ServerBrowser.init.before");
        zombie.core.znet.ServerBrowser.init();
        phase("ServerBrowser.init.after");
        phase("SteamFriends.init.before");
        zombie.core.znet.SteamFriends.init();
        phase("SteamFriends.init.after");
        phase("SteamWorkshop.init.before");
        zombie.core.znet.SteamWorkshop.init();
        phase("SteamWorkshop.init.after");
        ZomboidFileSystem.instance.resetModFolders();
        phase("RakNetPeerInterface.init.before");
        zombie.core.raknet.RakNetPeerInterface.init();
        phase("RakNetPeerInterface.init.after");
        phase("LightingJNI.init.before");
        zombie.iso.LightingJNI.init();
        phase("LightingJNI.init.after");
        phase("ZombiePopulationManager.init.before");
        zombie.popman.ZombiePopulationManager.init();
        phase("ZombiePopulationManager.init.after");
        phase("PZSQLUtils.init.before");
        zombie.util.PZSQLUtils.init();
        phase("PZSQLUtils.init.after");
        phase("Clipper.init.before");
        zombie.vehicles.Clipper.init();
        phase("Clipper.init.after");
        phase("WorldMapJNI.init.before");
        zombie.worldMap.WorldMapJNI.init();
        phase("WorldMapJNI.init.after");
        phase("nativeSubsystems.after");
        Files.createDirectories(cache);
        GameWindow.DoLoadingText("Loading Mods");
        ZomboidFileSystem.instance.resetDefaultModsForNewRelease("42_00");
        ZomboidFileSystem.instance.loadMods("default");
        ZomboidFileSystem.instance.loadModPackFiles();
        require(!zombie.core.znet.SteamUtils.isSteamModeEnabled(), "Original non-Steam init must remain selected");
        GameWindow.DoLoadingText("Loading Translations");
        phase("translations.before");
        zombie.core.Languages.instance.init();
        zombie.core.Translator.language = null;
        GameWindow.initFonts();
        zombie.core.Translator.loadFiles();
        phase("translations.after");
        GameWindow.doEpilepsyWarningText();
        phase("LuaManager.init.before");
        LuaManager.init();
        phase("LuaManager.init.after");
        phase("initShared.before");
        call(shared);
        phase("initShared.after");
        GameWindow.DoLoadingText(zombie.core.Translator.getText("UI_Loading_Lua", new Object[0]));
        phase("LoadDirBase.before");
        LuaManager.LoadDirBase();
        phase("LoadDirBase.after");
        ZomboidGlobals.Load();
        LuaEventManager.triggerEvent("OnLoadSoundBanks");

        // Original enter includes actual packs, models, depth producers and OnGameBoot.
        phase("enter.before");
        call(enter);
        phase("enter.after");
        RenderThread.invokeOnRenderContext(() -> unchecked(resetShader));
        RenderThread.setWaitForRenderState(true);
        currentTime.setLong(null, System.nanoTime());
        phase("done");
    }

    /** Reports only completed/reached authored call boundaries on the actual original owner. */
    private static void phase(String name) {
        requireOwner();
        BrowserOriginalBoot.report("{\"bootPhase\":\"" + name + "\"}");
    }

    /** Original completion notification, called after the actual exit callback terminates. */
    public void ownerExited() throws Exception { call(exited); }

    /** Reuses original cadence, accumulator, frameStep, logic and state/async pumps. */
    public void step() throws Exception {
        requireOwner();
        call(step);
    }

    private static void requireOwner() {
        require(Thread.currentThread() == GameWindow.gameThread
                && Thread.currentThread() == MainThread.mainThread, "Actual original MainThread owner required");
    }

    private static Method originalVoid(String name) {
        try {
            Method method = GameWindow.class.getDeclaredMethod(name);
            require(Modifier.isStatic(method.getModifiers()) && method.getReturnType() == void.class,
                    "Unexpected original method descriptor: " + name);
            method.setAccessible(true);
            return method;
        } catch (ReflectiveOperationException failure) { throw new IllegalStateException(failure); }
    }

    private static Field originalLong(String name) {
        try {
            Field field = GameWindow.class.getDeclaredField(name);
            require(Modifier.isStatic(field.getModifiers()) && field.getType() == long.class,
                    "Unexpected original timing field: " + name);
            field.setAccessible(true);
            return field;
        } catch (ReflectiveOperationException failure) { throw new IllegalStateException(failure); }
    }

    private static void call(Method method) throws Exception {
        try { method.invoke(null); }
        catch (InvocationTargetException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Exception exception) throw exception;
            if (cause instanceof Error error) throw error;
            throw new IllegalStateException(cause);
        }
    }

    private static void unchecked(Method method) {
        try { call(method); }
        catch (RuntimeException failure) { throw failure; }
        catch (Exception failure) { throw new IllegalStateException(failure); }
    }

    private static void require(boolean value, String message) {
        if (!value) throw new IllegalStateException(message);
    }
}
