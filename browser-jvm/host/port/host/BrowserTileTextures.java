package port.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import zombie.GameWindow;
import zombie.core.textures.Texture;
import zombie.core.textures.TextureAssetManager;
import zombie.core.textures.TextureID;
import zombie.core.textures.TextureIDAssetManager;

/** Mounts an actual installed floor atlas through the original pack reader and asset managers. */
public final class BrowserTileTextures {
    private BrowserTileTextures() { }

    public static void mountFloorPack() throws Exception {
        mount("Tiles1x.floor");
    }

    public static void mountChallenge1Packs() throws Exception {
        mount("Tiles1x.floor", "Challenge1Tiles");
    }

    private static void copy(String relative) throws Exception {
        Path destination = Path.of("/files/work").resolve(relative);
        Files.createDirectories(destination.getParent());
        Files.copy(Path.of("/app").resolve(relative), destination, StandardCopyOption.REPLACE_EXISTING);
    }

    private static void mount(String... packs) throws Exception {
        for (String pack : packs) copy("media/texturepacks/" + pack + ".pack");
        zombie.ZomboidFileSystem.instance.init();
        if (GameWindow.assetManagers.get(TextureID.ASSET_TYPE) == null)
            TextureIDAssetManager.instance.create(TextureID.ASSET_TYPE, GameWindow.assetManagers);
        if (GameWindow.assetManagers.get(Texture.ASSET_TYPE) == null)
            TextureAssetManager.instance.create(Texture.ASSET_TYPE, GameWindow.assetManagers);
        for (String pack : packs)
            GameWindow.fileSystem.mountTexturePack(pack, GameWindow.texturePackTextures, 0);
        if (!GameWindow.texturePackTextures.containsKey("floors_interior_tilesandwood_01_0"))
            throw new AssertionError("Installed floor atlas does not contain the expected sprite");
    }

    public static Texture load(String spriteName) throws Exception {
        if (!GameWindow.texturePackTextures.containsKey(spriteName))
            throw new IllegalArgumentException("Sprite is absent from the mounted original atlas: " + spriteName);
        Texture texture = Texture.getSharedTexture(spriteName, 0);
        if (texture == null) throw new AssertionError("Original texture factory rejected atlas sprite");
        long deadline = System.currentTimeMillis() + 30000;
        while (!texture.isReady() && !texture.isFailure() && System.currentTimeMillis() < deadline) {
            GameWindow.fileSystem.updateAsyncTransactions();
            Thread.sleep(1);
        }
        // Asset READY can precede completion of its queued texture upload.
        zombie.core.opengl.RenderThread.invokeOnRenderContext(() -> {});
        if (!texture.isReady() || texture.getID() <= 0)
            throw new AssertionError("Original atlas texture did not become GPU ready: " + texture.getState());
        return texture;
    }
}
