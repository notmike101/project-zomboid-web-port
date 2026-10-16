import java.nio.BufferOverflowException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.StringJoiner;
import port.host.ClipperSupport;
import zombie.vehicles.Clipper;

/** Synthetic JNI polygon ABI qualification; no game entry point or world state. */
public final class ClipperQualification {
    static Clipper clipper;
    static ByteOrder inputTagOverride;
    static ByteOrder outputTagOverride;

    static float[] rect(float x, float y, float width, float height) {
        return new float[] { x, y, x + width, y, x + width, y + height, x, y + height };
    }

    static float[] hex(float x, float y) {
        return new float[] { x, y + 2, x + 1, y, x + 3, y, x + 4, y + 2, x + 3, y + 4, x + 1, y + 4 };
    }

    static float[] reverse(float[] points) {
        float[] reversed = new float[points.length];
        for (int index = 0; index < points.length; index += 2) {
            reversed[index] = points[points.length - index - 2];
            reversed[index + 1] = points[points.length - index - 1];
        }
        return reversed;
    }

    static ByteBuffer input(float[] points, ByteOrder order, int position) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(128).order(order);
        for (float value : points) {
            buffer.putFloat(value);
        }
        if (position >= 0) {
            buffer.position(position);
        }
        return buffer;
    }

    static String ring(ByteBuffer buffer) {
        int count = Short.toUnsignedInt(buffer.getShort());
        if (count > 4000) {
            throw new AssertionError("Unreasonable ring count " + count);
        }
        StringJoiner coordinates = new StringJoiner(",", "[", "]");
        for (int index = 0; index < count; index++) {
            coordinates.add("[" + buffer.getFloat() + "," + buffer.getFloat() + "]");
        }
        return coordinates.toString();
    }

    static void test(String name, float[] first, float[] second, ByteOrder order, int inputPosition, int outputPosition) {
        clipper.clear();
        ByteBuffer subject = input(first, order, inputPosition);
        ByteBuffer clip = input(second, order, inputPosition);
        if (inputTagOverride != null) {
            subject.order(inputTagOverride);
            clip.order(inputTagOverride);
        }
        int subjectPosition = subject.position();
        int clipPosition = clip.position();
        clipper.addPath(first.length / 2, subject, false, true);
        clipper.addPath(second.length / 2, clip, true, true);
        int count = clipper.generatePolygons(Clipper.ctIntersection, 0, Clipper.jtSquare);
        StringJoiner polygons = new StringJoiner(",", "[", "]");
        for (int index = 0; index < count; index++) {
            ByteBuffer output = ByteBuffer.allocateDirect(65536);
            for (int offset = 0; offset < output.capacity(); offset++) {
                output.put((byte) 0x5a);
            }
            output.clear();
            output.position(outputPosition);
            output.limit(65000);
            if (outputTagOverride != null) {
                output.order(outputTagOverride);
            }
            int returned = clipper.getPolygon(index, output);
            int after = output.position();
            int limit = output.limit();
            ByteBuffer read = output.duplicate().order(ByteOrder.BIG_ENDIAN);
            read.clear();
            int rawHeaderBE = Short.toUnsignedInt(read.getShort(0));
            ByteOrder encodedOrder = rawHeaderBE <= 64 ? ByteOrder.BIG_ENDIAN : ByteOrder.LITTLE_ENDIAN;
            read.order(encodedOrder);
            String outer = ring(read);
            int holes = Short.toUnsignedInt(read.getShort());
            StringJoiner holeData = new StringJoiner(",", "[", "]");
            for (int hole = 0; hole < holes; hole++) {
                holeData.add(ring(read));
            }
            int consumed = read.position();
            int lastChanged = -1;
            ByteBuffer raw = output.duplicate();
            raw.clear();
            for (int offset = 0; offset < raw.capacity(); offset++) {
                if (raw.get(offset) != (byte) 0x5a) {
                    lastChanged = offset;
                }
            }
            boolean tail = true;
            for (int offset = consumed; offset < raw.capacity(); offset++) {
                if (raw.get(offset) != (byte) 0x5a) {
                    tail = false;
                }
            }
            polygons.add("{\"return\":" + returned
                    + ",\"outputTag\":\"" + output.order() + "\""
                    + ",\"encodedOrder\":\"" + encodedOrder + "\""
                    + ",\"rawHeaderBE\":" + rawHeaderBE
                    + ",\"positionBefore\":" + outputPosition
                    + ",\"positionAfter\":" + after
                    + ",\"limitAfter\":" + limit
                    + ",\"bytesRead\":" + consumed
                    + ",\"lastChanged\":" + lastChanged
                    + ",\"tailSentinel\":" + tail
                    + ",\"outer\":" + outer + ",\"holes\":" + holeData + "}");
        }
        System.out.println("{\"name\":\"" + name + "\",\"order\":\"" + order
                + "\",\"inputTag\":\"" + subject.order()
                + "\",\"inputPositionsBefore\":[" + subjectPosition + "," + clipPosition
                + "],\"inputPositionsAfter\":[" + subject.position() + "," + clip.position()
                + "],\"count\":" + count + ",\"polygons\":" + polygons + "}");
    }
    public static void main(String[] args) {
        if (args.length > 0 && args[0].equals("native")) {
            Clipper.init();
        }
        clipper = new Clipper();
        AdapterChecks.run();
        System.out.println("CLIPPER_ADAPTER_CHECKS_PASS");
        float[] square = rect(0, 0, 2, 2);
        test("rect-disjoint", square, rect(3, 0, 2, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("rect-overlap", square, rect(1, 1, 2, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("rect-contained", rect(0, 0, 4, 4), rect(1, 1, 2, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("rect-equal", square, square, ByteOrder.BIG_ENDIAN, -1, 0);
        test("rect-edge", square, rect(2, 0, 2, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("rect-vertex", square, rect(2, 2, 2, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-overlap", hex(0, 0), hex(1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-disjoint", hex(0, 0), hex(10, 10), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-equal", hex(0, 0), hex(0, 0), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-reversed", reverse(hex(0, 0)), reverse(hex(1, 1)), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-subject-reversed", reverse(hex(0, 0)), hex(1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-clip-reversed", hex(0, 0), reverse(hex(1, 1)), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-contained", rect(-1, -1, 10, 10), hex(0, 0), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-edge", hex(0, 0), hex(3, 2), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-vertex", hex(0, 0), hex(4, 0), ByteOrder.BIG_ENDIAN, -1, 0);
        test("hex-negative", hex(-10, -10), hex(-9, -9), ByteOrder.BIG_ENDIAN, -1, 0);
        test("two-results", new float[]{0, 0, 4, 0, 4, 4, 3, 4, 3, 1, 1, 1, 1, 4, 0, 4}, rect(-1, 2, 6, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        test("positions", square, rect(1, 1, 2, 2), ByteOrder.BIG_ENDIAN, 7, 11);
        test("little-endian", square, rect(1, 1, 2, 2), ByteOrder.LITTLE_ENDIAN, -1, 0);
        for (float f:new float[]{.000001f, .00001f, .0001f, .00025f, .00049f, .0005f, .00051f, .0009f, .001f, .0011f, .0015f, .0025f, .0035f, -.00049f, -.0005f, -.00051f, -.0015f, -.0025f, -.0035f, .005f, .01f, .1f, .1234567f, .33333334f})
            test("fraction-"+f, rect(-1, -1, 4, 4), rect(f, f, 1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        inputTagOverride = ByteOrder.LITTLE_ENDIAN;
        test("big-bytes-little-input-tag", hex(0, 0), hex(1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        inputTagOverride = null;outputTagOverride = ByteOrder.LITTLE_ENDIAN;
        test("big-bytes-little-output-tag", hex(0, 0), hex(1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
        inputTagOverride = ByteOrder.LITTLE_ENDIAN;
        test("big-bytes-little-both-tags", hex(0, 0), hex(1, 1), ByteOrder.BIG_ENDIAN, -1, 0);
    }
}
final class AdapterChecks {
    public static void run() {
        Object owner = new Object();
        ClipperSupport.allocate(owner);
        try {
            ByteBuffer path = ByteBuffer.allocateDirect(32);
            for (float value : new float[] { 0, 0, 2, 0, 2, 2, 0, 2 }) {
                path.putFloat(value);
            }
            ClipperSupport.addPath(owner, 4, path, false, true);
            ClipperSupport.addPath(owner, 4, path, true, true);
            try {
                ClipperSupport.generate(owner, 2, 0, 0);
                throw new AssertionError("Unqualified operation accepted");
            } catch (UnsupportedOperationException expected) { }
            if (ClipperSupport.generate(owner, 1, 0, 0) != 1) {
                throw new AssertionError("Real engine intersection failed");
            }
            ByteBuffer small = ByteBuffer.allocateDirect(8);
            for (int index = 0; index < 8; index++) {
                small.put((byte) 0x5a);
            }
            try {
                ClipperSupport.getPolygon(owner, 0, small);
                throw new AssertionError("Undersized output accepted");
            } catch (BufferOverflowException expected) { }
            for (int index = 0; index < 8; index++) {
                if (small.get(index) != (byte) 0x5a) {
                    throw new AssertionError("Partial output write");
                }
            }
            if (small.position() != 8) {
                throw new AssertionError("Output position changed");
            }
            ByteBuffer invalid = ByteBuffer.allocateDirect(32);
            invalid.putFloat(Float.NaN);
            try {
                ClipperSupport.addPath(owner, 4, invalid, false, true);
                throw new AssertionError("Nonfinite coordinate accepted");
            } catch (IllegalArgumentException expected) { }
            try {
                ClipperSupport.addPath(owner, 4, path, false, false);
                throw new AssertionError("Unqualified open path accepted");
            } catch (UnsupportedOperationException expected) { }
            invalid.clear();
            invalid.putFloat(Float.MAX_VALUE);
            try {
                ClipperSupport.addPath(owner, 4, invalid, false, true);
                throw new AssertionError("Long range overflow accepted");
            } catch (IllegalArgumentException expected) { }
            ClipperSupport.clear(owner);
            if (ClipperSupport.generate(owner, 1, 0, 0) != 0) {
                throw new AssertionError("Clear retained paths");
            }
        } finally {
            ClipperSupport.clear(owner);
        }
    }
}
