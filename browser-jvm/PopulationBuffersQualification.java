import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import port.host.PopulationBuffers;

/** Authored boundary checks; no original world, native library, or save is initialized. */
public final class PopulationBuffersQualification {
    private static int checks;

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static ByteBuffer buffer(int length) {
        ByteBuffer result = ByteBuffer.allocateDirect(length).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < length; i++) result.put(i, (byte) 0x55);
        return result;
    }

    private static byte[] bytes(ByteBuffer source) {
        ByteBuffer view = source.duplicate().clear();
        byte[] result = new byte[view.remaining()];
        view.get(result);
        return result;
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) {
            result.append(Character.forDigit((value >>> 4) & 15, 16));
            result.append(Character.forDigit(value & 15, 16));
        }
        return result.toString();
    }

    private static void rejects(ByteBuffer target, String encoded, Class<?> expected) {
        byte[] before = bytes(target);
        int position = target.position(), limit = target.limit();
        ByteOrder order = target.order();
        try {
            PopulationBuffers.writeRecords(target, encoded);
            throw new AssertionError("Expected " + expected.getSimpleName());
        } catch (RuntimeException failure) {
            check(expected.isInstance(failure), "actual Java rejection type");
        }
        check(Arrays.equals(before, bytes(target)), "rejection leaves bytes unchanged");
        check(target.position() == position && target.limit() == limit && target.order() == order,
                "rejection leaves original view state unchanged");
    }

    public static void main(String[] args) {
        ByteBuffer wire = ByteBuffer.allocate(66);
        for (int i = 0; i < 2; i++) {
            wire.putFloat(10.25f + i).putFloat(-20.75f).putFloat(0).put((byte) 7);
            wire.putInt(3).putInt(4).putInt(Integer.MIN_VALUE).putInt(Integer.MIN_VALUE).putInt(100 + i);
        }
        String encoded = hex(wire.array());
        rejects(buffer(32), encoded, UnsupportedOperationException.class);
        rejects(buffer(66), encoded + "00", IllegalArgumentException.class);
        rejects(buffer(66), encoded + "0", IllegalArgumentException.class);
        rejects(buffer(66).asReadOnlyBuffer(), encoded, UnsupportedOperationException.class);
        rejects(ByteBuffer.allocate(66), encoded, UnsupportedOperationException.class);

        ByteBuffer shortTarget = buffer(65);
        shortTarget.position(2).limit(3);
        check(PopulationBuffers.writeRecords(shortTarget, encoded) == 1, "capacity65 returns one whole record");
        byte[] one = bytes(shortTarget);
        check(Arrays.equals(Arrays.copyOf(one, 33), Arrays.copyOf(wire.array(), 33)), "original big-endian record bytes");
        check(one[33] == 0x55 && one[64] == 0x55, "whole-record truncation guard bytes");
        check(shortTarget.position() == 2 && shortTarget.limit() == 3
                && shortTarget.order() == ByteOrder.LITTLE_ENDIAN, "caller state retained");

        ByteBuffer owner = buffer(74);
        owner.position(4).limit(70);
        ByteBuffer slice = owner.slice().order(ByteOrder.LITTLE_ENDIAN);
        slice.position(1).limit(2);
        check(PopulationBuffers.writeRecords(slice, encoded) == 2, "capacity66 slice returns both records");
        byte[] actual = bytes(owner);
        check(Arrays.equals(Arrays.copyOfRange(actual, 4, 70), wire.array()), "slice base points at actual owner bytes");
        check(actual[3] == 0x55 && actual[70] == 0x55, "slice prefix and suffix preserved");
        check(slice.position() == 1 && slice.limit() == 2 && owner.position() == 4
                && owner.limit() == 70, "slice and owner cursors unchanged");
        check(PopulationBuffers.writeRecords(buffer(0), "") == 0, "empty publication needs no capacity");
        System.out.println("POPULATION_BUFFERS_PASS checks=" + checks);
    }
}
