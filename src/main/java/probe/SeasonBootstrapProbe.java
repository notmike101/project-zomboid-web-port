package probe;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import port.runtime.BrowserAssets;
import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaThread;
import zombie.Lua.KahluaNumberConverter;
import zombie.Lua.LuaManager;
import zombie.SandboxOptions;
import zombie.ZomboidFileSystem;

/** Browser-only season lifecycle with a deliberately partial LuaManager bootstrap.
 * This does not call or qualify LuaManager.init/exposeAll. Original installed
 * scripts and original SandboxOptions/ErosionSeason implementations do the work.
 */
public final class SeasonBootstrapProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        ZomboidFileSystem.instance.init();
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[");
        appendAsset(json, new File("/stdlib.lua"), "/stdlib.lua");
        String[] paths = {"lua/shared/defines.lua", "lua/shared/Sandbox/Apocalypse.lua"};
        File[] scripts = new File[paths.length];
        for (int i = 0; i < paths.length; i++) {
            File script = ZomboidFileSystem.instance.getMediaFile(paths[i]);
            byte[] bytes;
            try (FileInputStream input = new FileInputStream(script)) { bytes = input.readAllBytes(); }
            if (!script.isFile() || script.canWrite() || bytes.length == 0
                    || bytes.length != script.length()
                    || Arrays.hashCode(bytes) != BrowserAssets.contentHash(script.getCanonicalPath())
                    || !new File(ZomboidFileSystem.instance.getString("media/" + paths[i]))
                            .getCanonicalFile().equals(script.getCanonicalFile()))
                throw new AssertionError("Original season script mount/index differs: " + paths[i]);
            scripts[i] = script;
            json.append(',');
            appendAsset(json, script, "/media/" + paths[i]);
        }

        // LuaManager.<clinit> supplies its real platform, converter manager,
        // caller and load caches. RunLuaInternal additionally needs the standard
        // environment and owned execution thread established here, matching
        // init offsets 76..121 and 140..146. No exposed Java APIs are needed by
        // the two selected data-only scripts; full init/exposure is separate.
        if (LuaManager.env != null || LuaManager.thread != null || !LuaManager.loaded.isEmpty())
            throw new AssertionError("Partial Lua bootstrap requires a fresh runtime");
        LuaManager.env = LuaManager.platform.newEnvironment();
        LuaManager.thread = new KahluaThread(LuaManager.platform, LuaManager.env);
        LuaManager.thread.debugOwnerThread = Thread.currentThread();
        KahluaNumberConverter.install(LuaManager.converterManager);

        SandboxOptions options = SandboxOptions.instance;
        if (options != SandboxOptions.getInstance() || options.dayNightCycle.getValue() != 1
                || options.climateCycle.getValue() != 1 || options.zombies.getValue() != 4
                || options.dayLength.getValue() != 4 || options.startMonth.getValue() != 7
                || options.startDay.getValue() != 9)
            throw new AssertionError("Original Apocalypse sandbox values differ");
        Object globals = LuaManager.env.rawget("ZomboidGlobals");
        if (!(globals instanceof KahluaTable)
                || !Double.valueOf(0.6).equals(((KahluaTable) globals).rawget("FoodLootModifier")))
            throw new AssertionError("Original defines.lua did not populate its globals");
        for (File script : scripts) {
            String path = script.getAbsolutePath().replace('\\', '/');
            if (!LuaManager.loaded.contains(path))
                throw new AssertionError("Original RunLua did not record script: " + path);
        }
        String apocalypse = scripts[1].getAbsolutePath().replace('\\', '/');
        if (!(LuaManager.loadedReturn.get(apocalypse) instanceof KahluaTable))
            throw new AssertionError("Original Apocalypse script did not return its table");

        json.append(',');
        SeasonRuntimeProbe.appendCases(json);
        System.out.println(json.append("],\"pass\":true}"));
    }

    private static void appendAsset(StringBuilder json, File file, String id) throws Exception {
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(file)) { bytes = input.readAllBytes(); }
        int hash = Arrays.hashCode(bytes);
        if (!file.isFile() || file.canWrite() || bytes.length == 0 || bytes.length != file.length()
                || hash != BrowserAssets.contentHash(id)) throw new AssertionError("Asset bytes differ: " + id);
        json.append("{\"id\":\"").append(id).append("\",\"inputs\":[],\"outputs\":{");
        integer(json, "size", bytes.length); json.append(',');
        integer(json, "contentHash", hash); json.append("}}");
    }

    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
