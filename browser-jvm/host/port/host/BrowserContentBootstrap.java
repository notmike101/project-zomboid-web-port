package port.host;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import zombie.Lua.LuaEventManager;
import zombie.Lua.LuaManager;
import zombie.ZomboidGlobals;
import zombie.inventory.ItemPickerJava;
import zombie.scripting.ScriptManager;

/** Loads genuine vanilla definitions before models, then their original loot distributions. */
public final class BrowserContentBootstrap {
    private static final String[] DISTRIBUTION_SOURCES = {
        "shared/ISBaseObject.lua",
        "shared/TimedActions/ISBaseTimedAction.lua",
        "shared/TimedActions/ISClothingExtraAction.lua",
        "shared/Fishing/FishingZones.lua",
        "server/Items/AcceptItemFunction.lua",
        "server/Items/Distribution_BagsAndContainers.lua",
        "server/Items/Distribution_BinJunk.lua",
        "server/Items/Distribution_ClosetJunk.lua",
        "server/Items/Distribution_CounterJunk.lua",
        "server/Items/Distribution_DeskJunk.lua",
        "server/Items/Distribution_ShelfJunk.lua",
        "server/Items/Distribution_SideTableJunk.lua",
        "server/Vehicles/VehicleDistribution_GloveBoxJunk.lua",
        "server/Vehicles/VehicleDistribution_SeatJunk.lua",
        "server/Vehicles/VehicleDistribution_TrunkJunk.lua",
        "server/Items/Distributions.lua",
        "server/Items/ProceduralDistributions.lua",
        "server/Items/SuburbsDistributions.lua",
        "server/Vehicles/VehicleDistributions.lua",
        "shared/VehicleZoneDefinition.lua"
    };

    private BrowserContentBootstrap() { }

    /** Mount before ZFS scans; the archive contains definitions, never installed saves. */
    public static void mountAssets() throws IOException {
        Path work = Path.of("/files/work");
        int entries = 0;
        long total = 0;
        Set<String> names = new HashSet<>();
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream("/app/content-assets.jar"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (entry.isDirectory()) continue;
                if (!names.add(name)) throw new IOException("Duplicate content archive entry: " + name);
                if (!(name.startsWith("media/scripts/") && name.endsWith(".txt"))
                        && !(name.startsWith("media/clothing/") && name.endsWith(".xml"))
                        && !isDistributionSource(name)) {
                    throw new IOException("Unexpected content archive entry: " + name);
                }
                if (++entries > 4000) throw new IOException("Too many content archive entries");
                Path target = work.resolve(name).normalize();
                if (!target.startsWith(work.resolve("media/scripts"))
                        && !target.startsWith(work.resolve("media/clothing")) && !isDistributionSource(name))
                    throw new IOException("Content escapes its allowed browser directory");
                byte[] bytes = zip.readNBytes(32 * 1024 * 1024 + 1);
                total += bytes.length;
                if (total > 32L * 1024 * 1024) throw new IOException("Content archive exceeds size bound");
                Files.createDirectories(target.getParent());
                Files.write(target, bytes);
            }
        }
        if (entries == 0) throw new IOException("Empty content archive");
    }

    /** Call once after normal platform/Lua setup and before creating original model assets. */
    public static void loadDefinitions() throws Exception {
        zombie.ZomboidFileSystem.instance.init();
        if (LuaManager.env == null || LuaManager.thread == null) {
            throw new IllegalStateException("Original LuaManager must be initialized first");
        }
        // Same definition prerequisites as GameWindow.initShared, before ScriptManager.Load.
        zombie.characters.skills.PerkFactory.init();
        zombie.characters.skills.CustomPerks.instance.init();
        zombie.characters.skills.CustomPerks.instance.initLua();
        zombie.sandbox.CustomSandboxOptions.instance.init();
        zombie.sandbox.CustomSandboxOptions.instance.initInstance(zombie.SandboxOptions.instance);
        zombie.scripting.objects.ModRegistries.init();
        ScriptManager.instance.Load();
        if (ScriptManager.instance.getAllItems().isEmpty()
                || ScriptManager.instance.getAllVehicleScripts().isEmpty()) {
            throw new AssertionError("Original vanilla item/vehicle definitions missing");
        }
    }

    /** Runs real data chunks and the original IsoWorld loot-merge and parser lifecycle. */
    public static void loadDistributions() throws Exception {
        if (LuaManager.env == null || LuaManager.thread == null) {
            throw new IllegalStateException("Original LuaManager must be initialized first");
        }
        List<String> errors = new ArrayList<>();
        LuaManager.LoadDirBase("shared", true);
        Handler failures = new Handler() {
            @Override public void publish(LogRecord record) {
                if (record.getLevel().intValue() >= Level.SEVERE.intValue()) {
                    errors.add(record.getMessage());
                }
            }
            @Override public void flush() { /* Observation only; owns no stream. */ }
            @Override public void close() { /* Observation only; owns no stream. */ }
        };
        Logger compiler = Logger.getLogger(LuaManager.class.getName());
        Logger execution = Logger.getLogger(zombie.iso.IsoWorld.class.getName());
        compiler.addHandler(failures);
        execution.addHandler(failures);
        try {
            for (String source : DISTRIBUTION_SOURCES) {
                String path = "/files/work/media/lua/" + source;
                if (!Files.isRegularFile(Path.of(path))) throw new IOException("Missing original Lua: " + path);
                LuaManager.RunLua(path);
                if (!errors.isEmpty()) {
                    throw new IllegalStateException("Original distribution Lua failed: " + source + ": " + errors);
                }
            }
        } finally {
            compiler.removeHandler(failures);
            execution.removeHandler(failures);
        }
        if (!(LuaManager.env.rawget("copyClothingItem") instanceof se.krka.kahlua.vm.LuaClosure)
                || !(LuaManager.env.rawget("Fishing") instanceof se.krka.kahlua.vm.KahluaTable fishing)
                || !(fishing.rawget("NoFishZones") instanceof se.krka.kahlua.vm.KahluaTable zones)
                || zones.isEmpty()) {
            throw new AssertionError("Original clothing-copy function or fishing-zone data missing");
        }
        LuaEventManager.triggerEvent("OnPreDistributionMerge");
        LuaEventManager.triggerEvent("OnDistributionMerge");
        LuaEventManager.triggerEvent("OnPostDistributionMerge");
        ItemPickerJava.Parse();
        ZomboidGlobals.toLua();
        ItemPickerJava.InitSandboxLootSettings();
        if (ItemPickerJava.rooms.isEmpty() || ItemPickerJava.ProceduralDistributions.isEmpty()
                || ItemPickerJava.VehicleDistributions.isEmpty()) {
            throw new AssertionError("Original parsed loot distribution maps missing");
        }
    }

    private static boolean isDistributionSource(String name) {
        for (String source : DISTRIBUTION_SOURCES) {
            if (name.equals("media/lua/" + source)) return true;
        }
        return false;
    }
}
