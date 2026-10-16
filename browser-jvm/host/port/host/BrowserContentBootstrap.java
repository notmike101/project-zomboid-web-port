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

/** Loads genuine vanilla definitions and complete shared/client Lua before models and world creation. */
public final class BrowserContentBootstrap {
    private static int sharedLuaFiles;
    private static int sharedLuaErrors;
    private static int clientLuaFiles;
    private static int clientLuaErrors;
    private static int serverLuaFiles;
    private static int serverLuaErrors;
    private static boolean clientMounted;
    private static boolean gameBootCompleted;
    private static boolean afterLuaCompleted;

    private BrowserContentBootstrap() { }

    public static int getSharedLuaFiles() { return sharedLuaFiles; }
    public static int getSharedLuaErrors() { return sharedLuaErrors; }
    public static int getClientLuaFiles() { return clientLuaFiles; }
    public static int getClientLuaErrors() { return clientLuaErrors; }
    public static int getServerLuaFiles() { return serverLuaFiles; }
    public static int getServerLuaErrors() { return serverLuaErrors; }

    /** Original GameLoadingState's offline Lua/checksum/post-Lua phase, before world creation. */
    public static void loadServerLua() throws Exception {
        if (!gameBootCompleted || afterLuaCompleted || zombie.network.GameClient.client || zombie.network.GameServer.server)
            throw new IllegalStateException("Expected original offline post-boot server-Lua phase");
        loadLuaDirectory("server", 294);
        LuaManager.finishChecksum();
        ScriptManager.instance.LoadedAfterLua();
        if (ScriptManager.instance.hasLoadErrors())
            throw new IllegalStateException("Original LoadedAfterLua recorded load errors");
        if (ScriptManager.instance.getAllGameEntities().size() != 219
                || ScriptManager.instance.getAllCraftRecipes().size() != 969)
            throw new AssertionError("Original entity/craft-recipe definitions differ from qualified scope");
        afterLuaCompleted = true;
    }

    /** Original GameWindow.enter delivers this event after ModelManager.create, before world creation. */
    public static void gameBoot() {
        if (gameBootCompleted || clientLuaFiles != 727 || !zombie.core.skinnedmodel.ModelManager.instance.isCreated())
            throw new IllegalStateException("Unexpected original game-boot lifecycle");
        LuaEventManager.triggerEvent("OnGameBoot");
        if (zombie.characters.SurvivorDesc.HairCommonColors.size() != 20
                || zombie.characters.SurvivorDesc.TrouserCommonColors.size() != 11
                || zombie.characters.SurvivorFactory.Surnames.size() != 3799
                || zombie.characters.SurvivorFactory.FemaleForenames.size() != 1320
                || zombie.characters.SurvivorFactory.MaleForenames.size() != 993)
            throw new AssertionError("Original game-boot character data differs from qualified scope");
        gameBootCompleted = true;
    }

    public static String bootSnapshot() {
        if (!gameBootCompleted) throw new IllegalStateException("Original game-boot phase is incomplete");
        return "{\"gameBootCompleted\":true,\"hairColors\":" + zombie.characters.SurvivorDesc.HairCommonColors.size()
                + ",\"trouserColors\":" + zombie.characters.SurvivorDesc.TrouserCommonColors.size()
                + ",\"surnames\":" + zombie.characters.SurvivorFactory.Surnames.size()
                + ",\"femaleNames\":" + zombie.characters.SurvivorFactory.FemaleForenames.size()
                + ",\"maleNames\":" + zombie.characters.SurvivorFactory.MaleForenames.size()
                + ",\"loadedAfterLuaCompleted\":" + afterLuaCompleted
                + ",\"scriptLoadErrors\":" + ScriptManager.instance.hasLoadErrors()
                + ",\"entities\":" + ScriptManager.instance.getAllGameEntities().size()
                + ",\"craftRecipes\":" + ScriptManager.instance.getAllCraftRecipes().size() + "}";
    }

