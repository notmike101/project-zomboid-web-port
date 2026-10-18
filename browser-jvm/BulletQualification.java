import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import zombie.core.physics.Bullet;

/** Original bootstrap/JNI calls; no game, world loading, or dynamic simulation. */
public final class BulletQualification {
    public static native void report(String stage);
    private static boolean browser;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static void emit(String stage) {
        if (browser) {
            report(stage);
        } else {
            try {
                Class.forName("BulletNativeReference").getMethod("record", String.class).invoke(null, stage);
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }
    }

    private static int exceptions() throws Exception {
        Field field = zombie.core.logger.ExceptionLogger.class.getDeclaredField("exceptionCount");
        field.setAccessible(true);
        return field.getInt(null);
    }

    public static void main(String[] args) throws Exception {
        browser = args.length == 0 || args[0].equals("browser");
        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        Bullet.init();
        ByteBuffer transport = Bullet.cmdBuf;
        check(transport != null && transport.isDirect() && transport.capacity() == 4096
            && transport.position() == 0 && transport.order() == ByteOrder.LITTLE_ENDIAN,
            "Original Bullet transport initialization");
        emit("bootstrap");
        try {
            check(!Bullet.isWorldInit(), "Initial lifecycle");
            if (browser) {
                boolean rejected = false;
                try {
                    Bullet.initWorld(1, 0, 0, 0, 1, 1, false);
                } catch (IllegalArgumentException expected) {
                    rejected = true;
                }
                check(rejected && !Bullet.isWorldInit(), "Unsupported header rejected before mutation");
            }
            Bullet.initWorld(0, 0, 0, 0, 1, 1, false);
            check(Bullet.isWorldInit(), "Actual native world");
            float[] first = {-1, -2, -3, 2, -2, -3, -1, 4, -3, -1, -2, 5};
            float[] second = {10, 0, 0, 12, 0, 0, 10, 2, 0, 10, 0, 2};
            Bullet.definePhysicsMesh(0, false, first);
            emit("single");
            Bullet.clearPhysicsMeshes();
            Bullet.definePhysicsMesh(0, true, first);
            Bullet.definePhysicsMesh(0, true, second);
            emit("compound");
            if (browser) {
                boolean rejected = false;
                try {
                    Bullet.definePhysicsMesh(1, false, new float[] {Float.NaN, 0, 0});
                } catch (IllegalArgumentException expected) {
                    rejected = true;
                }
                check(rejected, "Actual Java argument rejection");
                emit("rejected");
            }
            Bullet.clearPhysicsMeshes();
            emit("cleared");
        } finally {
            Bullet.destroyWorld();
            check(!Bullet.isWorldInit(), "Original destruction");
            check(exceptions() == 0, "Original logged exception counter");
            emit("finally");
        }
        try {
            Bullet.initWorld(-250, -250, 250, 250, -64000, -64000, false);
            Bullet.activateChunkMap(0, 1327, 1293, 13);
            emit("map0");
            if (browser) {
                boolean rejected = false;
                try {
                    Bullet.activateChunkMap(0, 1327, 1293, 13);
                } catch (IllegalArgumentException expected) {
                    rejected = true;
                }
                check(rejected, "Duplicate map activation rejected before mutation");
            }
            Bullet.activateChunkMap(1, 1328, 1293, 13);
            emit("overlap");
            Bullet.deactivateChunkMap(0);
            emit("retained1");
            Bullet.deactivateChunkMap(1);
            emit("empty");
            Bullet.activateChunkMap(0, 1327, 1293, 13);
            emit("reused");
        } finally {
            Bullet.destroyWorld();
            check(!Bullet.isWorldInit() && exceptions() == 0, "Chunk ownership cleanup");
            emit("chunks-finally");
        }
        System.out.println("BULLET_QUALIFICATION_PASS");
    }
}
