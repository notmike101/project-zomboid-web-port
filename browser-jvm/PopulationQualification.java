import java.lang.reflect.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import zombie.GameWindow;
import zombie.MapCollisionData;
import zombie.ZomboidFileSystem;
import zombie.core.Core;
import zombie.iso.IsoCell;
import zombie.iso.IsoWorld;
import zombie.popman.ZombiePopulationManager;

/** Data-only original DLL save/reopen oracle. No original game/server main. */
public final class PopulationQualification {
  static native int progress(int kind);

  static void stage(String value) {
    System.out.println("POPULATION_STAGE " + value);
  }

  static void file(String name, String value) {
    // Keep each authored transport frame below CheerpJ's console chunk boundary.
    for (int offset = 0; offset < value.length(); offset += 2048) {
      int end = Math.min(offset + 2048, value.length());
      System.out.println(
          "POPULATION_FILE "
              + name
              + " "
              + offset
              + " "
              + value.length()
              + " "
              + value.substring(offset, end));
    }
  }

  static final Class<?> M = MapCollisionData.class, P = ZombiePopulationManager.class;
  static final Class<?>[] NONE = {};
  static int assertions;
  static Path root, save;
  static boolean started, pop, mcd, worldCreated, browser;
  static Thread worker;

  record R(float x, float y, byte z, byte direction, int state, int outfit, int id) {}

  static void check(boolean v, String label) {
    if (!v) throw new AssertionError(label);
    assertions++;
  }

  static Object call(Class<?> c, String name, Class<?>[] types, Object... args) throws Exception {
    Method method = c.getDeclaredMethod(name, types);
    method.setAccessible(true);
    try {
      return method.invoke(null, args);
    } catch (InvocationTargetException e) {
      throw new RuntimeException(name, e.getCause());
    }
  }

  static Object field(Object o, String name) throws Exception {
    Field f = o.getClass().getDeclaredField(name);
    f.setAccessible(true);
    return f.get(o);
  }

  static int errors() throws Exception {
    Field f = zombie.core.logger.ExceptionLogger.class.getDeclaredField("exceptionCount");
    f.setAccessible(true);
    return f.getInt(null);
  }

  static void set(String name, String value) throws Exception {
    StringState.set(name, value);
  }

  static final class StringState {
    private static java.lang.invoke.MethodHandle setter;

    static synchronized void set(String name, String value) throws Exception {
      try {
        if (setter == null)
          setter =
              java.lang.invoke.MethodHandles.privateLookupIn(
                      M, java.lang.invoke.MethodHandles.lookup())
                  .findStatic(
                      M,
                      "n_setGameState",
                      java.lang.invoke.MethodType.methodType(
                          void.class, String.class, String.class));
        setter.invokeExact(name, value);
      } catch (Throwable error) {
        if (error instanceof Exception exception) throw exception;
        if (error instanceof Error failure) throw failure;
        throw new AssertionError(error);
      }
    }
  }

  static void bounded(String label, Action action) throws Exception {
    AtomicReference<Throwable> error = new AtomicReference<>();
    Thread t =
        new Thread(
            () -> {
              try {
                action.run();
              } catch (Throwable e) {
                error.set(e);
              }
            },
            label);
    t.setDaemon(true);
    t.start();
    t.join(5000);
    if (t.isAlive()) {
      System.err.println("OWNED_CALL_TIMEOUT " + label);
      throw new AssertionError(label + " exceeded5s");
    }
    if (error.get() != null) throw new RuntimeException(label, error.get());
    assertions++;
  }

  interface Action {
    void run() throws Exception;
  }

  static void barrier() throws Exception {
    if (!browser) {
      nativeBarrier();
      return;
    }
    int before = progress(0);
    call(P, "n_updateMain", new Class<?>[] {float.class, double.class}, 1f, age());
    call(P, "n_hasDataForThread", NONE);
    call(M, "n_hasDataForThread", NONE);
    MapCollisionData.instance.notifyThread();
    long until = System.nanoTime() + 5_000_000_000L;
    while (System.nanoTime() < until && (progress(0) <= before || progress(1) != 0))
      Thread.sleep(2);
    check(progress(0) > before && progress(1) == 0, "original worker drained actual native queues");
    call(P, "n_updateMain", new Class<?>[] {float.class, double.class}, 1f, age());
  }

