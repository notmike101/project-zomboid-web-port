import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import zombie.GameWindow;
import zombie.ZomboidFileSystem;
import zombie.core.Core;
import zombie.iso.IsoLot;
import zombie.iso.IsoWorld;
import zombie.iso.worldgen.WorldGenParams;

/** Derives real density input using original Java metadata algorithms, never native zombie answers. */
public final class PopulationInputs {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]).toRealPath();
        PopulationQualification.root = root;
        PopulationQualification.check(Path.of(System.getProperty("user.dir")).toRealPath()
                .equals(root.resolve("work")), "owned input preparation cwd");
        Throwable failure = null;
        boolean metadata = false;
        int errors = PopulationQualification.errors();
        try {
            zombie.core.random.RandStandard.INSTANCE.init();
            zombie.core.random.RandLua.INSTANCE.init();
            var fs = ZomboidFileSystem.instance;
            fs.setCacheDir(root.resolve("home/Zomboid").toString());
            Core.gameSaveWorld = "PopulationInputs";
            fs.init();
            Path save = Path.of(fs.getCurrentSaveDir()).toAbsolutePath().normalize();
            PopulationQualification.check(save.startsWith(root), "owned metadata prerequisite save");
            Files.createDirectories(save);
            zombie.savefile.SavefileNaming.ensureSubdirectoriesExist(save.toString());
            zombie.Lua.LuaManager.init();
            zombie.debug.DebugLog.getInstance().setStdOut(System.out);
            zombie.debug.DebugLog.getInstance().setStdErr(System.err);
            zombie.GameTime.getInstance().init();
            PopulationQualification.check(zombie.GameTime.getInstance().getWorldAgeHours() == 2,
                    "actual initial original GameTime");
            zombie.Lua.LuaManager.LoadDirBase("server", true);
            for (String name : new String[] {"WorldGen/WorldGen.lua", "metazones/BiomeMapConfig.lua",
                    "metazones/AnimalsPathConfig.lua", "Zombies/VoronoiNoise.lua",
                    "WorldGen/prefabs/highway_NS_00.lua", "WorldGen/prefabs/normal_road_WE_00.lua"}) {
                zombie.Lua.LuaManager.RunLua(root.resolve("work/media/lua/server/" + name).toString());
            }
            PopulationQualification.names(false);
            var params = WorldGenParams.INSTANCE;
            PopulationQualification.check(params.getSeed() == 0 && params.getMinXCell() == -250
                    && params.getMinYCell() == -250 && params.getMaxXCell() == 250
                    && params.getMaxYCell() == 250, "untouched original constructor inputs");
            IsoWorld.instance.setMap("Muldraugh, KY");
            var grid = IsoWorld.instance.getMetaGrid();
            metadata = true;
            grid.Create();
            PopulationQualification.check(grid.getWidth() == 501 && grid.getHeight() == 501
                    && IsoLot.InfoHeaderNames.size() == 4065, "genuine complete original metadata owner");
            var header = IsoLot.MapFiles.get(0).infoHeaders.get("41_40.lotheader");
            PopulationQualification.check(header != null, "actual selected original header");
            byte[] density = new byte[1024];
            for (int y = 0; y < 32; y++) {
                for (int x = 0; x < 32; x++) {
                    density[x + y * 32] = (byte) Math.max(0,
                            zombie.iso.LotHeader.getZombieIntensityForChunk(header, x, y));
                }
            }
            PopulationQualification.check(density[21 + 19 * 32] > 0, "actual selected density is positive");
            Files.write(root.resolve("original-density.bin"), density);
            PopulationQualification.check(PopulationQualification.errors() == errors,
                    "no caught original metadata errors");
        } catch (Throwable error) {
            failure = error;
            error.printStackTrace();
        } finally {
            try {
                if (metadata) IsoWorld.instance.getMetaGrid().Dispose();
                var executor = (ExecutorService) PopulationQualification.field(GameWindow.fileSystem, "executor");
                executor.shutdown();
                PopulationQualification.check(executor.awaitTermination(2, TimeUnit.SECONDS),
                        "original input-preparation executor terminated");
            } catch (Throwable cleanup) {
                if (failure == null) failure = cleanup;
                else failure.addSuppressed(cleanup);
            }
        }
        if (failure != null) throw new RuntimeException(failure);
        System.out.println("POPULATION_INPUTS_PASS originalHeaders=4065 densityBytes=1024 constructorSeed=0");
    }
}
