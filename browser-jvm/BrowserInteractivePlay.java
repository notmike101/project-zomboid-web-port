import java.io.StringWriter;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import port.host.BrowserModelBootstrap;
import port.host.BrowserGeometry;
import port.host.BrowserPlaySession;
import port.host.BrowserWorldBootstrap;
import port.host.BrowserContentBootstrap;
import port.host.CharacterRenderer;
import port.host.SpriteGraphics;
import port.host.FloorMapRenderer;
import zombie.GameWindow;

/** Diagnostic integration entry: host input only; actor movement and animation belong to original frame updates. */
public final class BrowserInteractivePlay {
    private static String stage = "geometry-assets";
    private static boolean cleanupComplete;
    private static final String[] STASH_FILES = {"StashUtil", "BrandenburgStashDesc", "EkronStashDesc",
            "IrvingtonStashDesc", "LouisvilleStashDesc", "MarchRidgeStashDesc", "MulStashDesc",
            "RiversideStashDesc", "RosewoodStashDesc", "WorldStashDesc", "WpStashDesc"};
    private static final String[] SPEED_IMAGES = {"StepForward_Off", "Pause_Off", "Pause_On", "Play_Off",
            "Play_On", "FFwd1_Off", "FFwd1_On", "FFwd2_Off", "FFwd2_On", "Wait_Off", "Wait_On"};
    public static native void report(String json);
    public static native boolean stopRequested();

    public static void main(String[] args) {
        try {
            run(args.length == 0 ? 0 : Integer.parseInt(args[0]), args.length < 2 || !args[1].equals("step-only"),
                    args.length > 2 && args[2].equals("verify-navigation"));
        } catch (Throwable failure) {
            failure.printStackTrace();
            StringWriter trace = new StringWriter();
            failure.printStackTrace(new PrintWriter(trace));
            report("{\"pass\":false,\"stage\":" + quote(stage) + ",\"error\":" + quote(trace.toString())
                    + ",\"cleanupComplete\":" + cleanupComplete + "}");
        }
    }

