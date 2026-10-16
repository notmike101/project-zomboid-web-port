package port.host;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import zombie.GameWindow;
import zombie.core.fonts.AngelCodeFont;
import zombie.core.textures.Texture;
import zombie.core.textures.TextureAssetManager;
import zombie.core.textures.TextureID;
import zombie.core.textures.TextureIDAssetManager;
import zombie.ui.TextManager;
import zombie.ui.UIFont;

/** Mounts real font assets before ZFS scans and owns the original TextManager lifecycle. */
public final class BrowserFontBootstrap {
    private static boolean mounted;
    private static boolean ownsFonts;
    private static String qualification;

    private BrowserFontBootstrap() { }

    public static void mountAssets() throws IOException {
        if (mounted) throw new IllegalStateException("Font assets already mounted");
        Path work = Path.of("/files/work");
        Set<String> names = new HashSet<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream("/app/font-assets.jar"))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (!names.add(name) || names.size() > 400 || !allowed(name))
                    throw new IOException("Unexpected or duplicate font archive entry: " + name);
                Path target = work.resolve(name).normalize();
                if (!target.startsWith(work.resolve("media"))
                        || !work.relativize(target).toString().replace('\\', '/').equals(name))
                    throw new IOException("Noncanonical font archive entry: " + name);
                byte[] bytes = zip.readNBytes(64 * 1024 * 1024 + 1);
                total += bytes.length;
                if (total > 64L * 1024 * 1024) throw new IOException("Font archive exceeds size bound");
                Files.createDirectories(target.getParent());
                Files.write(target, bytes);
            }
        }
        if (!names.contains("media/fonts/EN/fonts.txt") || !names.contains("media/shaders/sdf.vert")
                || !names.contains("media/shaders/sdf.frag") || !names.contains("media/texturepacks/UI.pack"))
            throw new IOException("Original font definitions or SDF shaders missing");
        mounted = true;
    }

    private static boolean allowed(String name) {
        return (name.startsWith("media/fonts/")
                && (name.endsWith(".fnt") || name.endsWith(".png") || name.endsWith(".txt")))
                || name.matches("media/[A-Za-z0-9_.-]+\\.(?:fnt|png)")
                || name.equals("media/texturepacks/UI.pack")
                || Set.of("media/shaders/default.vert", "media/shaders/default.frag",
                        "media/shaders/sdf.vert", "media/shaders/sdf.frag").contains(name);
    }

    /** Call before original UIManager.init; font choice and measurements remain original. */
    public static void initialize() throws Exception {
        if (!mounted || ownsFonts) throw new IllegalStateException("Unexpected font bootstrap lifecycle");
        if (GameWindow.assetManagers.get(TextureID.ASSET_TYPE) == null)
            TextureIDAssetManager.instance.create(TextureID.ASSET_TYPE, GameWindow.assetManagers);
        if (GameWindow.assetManagers.get(Texture.ASSET_TYPE) == null)
            TextureAssetManager.instance.create(Texture.ASSET_TYPE, GameWindow.assetManagers);
        GameWindow.fileSystem.mountTexturePack("UI", GameWindow.texturePackTextures, 2);
        if (!GameWindow.texturePackTextures.containsKey("mainfont_0")
                || !GameWindow.texturePackTextures.containsKey("mainfont2_0"))
            throw new AssertionError("Original UI font atlas is incomplete");
        ownsFonts = true;
        TextManager.instance.Init();
        long deadline = System.currentTimeMillis() + 30000;
        while (TextManager.instance.isAnyFontLoading() && System.currentTimeMillis() < deadline) {
            GameWindow.fileSystem.updateAsyncTransactions();
            Thread.sleep(1);
        }
        if (TextManager.instance.isAnyFontLoading()) throw new AssertionError("Original font loading timed out");
        int mapped = 0;
        StringBuilder lookups = new StringBuilder("[");
        for (UIFont name : UIFont.values()) {
            AngelCodeFont font = TextManager.instance.getFontFromEnum(name);
            int height = TextManager.instance.getFontHeight(name);
            int width = TextManager.instance.MeasureStringX(name, "Project Zomboid 123");
            if (font == null || height <= 0 || width <= 0 || font.chars == null
                    || font.chars.length <= 'P' || font.chars['P'] == null
                    || font.chars['P'].image == null || !font.chars['P'].image.isReady())
                throw new AssertionError("Original font not ready: " + name);
            boolean direct = TextManager.instance.enumToFont[name.ordinal()] != null;
            if (direct) mapped++;
            if (lookups.length() > 1) lookups.append(',');
            lookups.append("{\"font\":\"").append(name).append("\",\"mapped\":").append(direct)
                    .append(",\"height\":").append(height).append(",\"width\":").append(width).append('}');
        }
        if (mapped != 30 || UIFont.values().length != 34)
            throw new AssertionError("Original font enumeration differs from qualified scope");
        var sdf = TextManager.sdfShader;
        if (sdf == null || sdf.getID() == 0 || !sdf.isCompiled())
            throw new AssertionError("Original SDF font shader unavailable");
        qualification = "{\"mapped\":" + mapped + ",\"sdfShaderId\":" + sdf.getID()
                + ",\"sdfCompiled\":true,\"lookups\":" + lookups.append(']') + "}";
    }

    public static String snapshot() {
        if (qualification == null) throw new IllegalStateException("Original fonts not qualified");
        return qualification;
    }

    /** The owning game loop has stopped before these original font objects are released. */
    public static void close() {
        if (!ownsFonts) return;
        Set<AngelCodeFont> unique = Collections.newSetFromMap(new IdentityHashMap<>());
        for (AngelCodeFont font : TextManager.instance.enumToFont)
            if (font != null && unique.add(font)) font.destroy();
        for (AngelCodeFont font : TextManager.instance.normal)
            if (font != null && unique.add(font)) font.destroy();
        if (TextManager.sdfShader != null) TextManager.sdfShader.destroy();
        ownsFonts = false;
    }
}