    /** Mount real client/UI/translation inputs before the first ZFS scan. */
    public static void mountClientAssets() throws IOException {
        if (clientMounted) throw new IllegalStateException("Client assets already mounted");
        Path work = Path.of("/files/work");
        Set<String> names = new HashSet<>();
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream("/app/client-assets.jar"))) {
            for (ZipEntry entry; (entry = zip.getNextEntry()) != null;) {
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (!names.add(name) || names.size() > 3000 || !isClientAsset(name))
                    throw new IOException("Unexpected or duplicate client archive entry: " + name);
                Path target = work.resolve(name).normalize();
                if (!target.startsWith(work.resolve("media"))
                        || !work.relativize(target).toString().replace('\\', '/').equals(name))
                    throw new IOException("Noncanonical client archive entry: " + name);
                byte[] bytes = zip.readNBytes(64 * 1024 * 1024 + 1);
                total += bytes.length;
                if (total > 64L * 1024 * 1024) throw new IOException("Client archive exceeds size bound");
                Files.createDirectories(target.getParent());
                Files.write(target, bytes);
            }
        }
        if (names.stream().filter(name -> name.startsWith("media/lua/client/") && name.endsWith(".lua")).count() != 727)
            throw new IOException("Expected complete 727-source original client archive");
        clientMounted = true;
    }

    private static boolean isClientAsset(String name) {
        return (name.startsWith("media/lua/client/") && (name.endsWith(".lua") || name.endsWith(".png")))
                || (name.startsWith("media/ui/") && name.endsWith(".png"))
                || (name.startsWith("media/lua/shared/Translate/EN/")
                        && (name.endsWith(".json") || name.endsWith(".tbx")));
    }

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
                        && !isServerSource(name) && !isSharedSource(name)) {
                    throw new IOException("Unexpected content archive entry: " + name);
                }
                if (++entries > 4000) throw new IOException("Too many content archive entries");
                Path target = work.resolve(name).normalize();
                if (!target.startsWith(work) || !work.relativize(target).toString().replace('\\', '/').equals(name)) {
                    throw new IOException("Noncanonical content archive entry: " + name);
                }
                if (!target.startsWith(work.resolve("media/scripts"))
                        && !target.startsWith(work.resolve("media/clothing"))
                        && !(isServerSource(name) && target.startsWith(work.resolve("media/lua/server")))
                        && !(isSharedSource(name) && target.startsWith(work.resolve("media/lua/shared"))))
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
        if (!clientMounted) throw new IllegalStateException("Original client assets must be mounted first");
        // Client top-level constructors use original translations and loaded font metrics.
        zombie.core.Languages.instance.init();
        zombie.core.Translator.loadFiles();
        BrowserFontBootstrap.initialize();
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
        if (ScriptManager.instance.hasLoadErrors()) {
            throw new IllegalStateException("Original script definitions have load errors");
        }
        loadLuaDirectory("shared", 374);
        loadLuaDirectory("client", 727);
    }

    /** Preserves the original directory order and RunLua cache after all script definitions exist. */
    private static void loadLuaDirectory(String directory, int expected) throws Exception {
        List<String> errors = new ArrayList<>();
        Handler failures = new Handler() {
            @Override public void publish(LogRecord record) {
                if (record.getLevel().intValue() >= Level.SEVERE.intValue()) {
                    String message = record.getMessage();
                    if (record.getParameters() != null) {
                        message += " " + java.util.Arrays.toString(record.getParameters());
                    }
                    errors.add(message);
                }
            }
            @Override public void flush() { /* Observation only; owns no stream. */ }
            @Override public void close() { /* Observation only; owns no stream. */ }
        };
        Logger compiler = Logger.getLogger(LuaManager.class.getName());
        compiler.addHandler(failures);
        try {
            LuaManager.LoadDirBase(directory);
        } finally {
            compiler.removeHandler(failures);
            int loaded = (int) LuaManager.loaded.stream()
                    .filter(name -> name.replace('\\', '/').contains("/media/lua/" + directory + "/")).distinct().count();
            if (directory.equals("shared")) {
                sharedLuaErrors = errors.size();
                sharedLuaFiles = loaded;
            } else if (directory.equals("client")) {
                clientLuaErrors = errors.size();
                clientLuaFiles = loaded;
            } else {
                serverLuaErrors = errors.size();
                serverLuaFiles = loaded;
            }
        }
        if (!errors.isEmpty()) {
            throw new IllegalStateException("Original " + directory + " Lua failed: " + errors);
        }
        int loaded = directory.equals("shared") ? sharedLuaFiles
                : directory.equals("client") ? clientLuaFiles : serverLuaFiles;
        if (loaded != expected) {
            throw new IllegalStateException("Expected " + expected + " original " + directory + " Lua sources, loaded " + loaded);
        }
    }

    /** Runs real data chunks and the original IsoWorld loot-merge and parser lifecycle. */
    public static void loadDistributions() throws Exception {
        if (LuaManager.env == null || LuaManager.thread == null) {
            throw new IllegalStateException("Original LuaManager must be initialized first");
        }
        if (!afterLuaCompleted || serverLuaFiles != 294)
            throw new IllegalStateException("Complete original server Lua must precede loot merging");
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

    private static boolean isSharedSource(String name) {
        return name.startsWith("media/lua/shared/") && name.endsWith(".lua");
    }

    private static boolean isServerSource(String name) {
        return name.startsWith("media/lua/server/") && name.endsWith(".lua");
    }
}