    private static void run(int frameLimit, boolean draw, boolean verifyNavigation) throws Exception {
        if (frameLimit < 0) throw new IllegalArgumentException("Negative frame limit");
        BrowserGeometry.Session[] geometry = new BrowserGeometry.Session[1];
        Throwable failure = null;
        String result;
        try {
            // The original -nosound option is already the qualified browser bootstrap's audio mode.
            zombie.core.Core.soundDisabled = true;
            zombie.SoundManager.instance = new zombie.DummySoundManager();
            zombie.AmbientStreamManager.instance = new zombie.DummyAmbientStreamManager();
            zombie.audio.BaseSoundBank.instance = new zombie.audio.DummySoundBank();
            BrowserGeometry.mountAssets();
            mountFile("media/texturepacks/WeatherFx.pack");
            mountFile("media/textures/weather/fogcircle_tex.png");
            mountFile("media/textures/weather/fogwhite_tex.png");
            for (String name : STASH_FILES) mountFile("media/lua/shared/StashDescriptions/" + name + ".lua");
            for (String name : SPEED_IMAGES) mountFile("media/ui/speedControls/" + name + ".png");
            if (verifyNavigation) PlayerNavigationQualification.mountAssets();
            BrowserModelBootstrap.open(value -> { stage = value; progress(value); });
            installRuntimeLogTransport();
            stage = "original-spawn-in-loaded-cell";
            try (BrowserWorldBootstrap world = BrowserWorldBootstrap.openAt(153, 158, 0, cell -> {
                stage = "original-item-factory";
                progress(stage);
                var bareHands = zombie.inventory.InventoryItemFactory.CreateItem("Base.BareHands");
                if (!(bareHands instanceof zombie.inventory.types.HandWeapon weapon) || !weapon.isBareHands())
                    throw new AssertionError("Original Base.BareHands factory did not produce bare hands");
                stage = "original-loot-distributions";
                progress(stage);
                BrowserContentBootstrap.loadDistributions();
                zombie.vehicles.VehicleType.init();
                stage = "original-clock-init";
                progress(stage);
                zombie.GameTime.getInstance().init();
                stage = "original-outfit-lifecycle";
                progress(stage);
                if (GameWindow.assetManagers.get(zombie.core.skinnedmodel.population.ClothingItem.ASSET_TYPE) == null)
                    zombie.core.skinnedmodel.population.ClothingItemAssetManager.instance.create(
                            zombie.core.skinnedmodel.population.ClothingItem.ASSET_TYPE, GameWindow.assetManagers);
                zombie.core.skinnedmodel.population.OutfitManager.init();
                if (zombie.core.skinnedmodel.population.OutfitManager.instance == null)
                    throw new AssertionError("Original OutfitManager did not initialize from installed clothing.xml");
                stage = "original-stash-lifecycle";
                progress(stage);
                zombie.Lua.LuaManager.LoadDirBase("shared", true);
                for (String name : STASH_FILES)
                    zombie.Lua.LuaManager.RunLua("/files/work/media/lua/shared/StashDescriptions/" + name + ".lua");
                zombie.core.stash.StashSystem.init();
                if (zombie.core.stash.StashSystem.getAllStashes().isEmpty())
                    throw new AssertionError("Installed stash definitions were not loaded");
                stage = "original-same-cell-geometry";
                progress(stage);
                geometry[0] = BrowserGeometry.loadChallenge1(cell);
                stage = "original-weather-texture-assets";
                progress(stage);
                GameWindow.fileSystem.mountTexturePack("WeatherFx", GameWindow.texturePackTextures, 0);
                for (int i = 0; i < 6; i++) {
                    port.host.BrowserTileTextures.load("clouds_" + i);
                    port.host.BrowserTileTextures.load("fog_" + i);
                }
                for (int i = 1; i <= 3; i++) port.host.BrowserTileTextures.load("snow_" + i);
                port.host.BrowserTileTextures.load("fogwhite");
                zombie.iso.weather.fx.WeatherFxMask.init();
                zombie.iso.objects.ObjectRenderEffects.init();
                stage = "original-climate-lifecycle";
                progress(stage);
                zombie.iso.weather.ClimateManager.getInstance().init(zombie.iso.IsoWorld.instance.getMetaGrid());
                stage = "original-early-ui-lifecycle";
                progress(stage);
                if (zombie.characters.IsoPlayer.getInstance() != null)
                    throw new AssertionError("Expected original pre-player UI lifecycle");
                zombie.ui.UIManager.init();
                if (zombie.ui.UIManager.getSpeedControls() == null
                        || zombie.ui.UIManager.getSpeedControls().getCurrentGameSpeed() != 1)
                    throw new AssertionError("Original speed controls did not initialize");
                stage = "original-nosound-runtime";
                var spawn = geometry[0].getSpawnSquare();
                var building = spawn.getRoom() == null ? null : spawn.getRoom().building;
                report("{\"progress\":\"original-nosound-readiness\",\"ambientWasNull\":"
                        + (zombie.AmbientStreamManager.instance == null) + ",\"spawnAlarmed\":"
                        + (building != null && building.def != null && building.def.isAlarmed()) + "}");
                progress(stage);
            })) {
                var player = world.getPlayer();
                if (player.bareHands == null || !player.bareHands.isBareHands())
                    throw new AssertionError("Original player constructor did not initialize bare hands");
                try {
                    String material = "/files/work/media/textures/Body/"
                            + (player.isFemale() ? "FemaleBody01.png" : "MaleBody01.png");
                    if (draw) {
                        stage = "original-render-occlusion-init";
                        progress(stage);
                        zombie.iso.fboRenderChunk.FBORenderOcclusion.getInstance().init();
                        stage = "original-floor-renderer-init";
                        progress(stage);
                        zombie.core.SceneShaderStore.initGlobalShader();
                        zombie.core.SpriteRenderer.instance.create();
                    }
                    stage = "owned-reusable-renderer";
                    try (BrowserPlaySession session = new BrowserPlaySession(world, value -> { stage = value; progress(value); });
                         CharacterRenderer renderer = draw ? CharacterRenderer.open(material) : null) {
                        stage = "original-post-player-chunk-activation";
                        progress(stage);
                        geometry[0].activate();
                        if (geometry[0].getChunks().size() != 9 || geometry[0].getGroundFloorCount() != 576)
                            throw new AssertionError("Original loaded neighborhood is incomplete");
                        int shaderId = draw ? renderer.getShaderId() : 0, textureId = draw ? renderer.getMaterialId() : 0;
                        int frames = 0, drawnFrames = 0;
                        float initialX = player.getX(), initialY = player.getY();
                        report("{\"ready\":true,\"initial\":" + session.snapshot() + "}");
                        while (!stopRequested() && (frameLimit == 0 || frames < frameLimit)) {
                            stage = "original-frame";
                            try { session.step(); }
                            catch (Throwable error) { stage = session.getStage(); throw error; }
                            stage = "original-mesh-draw";
                            if (draw) {
                                var liveAnimation = player.getAnimationPlayer();
                                FloorMapRenderer.draw(world.getCell(), player,
                                        SpriteGraphics.surfaceWidth(), SpriteGraphics.surfaceHeight(), true);
                                if (!liveAnimation.isBoneTransformsNeedFirstFrame()) {
                                    renderer.drawInWorld(liveAnimation.getModel(), liveAnimation);
                                    drawnFrames++;
                                }
                                SpriteGraphics.present(false);
                            }
                            if (draw && (renderer.getShaderId() != shaderId || renderer.getMaterialId() != textureId))
                                throw new AssertionError("Owned renderer resources changed");
                            frames++;
                            report("{\"progress\":\"original-play-frame\",\"player\":" + session.snapshot() + "}");
                        }
                        stage = "capture-final-original-frame";
                        if (frames == 0) throw new AssertionError("No original world frame completed");
                        if (draw && drawnFrames == 0) throw new AssertionError("Original animation pose never became ready for drawing");
                        String navigation = "null";
                        if (verifyNavigation) {
                            stage = "original-player-navigation-qualification";
                            progress(stage);
                            var qualification = PlayerNavigationQualification.run(session);
                            frames += qualification.frames();
                            navigation = qualification.json();
                        }
                        String composition = "null";
                        if (draw) {
                            var liveAnimation = player.getAnimationPlayer();
                            if (liveAnimation.isBoneTransformsNeedFirstFrame()) throw new AssertionError("Final original pose is not ready");
                            FloorMapRenderer.draw(world.getCell(), player,
                                    SpriteGraphics.surfaceWidth(), SpriteGraphics.surfaceHeight(), true);
                            byte[] floorPixels = readSurface();
                            renderer.drawInWorld(liveAnimation.getModel(), liveAnimation);
                            byte[] combinedPixels = readSurface();
                            int floorVisible = 0, changed = 0;
                            for (int pixel = 0; pixel < floorPixels.length; pixel += 4) {
                                if (floorPixels[pixel] != 0 || floorPixels[pixel + 1] != 0 || floorPixels[pixel + 2] != 0) floorVisible++;
                                if (floorPixels[pixel] != combinedPixels[pixel] || floorPixels[pixel + 1] != combinedPixels[pixel + 1]
                                        || floorPixels[pixel + 2] != combinedPixels[pixel + 2]) changed++;
                            }
                            if (floorVisible < 1000 || changed < 16)
                                throw new AssertionError("Original floor/body composition failed: floor=" + floorVisible + " changed=" + changed);
                            composition = "{\"floorVisiblePixels\":" + floorVisible + ",\"bodyChangedPixels\":" + changed + "}";
                            SpriteGraphics.present(false);
                        }
                        String capture = frames == 0 || !draw ? "null" : renderer.capture();
                        result = "{\"pass\":true,\"qualification\":\"original-frame-lifecycle\",\"stopped\":true,\"cleanupComplete\":true,\"regionWorkerLifetime\":\"browser-context\",\"frames\":" + frames
                                + ",\"initialX\":" + initialX + ",\"initialY\":" + initialY
                                + ",\"loadedChunks\":" + geometry[0].getChunks().size()
                                + ",\"groundFloors\":" + geometry[0].getGroundFloorCount()
                                + ",\"vanillaContent\":{\"items\":" + zombie.scripting.ScriptManager.instance.getAllItems().size()
                                + ",\"vehicleScripts\":" + zombie.scripting.ScriptManager.instance.getAllVehicleScripts().size()
                                + ",\"lootRooms\":" + zombie.inventory.ItemPickerJava.rooms.size()
                                + ",\"sharedLuaFiles\":" + BrowserContentBootstrap.getSharedLuaFiles()
                                + ",\"sharedLuaErrors\":" + BrowserContentBootstrap.getSharedLuaErrors() + "}"
                                + ",\"navigation\":" + navigation + ",\"final\":" + session.snapshot() + ",\"composition\":" + composition + ",\"frame\":" + capture + "}";
                    }
                } finally { player.releaseAnimationPlayer(); }
            }
        } catch (Throwable error) {
            failure = error;
            StringWriter trace = new StringWriter();
            error.printStackTrace(new PrintWriter(trace));
            report("{\"progress\":\"failure-before-cleanup\",\"stage\":" + quote(stage)
                    + ",\"error\":" + quote(trace.toString()) + "}");
            throw error;
        }
        finally {
            Throwable cleanupFailure = null;
            // The original daemon has no nonblocking request-exit API. Its owner is the sole browser JVM.
            try { if (geometry[0] != null) geometry[0].close(); }
            catch (Throwable cleanup) {
                if (cleanupFailure == null) cleanupFailure = cleanup;
                else cleanupFailure.addSuppressed(cleanup);
            }
            try { shutdownAssetExecutor(); }
            catch (Throwable cleanup) {
                if (cleanupFailure == null) cleanupFailure = cleanup;
                else cleanupFailure.addSuppressed(cleanup);
            }
            if (cleanupFailure != null) {
                if (failure != null) failure.addSuppressed(cleanupFailure);
                else if (cleanupFailure instanceof Exception exception) throw exception;
                else if (cleanupFailure instanceof Error fatal) throw fatal;
                else throw new AssertionError(cleanupFailure);
            } else cleanupComplete = failure == null;
        }
        report(result);
    }