  static void nativeBarrier() throws Exception {
    call(P, "n_updateMain", new Class<?>[] {float.class, double.class}, 1f, age());
    call(P, "n_requestRadarData", NONE);
    call(P, "n_hasDataForThread", NONE);
    MapCollisionData.instance.notifyThread();
    long until = System.nanoTime() + 5_000_000_000L;
    while (System.nanoTime() < until) {
      call(P, "n_updateMain", new Class<?>[] {float.class, double.class}, 1f, age());
      if ((boolean) call(P, "n_hasRadarData", NONE)) break;
      Thread.sleep(2);
    }
    check(
        (boolean) call(P, "n_hasRadarData", NONE), "original native worker completed queued batch");
    call(P, "n_getRadarZombieData", new Class<?>[] {float[].class}, new float[4096]);
  }

  static int register(float x, float y, byte dir, int outfit, int state, int id) throws Exception {
    return (int)
        call(
            P,
            "n_registerZombie",
            new Class<?>[] {
              float.class, float.class, float.class, byte.class, int.class, int.class, int.class
            },
            x,
            y,
            0f,
            dir,
            outfit,
            state,
            id);
  }

  static String[] names(boolean ignored) throws Exception {
    Path script =
        Path.of(System.getProperty("user.dir"))
            .resolve("media/lua/shared/NPCs/ZombiesZoneDefinition.lua");
    check(Files.isRegularFile(script), "actual owned original zombie-zone source mounted");
    zombie.Lua.LuaManager.RunLua(script.toString());
    check(
        zombie.Lua.LuaManager.env.rawget("ZombiesZoneDefinition") != null,
        "actual original zombie-zone table loaded");
    zombie.core.skinnedmodel.population.OutfitManager.init();
    zombie.PersistentOutfits.instance.init();
    String[] names =
        zombie.PersistentOutfits.instance.getOutfitNames().stream()
            .map(value -> value.toLowerCase(Locale.ENGLISH))
            .toArray(String[]::new);
    check(names.length == 609, "actual original persistent outfit names");
    return names;
  }

  static double age() {
    return zombie.GameTime.getInstance().getWorldAgeHours();
  }

  static void setup(boolean richer, boolean reopen) throws Exception {
    zombie.core.random.RandStandard.INSTANCE.init();
    zombie.core.random.RandLua.INSTANCE.init();
    var fs = ZomboidFileSystem.instance;
    fs.setCacheDir(root.resolve("home/Zomboid").toString());
    Core.gameSaveWorld = "PopulationOracle";
    fs.init();
    save = Path.of(fs.getCurrentSaveDir()).toAbsolutePath().normalize();
    check(save.startsWith(root), "actual ZFS save contained");
    zombie.savefile.SavefileNaming.ensureSubdirectoriesExist(save.toString());
    zombie.Lua.LuaManager.init();
    zombie.debug.DebugLog.getInstance().setStdOut(System.out);
    zombie.debug.DebugLog.getInstance().setStdErr(System.err);
    zombie.GameTime.getInstance().init();
    check(age() == 2d, "actual original initialized age2");
    check(
        !zombie.network.GameClient.client
            && !zombie.network.GameServer.server
            && !Core.getInstance().isNoSave(),
        "untouched offline/save-enabled role");
    ZombiePopulationManager.init();
    set("Core.GameMode", Core.getInstance().getGameMode());
    set("Core.GameSaveWorld", Core.gameSaveWorld);
    set("GameWindow.CacheDir", fs.getCacheDir());
    set("GameWindow.GameModeCacheDir", save.getParent() + java.io.File.separator);
    set("GameWindow.SaveDir", save.getParent().getParent().toString());
    set("SavefileNaming.SUBDIR_ZPOP", "zpop");
    set("SavefileNaming.SUBDIR_CHUNKDATA", "chunkdata");
    Class<?>[] bounds = {int.class, int.class, int.class, int.class};
    call(
        M,
        "n_setGameState",
        new Class<?>[] {String.class, int.class},
        "SandboxOptions.Distribution",
        zombie.SandboxOptions.instance.distribution.getValue());
    call(
        M,
        "n_setGameState",
        new Class<?>[] {String.class, int.class},
        "SandboxOptions.Zombies",
        zombie.SandboxOptions.instance.zombies.getValue());
    check(
        zombie.SandboxOptions.instance.distribution.getValue() == 1, "actual normal distribution1");

    call(M, "n_initMetaGrid", bounds, 41, 40, 2, 1);
    Path work = Path.of(System.getProperty("user.dir"));
    for (int cellX = 41; cellX <= 42; cellX++) {
      Path collision = work.resolve("media/maps/Muldraugh, KY/chunkdata_" + cellX + "_40.bin");
      call(
          M,
          "n_initMetaCell",
          new Class<?>[] {int.class, int.class, String.class},
          cellX,
          40,
          collision.toString());
      byte[] density = Files.readAllBytes(work.resolve("density_" + cellX + "_40.bin"));
      check(density.length == 1024, "actual adjacent density input length");
      for (int y = 0; y < 32; y++)
        for (int x = 0; x < 32; x++)
          call(
              M,
              "n_initMetaChunk",
              new Class<?>[] {int.class, int.class, int.class, int.class, int.class},
              cellX,
              40,
              x,
              y,
              density[x + y * 32] & 255);
    }
    call(M, "n_init", bounds, 41, 40, 2, 1);
    mcd = true;
    call(
        P,
        "n_init",
        new Class<?>[] {boolean.class, boolean.class, int.class, int.class, int.class, int.class},
        false,
        false,
        41,
        40,
        2,
        1);
    pop = true;
    ZombiePopulationManager.instance.onConfigReloaded();
    String[] outfits = names(richer);
    if (reopen && richer) {
      String t = outfits[0];
      outfits[0] = outfits[1];
      outfits[1] = t;
    }
    call(P, "n_setOutfitNames", new Class<?>[] {String[].class}, (Object) outfits);
    System.out.println("ACTUAL_OUTFIT_NAMES " + Arrays.toString(outfits));
    IsoWorld.instance.currentCell = new IsoCell(10, 10);
    worldCreated = true;
    IsoWorld.instance.currentCell.getChunkMap(0).setInitialPos(1344, 1299);
    ZombiePopulationManager.instance.updateLoadedAreas();
    zombie.popman.LoadedAreas actualAreas =
        (zombie.popman.LoadedAreas) field(ZombiePopulationManager.instance, "loadedAreas");
    System.out.println(
        "ORIGINAL_LOADED_AREAS "
            + Arrays.toString(Arrays.copyOf(actualAreas.areas, actualAreas.count * 4)));
    MapCollisionData.instance.start();
    MapCollisionData.instance.startGame();
    started = true;
    worker = (Thread) field(MapCollisionData.instance, "thread");
    check(worker.isAlive(), "genuine original MCDThread alive");
    barrier();
  }

