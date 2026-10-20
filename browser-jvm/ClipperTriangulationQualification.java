import java.nio.*;
import java.util.*;
import port.host.ClipperSupport;
import zombie.vehicles.Clipper;

/** Independently authored synthetic indexed-polygon JNI tests; no game lifecycle. */
public final class ClipperTriangulationQualification {
    private static Clipper clipper;

    private static float[] rectangle(float x, float y, float width, float height) {
        return new float[] {x, y, x + width, y, x + width, y + height, x, y + height};
    }

    private static void add(float[] coordinates, boolean clip) {
        ByteBuffer input = ByteBuffer.allocateDirect(coordinates.length * 4);
        for (float coordinate : coordinates) input.putFloat(coordinate);
        clipper.addPath(coordinates.length / 2, input, clip, true);
    }

    private static void test(String name, float[][] subjects, float[][] holes, boolean little) {
        clipper.clear();
        for (float[] subject : subjects) add(subject, false);
        for (float[] hole : holes) add(hole, true);
        int polygons = clipper.generatePolygons(Clipper.ctDifference, 0, Clipper.jtSquare);
        for (int polygon = 0; polygon < polygons; polygon++) {
            ByteBuffer output = ByteBuffer.allocateDirect(65536);
            for (int index = 0; index < output.capacity(); index++) output.put((byte) 0x5a);
            output.position(11).limit(65000).order(little ? ByteOrder.LITTLE_ENDIAN : ByteOrder.BIG_ENDIAN);
            int count = clipper.triangulate2(polygon, output);
            if (count < 3 || count > 6000 || count % 3 != 0) throw new AssertionError("Invalid triangle count");
            ByteBuffer read = output.duplicate().order(ByteOrder.BIG_ENDIAN);
            read.clear();
            int vertices = Short.toUnsignedInt(read.getShort());
            if (vertices < 3 || vertices > 2000) throw new AssertionError("Invalid vertex count");
            StringJoiner points = new StringJoiner(",", "[", "]");
            for (int index = 0; index < vertices; index++) points.add("[" + read.getFloat() + "," + read.getFloat() + "]");
            StringJoiner indices = new StringJoiner(",", "[", "]");
            for (int index = 0; index < count; index++) {
                int vertex = Short.toUnsignedInt(read.getShort());
                if (vertex >= vertices) throw new AssertionError("Index outside native vertex table");
                indices.add(Integer.toString(vertex));
            }
            for (int index = read.position(); index < read.capacity(); index++)
                if (read.get(index) != (byte) 0x5a) throw new AssertionError("Output tail changed");
            if (output.position() != 11 || output.limit() != 65000) throw new AssertionError("Output caller state changed");
            System.out.println("{\"triangulation\":\"" + name + "\",\"polygon\":" + polygon
                    + ",\"returned\":" + count + ",\"vertices\":" + points + ",\"indices\":" + indices
                    + ",\"position\":" + output.position() + ",\"limit\":" + output.limit()
                    + ",\"tailUnchanged\":true}");
        }
    }

    private static void guards() {
        ByteBuffer small = ByteBuffer.allocateDirect(8);
        small.putLong(0x5a5a5a5a5a5a5a5aL);
        int finallyCalls = 0;
        System.out.println("CLIPPER_TRIANGULATION_GUARD_BUFFER");
        try {
            clipper.triangulate2(0, small);
            throw new AssertionError("Undersized JNI output accepted");
        } catch (BufferOverflowException expected) { }
        finally { finallyCalls++; }
        System.out.println("CLIPPER_TRIANGULATION_GUARD_INDEX");
        try {
            clipper.triangulate2(99, ByteBuffer.allocateDirect(128));
            throw new AssertionError("Unknown JNI polygon accepted");
        } catch (IndexOutOfBoundsException expected) { }
        finally { finallyCalls++; }
        if (finallyCalls != 2 || small.position() != 8 || small.getLong(0) != 0x5a5a5a5a5a5a5a5aL)
            throw new AssertionError("JNI rejection mutated output or skipped finally");
        Object owner = new Object();
        ClipperSupport.allocate(owner);
        ClipperSupport.addAABB(owner, 1e13f, 1e13f, 1.00001e13f, 1.00001e13f);
        if (ClipperSupport.generate(owner, Clipper.ctDifference, 0, Clipper.jtSquare) != 1)
            throw new AssertionError("Precision fixture did not generate a polygon");
        try {
            ClipperSupport.triangulate2(owner, 0, small);
            throw new AssertionError("Inexact integer coordinates accepted");
        } catch (UnsupportedOperationException expected) { }
        if (small.getLong(0) != 0x5a5a5a5a5a5a5a5aL) throw new AssertionError("Precision rejection wrote output");
        ClipperSupport.clear(owner);
        try {
            var method = ClipperSupport.class.getDeclaredMethod("triangulateNative", double[].class, int[].class);
            method.setAccessible(true);
            try {
                method.invoke(null, new double[] {0,0,1,0,Double.NaN,1}, new int[] {3});
                throw new AssertionError("JNI invalid coordinate accepted");
            } catch (java.lang.reflect.InvocationTargetException expected) {
                if (!(expected.getCause() instanceof IllegalArgumentException)) throw new AssertionError("JNI did not return a real Java validation exception", expected);
            }
        } catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
        System.out.println("CLIPPER_TRIANGULATION_GUARDS_PASS");
    }

    public static void main(String[] args) {
        boolean nativeMode = args.length > 0 && args[0].equals("native");
        Clipper.init();
        clipper = new Clipper();
        test("rectangle", new float[][] {rectangle(0, 0, 10, 10)}, new float[0][], false);
        test("rectangle-le-tag", new float[][] {rectangle(0, 0, 10, 10)}, new float[0][], true);
        test("concave", new float[][] {{0, 0, 10, 0, 10, 3, 3, 3, 3, 10, 0, 10}}, new float[0][], false);
        test("hole", new float[][] {rectangle(0, 0, 10, 10)}, new float[][] {rectangle(2, 2, 6, 6)}, false);
        test("two-holes", new float[][] {rectangle(0, 0, 10, 10)}, new float[][] {rectangle(1, 1, 2, 2), rectangle(6, 6, 2, 2)}, false);
        test("multipart", new float[][] {rectangle(0, 0, 3, 3), rectangle(8, 8, 2, 2)}, new float[0][], false);
        test("fractional", new float[][] {rectangle(-.0005f, .12345f, 3.12349f, 4.005f)}, new float[0][], false);
        test("collinear-duplicate", new float[][] {{0, 0, 5, 0, 10, 0, 10, 10, 10, 10, 0, 10}}, new float[0][], false);
        test("collinear-sweep", new float[][] {{8, 0, 6, 1, 4, 2, 2, 3, 0, 4, -1, 4, -1, 0}}, new float[0][], false);
        if (!nativeMode) guards();
        test("actual-map-cell50-4",new float[][]{{68,183,69,183,69,189,68,189,68,195,58,195,58,196,52,196,52,195,42,195,42,177,68,177}},new float[0][],false);
        clipper.clear();
    }
}