    private static void shutdownAssetExecutor() throws Exception {
        var field = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");
        field.setAccessible(true);
        ExecutorService executor = (ExecutorService) field.get(GameWindow.fileSystem);
        executor.shutdown();
        if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new IllegalStateException("Original asset worker did not terminate");
    }
    private static void mountFile(String relative) throws Exception {
        Path destination = Path.of("/files/work").resolve(relative);
        Files.createDirectories(destination.getParent());
        Files.copy(Path.of("/app").resolve(relative), destination, StandardCopyOption.REPLACE_EXISTING);
    }
    private static void progress(String value) { report("{\"progress\":" + quote(value) + "}"); }
    private static byte[] readSurface() {
        int length = Math.multiplyExact(Math.multiplyExact(SpriteGraphics.surfaceWidth(), SpriteGraphics.surfaceHeight()), 4);
        var buffer = java.nio.ByteBuffer.allocateDirect(length);
        org.lwjgl.opengl.GL11.glReadPixels(0, 0, SpriteGraphics.surfaceWidth(), SpriteGraphics.surfaceHeight(),
                org.lwjgl.opengl.GL11.GL_RGBA, org.lwjgl.opengl.GL11.GL_UNSIGNED_BYTE, buffer);
        if (org.lwjgl.opengl.GL11.glGetError() != 0 || buffer.position() != 0 || buffer.limit() != length)
            throw new AssertionError("Original composition readback failed");
        byte[] pixels = new byte[length];
        buffer.get(pixels);
        return pixels;
    }
    private static void installRuntimeLogTransport() throws Exception {
        var stream = new java.io.PrintStream(new java.io.OutputStream() {
            private final java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream();
            @Override public void write(int value) {
                System.out.write(value);
                if (value == '\n') {
                    report("{\"progress\":\"original-runtime-log\",\"line\":"
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
    private static String quote(String value) {
        StringBuilder encoded = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\\' || c == '"') encoded.append('\\').append(c);
            else if (c < 0x20) {
                String hex = Integer.toHexString(c);
                encoded.append("\\u");
                for (int zero = hex.length(); zero < 4; zero++) encoded.append('0');
                encoded.append(hex);
            } else encoded.append(c);
        }
        return encoded.append('"').toString();
    }
}