  static void collision(int x, int y, byte value) throws Exception {
    byte[] flags = new byte[64];
    Arrays.fill(flags, value);
    call(M, "n_chunkUpdateTask", new Class<?>[] {int.class, int.class, byte[].class}, x, y, flags);
    call(M, "n_hasDataForThread", NONE);
    MapCollisionData.instance.notifyThread();
    barrier();
  }

  static Map<Integer, R> parse(Path file) throws Exception {
    ByteBuffer b = ByteBuffer.wrap(Files.readAllBytes(file));
    check(b.getShort() == 7, "actual v7 cell");
    int count = Short.toUnsignedInt(b.getShort());
    List<String> names = new ArrayList<>();
    for (int i = 0; i < count; i++) {
      byte[] text = new byte[Short.toUnsignedInt(b.getShort())];
      b.get(text);
      names.add(new String(text, java.nio.charset.StandardCharsets.UTF_8));
    }
    b.getFloat();
    b.getFloat();
    Map<Integer, R> records = new TreeMap<>();
    for (int chunk = 0; chunk < 1024; chunk++) {
      b.getShort();
      int total = Short.toUnsignedInt(b.getShort());
      for (int i = 0; i < total; i++) {
        R r =
            new R(b.getFloat(), b.getFloat(), b.get(), b.get(), b.getInt(), b.getInt(), b.getInt());
        check(records.put(r.id, r) == null, "unique saved ID");
      }
      b.getFloat();
      b.getFloat();
    }
    check(!b.hasRemaining(), "actual cell EOF");
    System.out.println(
        "ACTUAL_SAVED_CELL " + file.getFileName() + " names=" + names + " records=" + records);
    return records;
  }

