package port.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
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
import zombie.scripting.ScriptManager;

/** Original client model lifecycle shared by authored browser sessions; global engine assets remain owned by the session. */
public final class BrowserModelBootstrap {
    private BrowserModelBootstrap() { }

    public static void open(Consumer<String> progress) throws Exception {
        mount();
        zombie.debug.DebugLog.getInstance().setStdOut(System.out);
        zombie.debug.DebugLog.getInstance().setStdErr(System.out);
        BrowserContentBootstrap.mountAssets();
        progress.accept("original-lua-before-scripts");
        BrowserWorldBootstrap.initializeLua();
        progress.accept("original-script-lifecycle");
        BrowserContentBootstrap.loadDefinitions();
        int animationMeshes = ScriptManager.instance.getAllAnimationsMeshes().size();
        if (animationMeshes != 75 || ScriptManager.instance.getAnimationsMesh("Human") == null)
            throw new AssertionError("Installed full animation-mesh definitions differ: " + animationMeshes);
        progress.accept("original-asset-managers");
        AssetManagers managers = GameWindow.assetManagers;
        MeshAssetManager.instance.create(ModelMesh.ASSET_TYPE, managers);
        AnimationAssetManager.instance.create(AnimationAsset.ASSET_TYPE, managers);
        ModelAssetManager.instance.create(Model.ASSET_TYPE, managers);
        ModelManager.noOpenGL = false;
        GLVertexBufferObject.init();
        progress.accept("original-async-animation-mesh-preload");
        // The original public async API avoids requiring the unrelated startup progress UI/font renderer.
        ModelManager.instance.initAnimationMeshes(true);
        var pending = ModelManager.class.getDeclaredMethod("isLoadingAnimationMeshes");
        pending.setAccessible(true);
        long end = System.currentTimeMillis() + 30000;
        while ((Boolean) pending.invoke(ModelManager.instance) && System.currentTimeMillis() < end) pump();
        if ((Boolean) pending.invoke(ModelManager.instance)) throw new AssertionError("Original mesh preload timed out");
        var human = ScriptManager.instance.getAnimationsMesh("Human").modelMesh;
        if (!human.isReady() || human.vb == null) throw new AssertionError("Original Human GPU mesh is not ready");
        progress.accept("original-client-create");
        ModelManager.instance.create();
        if (!ModelManager.instance.isCreated()) throw new AssertionError("Original client ModelManager did not complete");
        progress.accept("original-body-readiness");
        Model[] bodies = {ModelManager.instance.maleModel, ModelManager.instance.femaleModel,
                ModelManager.instance.skeletonMaleModel, ModelManager.instance.skeletonFemaleModel};
        end = System.currentTimeMillis() + 30000;
        for (Model body : bodies) {
            if (body == null) throw new AssertionError("Original body model not assigned");
            while (!body.isReady() && !body.isFailure() && System.currentTimeMillis() < end) pump();
            if (!body.isReady() || body.mesh.vb == null)
                throw new AssertionError("Original GPU body model not ready: " + body.getPath() + " " + body.getState());
        }
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

}
