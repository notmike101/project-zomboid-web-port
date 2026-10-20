import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.Field;
import zombie.core.physics.Bullet;

/** Same original three-step fixture through the actual browser JNI transport. */
public final class VehicleContactQualification {
    public static native void report(int step, float[] packed);
    public static native void finished(boolean workerClosed, int exceptions);
    private static boolean browser;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Throwable {
        browser = args.length == 0 || args[0].equals("browser");
        check(browser || args[0].equals("native"), "Explicit browser or native qualifier mode required");
        BulletQualification.main(new String[] { browser ? "browser" : "native" });
        byte[] bytes = Files.readAllBytes(Path.of(args.length > 1 ? args[1] : "/app/carnormal-original.bin"));
        check(bytes.length == 800, "Original definition length");
        float[] definition = new float[200];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(definition);
        check(zombie.iso.IsoWorld.instance.currentCell == null, "Actual empty original cell context");
        var cell = new zombie.iso.IsoCell(10, 10);
        Field workerField = zombie.iso.WorldReuserThread.class.getDeclaredField("worldReuser");
        workerField.setAccessible(true);
        Thread worker = (Thread) workerField.get(zombie.iso.WorldReuserThread.instance);
        Throwable primary = null;
        try {
            check(zombie.iso.IsoWorld.instance.currentCell == cell && cell.getChunk(19, 19) == null,
                "Original empty-cell callback branch");
            Bullet.defineVehicleScript("Base.CarNormal", definition);
            Bullet.initWorld(0, 0, 1, 1, 0, 0, false);
            Bullet.activateChunkMap(0, 13, 13, 13);
            byte[] packet = Files.readAllBytes(Path.of(args.length > 2 ? args[2] : "/app/chunk-packet.bin"));
            check(packet.length > 13 && packet.length <= 4096, "Original bounded packet");
            // Exact bytes captured from the original upload; preserve its terminating command.
            Bullet.cmdBuf.clear();
            check(packet[packet.length - 2] == -1 && packet[packet.length - 1] == -1, "Original terminator");
            Bullet.cmdBuf.put(packet, 0, packet.length - 2);
            Bullet.endUpdateChunk();
            Bullet.addVehicle(17, 153, 158, .75f, 0, 0, 0, 1, "Base.CarNormal");
            Bullet.setVehicleActive(17, true);
            for (int step = 1; step <= 3; step++) {
                Bullet.stepSimulation(.01f, 0, 0);
                check(Bullet.getVehicleCount() == 1, "Actual registered vehicle");
                float[] packed = new float[30];
                check(Bullet.getVehiclePhysics(0, packed) == 1, "Actual typed packed record");
                for (float value : packed) check(Float.isFinite(value), "Finite packed value");
                if (browser) report(step, packed);
                else System.out.println("VEHICLE_CONTACT " + step + " " + java.util.Arrays.toString(packed));
            }
            Bullet.removeVehicle(17);
            Bullet.deactivateChunkMap(0);
        } catch (Throwable error) {
            primary = error;
            throw error;
        } finally {
            Throwable cleanup = null;
            try {
                Bullet.destroyWorld();
                check(!Bullet.isWorldInit(), "Original world reports destroyed");
            } catch (Throwable error) {
                cleanup = error;
            }
            try {
                zombie.iso.WorldReuserThread.instance.stop();
                worker.join(2000);
                check(!worker.isAlive(), "Actual WorldReuserThread terminated");
            } catch (Throwable error) {
                if (cleanup == null) cleanup = error;
                else cleanup.addSuppressed(error);
            }
            if (cleanup != null) {
                if (primary != null) primary.addSuppressed(cleanup);
                else throw cleanup;
            }
        }
        Field exceptions = zombie.core.logger.ExceptionLogger.class.getDeclaredField("exceptionCount");
        exceptions.setAccessible(true);
        int count = exceptions.getInt(null);
        check(count == 0, "Original ExceptionLogger remains zero: " + count);
        if (browser) finished(!worker.isAlive(), count);
        System.out.println(browser ? "VEHICLE_CONTACT_BROWSER_PASS" : "VEHICLE_CONTACT_NATIVE_PASS");
    }
}