  static void wireScalars(Path file) throws Exception {
    ByteBuffer bytes = ByteBuffer.wrap(Files.readAllBytes(file));
    check(bytes.getShort() == 7, "positive cell v7");
    int names = Short.toUnsignedInt(bytes.getShort());
    for (int i = 0; i < names; i++)
      bytes.position(bytes.position() + 2 + Short.toUnsignedInt(bytes.getShort(bytes.position())));
    float created = bytes.getFloat(), redistribution = bytes.getFloat();
    check(
        created == (float) age() && redistribution == (float) age(),
        "source initial cell timers equal actual age");
    int positive = 0, lastSeen = 0, total = 0;
    Set<Float> lastRespawn = new TreeSet<>();
    for (int i = 0; i < 1024; i++) {
      if (bytes.getShort() != 0) positive++;
      int n = Short.toUnsignedInt(bytes.getShort());
      total += n;
      bytes.position(bytes.position() + n * 22);
      float seen = bytes.getFloat();
      if (seen == (float) age()) lastSeen++;
      else check(seen == 0f, "unseen chunk timer starts0");
      lastRespawn.add(bytes.getFloat());
    }
    check(
        !bytes.hasRemaining() && positive > 0 && total > 0,
        "positive native file density/loaded-area/timers/records");
    check(lastRespawn.equals(Set.of((float) age())), "source initial chunk generation timers");
    System.out.println(
        "POSITIVE_SAVE_SCALARS names="
            + names
            + " cell="
            + created
            + ","
            + redistribution
            + " positiveChunks="
            + positive
            + " lastSeenAgeChunks="
            + lastSeen
            + " lastRespawn="
            + lastRespawn
            + " records="
            + total);
  }

  static Map<Integer, R> saved() throws Exception {
    Map<Integer, R> all = new TreeMap<>();
    int priorMax = 0;
    for (int cellX = 41; cellX <= 42; cellX++) {
      Path file = save.resolve("zpop/zpop_" + cellX + "_40.bin");
      Map<Integer, R> cell = parse(file);
      wireScalars(file);
      check(!cell.isEmpty(), "natural adjacent cell has records");
      int min = cell.keySet().stream().mapToInt(Integer::intValue).min().orElseThrow();
      int max = cell.keySet().stream().mapToInt(Integer::intValue).max().orElseThrow();
      check(
          min == priorMax + 1 && max - min + 1 == cell.size(),
          "row-major shared persistent ID allocation");
      priorMax = max;
      for (R r : cell.values()) {
        check(
            r.x >= cellX * 256 && r.x < (cellX + 1) * 256 && r.y >= 40 * 256 && r.y < 41 * 256,
            "record in original generating cell");
        check(all.put(r.id, r) == null, "IDs unique across adjacent cells");
      }
      long seam = cell.values().stream().filter(r -> Math.abs(r.x - 42 * 256) < 8).count();
      System.out.println(
          "ADJACENT_CELL cell="
              + cellX
              + ",40 records="
              + cell.size()
              + " minID="
              + min
              + " maxID="
              + max
              + " seamRecords="
              + seam);
    }
    return all;
  }

  static void writer(boolean ignored) throws Exception {
    check(worker.isAlive(), "original worker owns adjacent save");
    bounded("OriginalAdjacentSave", () -> MapCollisionData.instance.save());
    Map<Integer, R> before = saved();
    // Unchanged original LoadedAreas publishes no work. Public save owns completion.
    ZombiePopulationManager.instance.updateLoadedAreas();
    bounded("OriginalAdjacentRepeatedSave", () -> MapCollisionData.instance.save());
    check(before.equals(saved()), "same loaded areas/time do not regenerate or allocate IDs");
    System.out.println("ADJACENT_WRITER_PASS records=" + before.size() + " noInjectedRecords=true");
  }

  static List<R> output() throws Exception {
    int n = (int) call(P, "n_getAddZombieCount", NONE);
    ByteBuffer data = ByteBuffer.allocateDirect(Math.max(1, n) * 33);
    int copied =
        (int) call(P, "n_getAddZombieData", new Class<?>[] {int.class, ByteBuffer.class}, 0, data);
    check(copied == n, "native output complete");
    List<R> result = new ArrayList<>();
    for (int i = 0; i < n; i++) {
      float x = data.getFloat(), y = data.getFloat(), z = data.getFloat();
      byte d = data.get();
      int outfit = data.getInt(), state = data.getInt();
      data.getInt();
      data.getInt();
      int id = data.getInt();
      result.add(new R(x, y, (byte) z, d, state, outfit, id));
    }
    return result;
  }

