package probe;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import java.util.Locale;
import port.runtime.BrowserAssets;
import zombie.ZomboidFileSystem;
import zombie.core.Core;

/** Browser-only original filesystem initialization over two selected immutable assets. */
public final class FilesystemRuntimeProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        ZomboidFileSystem filesystem = ZomboidFileSystem.instance;
        if (Core.currentTextEntryBox != null) throw new AssertionError("Unexpected initial text-entry state");
        filesystem.init();
        if (Core.currentTextEntryBox != null || Core.getInstance().isDoingTextEntry()
                || Core.getInstance().getScreenWidth() != 1280 || Core.getInstance().getScreenHeight() != 720)
            throw new AssertionError("Original initialization changed expected default Core state");
        File media = new File("media").getCanonicalFile();
        if (!new File(filesystem.getAbsoluteWorkDir()).getCanonicalFile().equals(media)
                || !filesystem.getLocalWorkDir().replace('\\', '/').equals("media"))
            throw new AssertionError("Original filesystem folder initialization differs");
        String missing = "media/lua/shared/codex_missing_6f029ebe_8ae4_493c_ba01_4feaf36b5675.lua";
        if (!filesystem.getString(missing).equals(missing) || filesystem.isKnownFile(missing))
            throw new AssertionError("Missing file unexpectedly indexed");
        String[] selected = {"lua/shared/ISBaseObject.lua", "lua/shared/Util/LuaTableUtil.lua"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[");
        for (int i = 0; i < selected.length; i++) {
            String relative = "media/" + selected[i];
            File original = filesystem.getMediaFile(selected[i]);
            File expected = new File(media, selected[i]).getCanonicalFile();
            String indexed = filesystem.getString(relative);
            String indexedUpper = filesystem.getString(relative.toUpperCase(Locale.ENGLISH));
            String normalized = filesystem.getRelativeFile(original).replace('\\', '/');
            if (!original.isFile() || original.canWrite() || !original.getCanonicalFile().equals(expected)
                    || !new File(indexed).isAbsolute() || !new File(indexed).getCanonicalFile().equals(expected)
                    || !indexedUpper.equals(indexed) || !normalized.equals(relative.toLowerCase(Locale.ENGLISH))
                    || !filesystem.isKnownFile(relative) || !filesystem.isKnownFile(indexed))
                throw new AssertionError("Original selected-file index differs: " + relative);
            byte[] contents;
            try (FileInputStream input = new FileInputStream(indexed)) { contents = input.readAllBytes(); }
            int hash = Arrays.hashCode(contents);
            if (contents.length == 0 || contents.length != original.length()
                    || hash != BrowserAssets.contentHash(expected.getPath()))
                throw new AssertionError("Indexed file bytes differ from verified mount");
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append("/media/" + selected[i])
                    .append("\",\"inputs\":[],\"outputs\":{");
            output(json, "size", contents.length); json.append(',');
            output(json, "contentHash", hash); json.append(',');
            output(json, "indexFlags", 31);
            json.append("}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }

    private static void output(StringBuilder json, String name, int value) {
        String bits = Integer.toHexString(value);
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
