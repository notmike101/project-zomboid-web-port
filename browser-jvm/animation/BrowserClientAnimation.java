import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.EnumSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import port.host.BrowserWorldBootstrap;
import port.host.CharacterFrame;
import port.host.ScriptBootstrap;
import zombie.GameWindow;
import zombie.asset.AssetManagers;
import zombie.core.VBO.GLVertexBufferObject;
import zombie.core.skinnedmodel.ModelManager;
import zombie.core.skinnedmodel.model.AnimationAsset;
import zombie.core.skinnedmodel.model.AnimationAssetManager;
import zombie.core.skinnedmodel.model.MeshAssetManager;
import zombie.core.skinnedmodel.model.Model;
import zombie.core.skinnedmodel.model.ModelAssetManager;
import zombie.core.skinnedmodel.model.ModelMesh;
import zombie.core.textures.ImageData;
import zombie.core.textures.Texture;
import zombie.core.textures.TextureID;
import zombie.scripting.ScriptManager;
import zombie.scripting.ScriptType;

/** Bounded original client model creation, player animation attachment, graph update and GPU draw. */
public final class BrowserClientAnimation {
    private static String stage = "mount";
    public static native void report(String json);

    public static void main(String[] args) {
        try {
            report(run());
        } catch (Throwable failure) {
            failure.printStackTrace();
            report("{\"pass\":false,\"stage\":\"" + escape(stage) + "\",\"error\":\"" + escape(failure.toString()) + "\"}");
        }
    }

    private static String run() throws Exception {
        mount();
        zombie.debug.DebugLog.getInstance().setStdOut(System.out);
        zombie.debug.DebugLog.getInstance().setStdErr(System.out);
        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        zombie.ZomboidFileSystem.instance.init();
        stage = "original-script-lifecycle";
        ScriptBootstrap.load(EnumSet.of(ScriptType.AnimationMesh, ScriptType.Model),
                "media/scripts/generated/animations_meshes.txt", "media/scripts/generated/models_characters.txt");
        if (ScriptManager.instance.getAllAnimationsMeshes().size() != 23)
            throw new AssertionError("Installed animation-mesh definitions differ");
        stage = "original-asset-managers";
        AssetManagers managers = GameWindow.assetManagers;
        MeshAssetManager.instance.create(ModelMesh.ASSET_TYPE, managers);
        AnimationAssetManager.instance.create(AnimationAsset.ASSET_TYPE, managers);
        ModelAssetManager.instance.create(Model.ASSET_TYPE, managers);
        ModelManager.noOpenGL = false;
        GLVertexBufferObject.init();
        stage = "original-async-animation-mesh-preload";
        // The original public async API avoids requiring the unrelated startup progress UI/font renderer.
        ModelManager.instance.initAnimationMeshes(true);
        var pending = ModelManager.class.getDeclaredMethod("isLoadingAnimationMeshes");
        pending.setAccessible(true);
        long end = System.currentTimeMillis() + 30000;
        while ((Boolean) pending.invoke(ModelManager.instance) && System.currentTimeMillis() < end) pump();
        if ((Boolean) pending.invoke(ModelManager.instance)) throw new AssertionError("Original mesh preload timed out");
        var human = ScriptManager.instance.getAnimationsMesh("Human").modelMesh;
        if (!human.isReady() || human.vb == null) throw new AssertionError("Original Human GPU mesh is not ready");
        stage = "original-client-create";
        ModelManager.instance.create();
        if (!ModelManager.instance.isCreated()) throw new AssertionError("Original client ModelManager did not complete");
        stage = "original-body-readiness";
        Model[] bodies = {ModelManager.instance.maleModel, ModelManager.instance.femaleModel,
                ModelManager.instance.skeletonMaleModel, ModelManager.instance.skeletonFemaleModel};
        end = System.currentTimeMillis() + 30000;
        for (Model body : bodies) {
            if (body == null) throw new AssertionError("Original body model not assigned");
            while (!body.isReady() && !body.isFailure() && System.currentTimeMillis() < end) pump();
            if (!body.isReady() || body.mesh.vb == null)
                throw new AssertionError("Original GPU body model not ready: " + body.getPath() + " " + body.getState());
        }
        String frame;
        int bones, tracks;
        String material;
        stage = "original-player-attachment";
        try (BrowserWorldBootstrap world = BrowserWorldBootstrap.open()) {
            var player = world.getPlayer();
            var attached = player.getAnimationPlayer();
            try {
                if (!attached.isReady() || attached.getModel() != ModelManager.instance.getBodyModel(player))
                    throw new AssertionError("Original player body model attachment differs");
                bones = attached.getNumBones();
                stage = "original-advancedanimator-update";
                player.getAdvancedAnimator().setState(player.getActionContext().getCurrentStateName());
                for (int step = 0; step < 4; step++) {
                    player.getAdvancedAnimator().update(1f / 60);
                    attached.Update(1f / 60);
                }
                tracks = attached.getMultiTrack().getTrackCount();
                boolean advancing = false;
                for (var track : attached.getMultiTrack().getTracks())
                    advancing |= track.hasClip() && track.getBlendWeight() > 0 && track.getCurrentTimeValue() > 0;
                if (!advancing) throw new AssertionError("No advancing weighted original animation track");
                stage = "original-body-gpu-frame";
                // A declared installed body material, selected by the actual model gender; no outfit/skin selection claim.
                material = "media/textures/Body/" + (player.isFemale() ? "FemaleBody01.png" : "MaleBody01.png");
                ImageData image;
                try (InputStream input = Files.newInputStream(Path.of("/files/work", material))) {
                    image = new ImageData(input, false);
                }
                TextureID textureId = new TextureID(image);
                Texture texture = new Texture(textureId, material);
                try { frame = CharacterFrame.render(attached.getModel(), attached, texture); }
                finally { org.lwjgl.opengl.GL11.glDeleteTextures(texture.getID()); }
            } finally { player.releaseAnimationPlayer(); }
        }
        stage = "owned-asset-worker-cleanup";
        var executorField = zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");
        executorField.setAccessible(true);
        ExecutorService executor = (ExecutorService) executorField.get(GameWindow.fileSystem);
        executor.shutdown();
        if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new AssertionError("Asset executor did not terminate");
        return "{\"pass\":true,\"originalClientModelManager\":true,\"bodyModelsReady\":4,\"originalPlayerAttached\":true,"
                + "\"originalAdvancedAnimator\":true,\"bones\":" + bones + ",\"tracks\":" + tracks
                + ",\"material\":\"" + material + "\",\"materialSelection\":\"bounded installed body material by actual gender\","
                + "\"assetExecutorTerminated\":true,\"frame\":" + frame + "}";
    }

    private static void pump() throws InterruptedException {
        GameWindow.fileSystem.updateAsyncTransactions();
        Thread.sleep(1);
    }

    private static void mount() throws Exception {
        try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(Path.of("/app/animation-assets.jar")))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (entry.isDirectory() || entry.getName().equals("META-INF/MANIFEST.MF")) continue;
                Path target = Path.of("/files/work").resolve(entry.getName()).normalize();
                if (!target.startsWith(Path.of("/files/work/media"))) throw new IllegalArgumentException("Unexpected asset path");
                Files.createDirectories(target.getParent());
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private static String escape(String text) {
        return text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }
}