  static void reader(boolean ignored) throws Exception {
    Map<Integer, R> expected = saved();
    Set<String> chunks = new LinkedHashSet<>();
    for (int cellX = 41; cellX <= 42; cellX++) {
      final int selectedX = cellX;
      R nearest =
          expected.values().stream()
              .filter(r -> (int) Math.floor(r.x / 256) == selectedX)
              .min(Comparator.comparingDouble(r -> Math.abs(r.x - 42 * 256)))
              .orElseThrow();
      chunks.add((int) Math.floor(nearest.x / 8) + "," + (int) Math.floor(nearest.y / 8));
    }
    for (String chunk : chunks) {
      String[] xy = chunk.split(",");
      call(
          P,
          "n_loadChunk",
          new Class<?>[] {int.class, int.class, boolean.class},
          Integer.parseInt(xy[0]),
          Integer.parseInt(xy[1]),
          true);
    }
    barrier();
    List<R> actual = output();
    List<R> selected =
        expected.values().stream()
            .filter(
                r -> chunks.contains((int) Math.floor(r.x / 8) + "," + (int) Math.floor(r.y / 8)))
            .toList();
    check(
        actual.size() == selected.size() && actual.size() >= 2,
        "natural adjacent-chunk publication count");
    for (R record : actual)
      check(
          record.equals(expected.get(record.id)),
          "exact adjacent natural publication survives reopen");
    int max = expected.keySet().stream().mapToInt(Integer::intValue).max().orElseThrow();
    R first = actual.get(0);
    int next = register(first.x, first.y, (byte) 0, 0, 5, 0);
    check(next == max + 1, "shared next persistent ID survives adjacent reopen");
    System.out.println(
        "ADJACENT_READER_PASS count="
            + actual.size()
            + " chunks="
            + chunks
            + " maxID="
            + max
            + " nextID="
            + next);
  }

  static void cleanup() throws Exception {
    if (started) {
      bounded("OriginalMCDStop", () -> MapCollisionData.instance.stop());
      started = false;
      worker.join(1000);
      check(!worker.isAlive(), "original MCDThread joined");
    }
    if (pop) {
      call(P, "n_stop", NONE);
      pop = false;
    }
    if (mcd) {
      call(M, "n_stop", NONE);
      mcd = false;
    }
    if (worldCreated) {
      var reuser = zombie.iso.WorldReuserThread.instance;
      bounded("OriginalWorldReuserStop", reuser::stop);
      Thread thread = (Thread) field(reuser, "worldReuser");
      thread.join(1000);
      check(!thread.isAlive(), "original reuser joined");
    }
    var executor = (java.util.concurrent.ExecutorService) field(GameWindow.fileSystem, "executor");
    executor.shutdown();
    check(
        executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS),
        "original executor terminated");
    System.out.println("ORIGINAL_CLEANUP_PASS");
  }

  public static void main(String[] args) throws Exception {
    browser = args[3].equals("browser");
    root = Path.of(args[0]).toAbsolutePath().normalize();
    Files.createDirectories(root);
    Path work = Path.of(System.getProperty("user.dir"));
    Files.createDirectories(work);
    if (browser)
      for (String name :
          new String[] {
            "stdlib.lua",
            "density_41_40.bin",
            "density_42_40.bin",
            "media/lua/shared/defines.lua",
            "media/lua/shared/Sandbox/Apocalypse.lua",
            "media/lua/shared/NPCs/ZombiesZoneDefinition.lua",
            "media/fileGuidTable.xml",
            "media/clothing/clothing.xml",
            "media/maps/Muldraugh, KY/chunkdata_41_40.bin",
            "media/maps/Muldraugh, KY/chunkdata_42_40.bin"
          }) {
        Path target = work.resolve(name);
        Files.createDirectories(target.getParent());
        Files.copy(Path.of("/app/" + name), target);
      }
    boolean richer = false, reopen = args[1].equals("read");
    Throwable failure = null;
    int errors = errors();
    try {
      if (browser && reopen)
        for (String name : args[2].split(",")) {
          Path dest = root.resolve("home/Zomboid/Saves/Sandbox/PopulationOracle/" + name);
          Files.createDirectories(dest.getParent());
          Files.copy(Path.of("/app/reopen/" + name), dest);
        }
      stage("before-original-setup");
      setup(richer, reopen);
      stage("original-worker-created-and-started");
      if (reopen) reader(richer);
      else writer(richer);
      if (!reopen)
        try (var files = Files.walk(save)) {
          for (Path path : files.filter(Files::isRegularFile).toList())
            file(
                save.relativize(path).toString().replace('\\', '/'),
                port.host.PopulationBuffers.byteHex(Files.readAllBytes(path)));
        }
    } catch (Throwable t) {
      failure = t;
      t.printStackTrace();
    } finally {
      try {
        cleanup();
        stage("original-cleanup-complete");
      } catch (Throwable t) {
        if (failure == null) failure = t;
        else failure.addSuppressed(t);
      }
    }
    check(errors() == errors, "original caught exception count unchanged");
    if (failure != null) throw new RuntimeException(failure);
    stage("complete");
    System.out.println(
        "POPULATION_SAVE_REOPEN_PASS case="
            + args[0]
            + " phase="
            + args[1]
            + " assertions="
            + assertions);
  }
}
