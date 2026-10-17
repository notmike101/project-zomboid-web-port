package port.host;

import java.nio.BufferOverflowException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import com.github.micycle1.clipper2.core.ClipType;
import com.github.micycle1.clipper2.core.FillRule;
import com.github.micycle1.clipper2.core.Path64;
import com.github.micycle1.clipper2.core.Point64;
import com.github.micycle1.clipper2.engine.Clipper64;
import com.github.micycle1.clipper2.engine.PolyPath64;
import com.github.micycle1.clipper2.engine.PolyTree64;
import org.lwjgl.util.glu.GLU;
import org.lwjgl.util.glu.GLUtessellator;
import org.lwjgl.util.glu.GLUtessellatorCallbackAdapter;
import org.lwjgl.util.glu.tessellation.GLUtessellatorImpl;

/** Real Clipper2 engine and qualified original JNI byte-buffer contract. */
public final class ClipperSupport {
    // Original static Clipper instances survive world replacement; ownership lasts for this browser JVM.
    private static final IdentityHashMap<Object, State> states = new IdentityHashMap<>();

    private static final class State {
        final Clipper64 engine = new Clipper64();
        final ArrayList<Polygon> polygons = new ArrayList<>();
    }

    private record Polygon(Path64 outer, ArrayList<Path64> holes) { }

    private record Triangulation(ArrayList<Point64> vertices, ArrayList<Integer> indices) { }

    /** Keeps the original flattened vertex identities in the shipped GLU callbacks. */
    private static final class Tessellation extends GLUtessellatorCallbackAdapter {
        final ArrayList<Point64> vertices;
        final ArrayList<Integer> indices = new ArrayList<>();
        String failure;

        Tessellation(ArrayList<Point64> vertices) { this.vertices = vertices; }

        private void fail(String message) { if (failure == null) failure = message; }

        @Override public void begin(int primitive) {
            if (primitive != 4) fail("GLU emitted a non-triangle primitive");
        }

        // Registering this callback makes GLU emit separate triangles rather than strips/fans.
        @Override public void edgeFlag(boolean boundary) { }

        @Override public void vertex(Object data) {
            if (data instanceof Integer index && index >= 0 && index < vertices.size()) indices.add(index);
            else fail("GLU lost the original vertex identity");
        }

        @Override public void error(int code) { fail("GLU tessellation error " + code); }

        @Override public void combine(double[] coordinates, Object[] data, float[] weights, Object[] output) {
            // Coincident input vertices may merge; newly created vertices cannot fit the native table ABI.
            for (Object item : data) {
                if (item instanceof Integer index) {
                    Point64 point = vertices.get(index);
                    if (point.x == coordinates[0] && point.y == coordinates[1]) {
                        output[0] = index;
                        return;
                    }
                }
            }
            fail("Triangulation requires an additional intersection vertex");
        }
    }

    private ClipperSupport() { }

    public static synchronized void allocate(Object owner) {
        if (owner == null || states.containsKey(owner)) {
            throw new IllegalArgumentException("Invalid or duplicate polygon owner");
        }
        states.put(owner, new State());
    }

    private static synchronized State state(Object owner) {
        State result = states.get(owner);
        if (result == null) {
            throw new IllegalArgumentException("Unknown polygon owner");
        }
        return result;
    }

    public static void clear(Object owner) {
        State state = state(owner);
        state.engine.clear();
        state.polygons.clear();
    }

    private static long coordinate(float value) {
        // The original DLL rounds the float-scaled value to the nearest integer, with ties toward +infinity.
        float scaled = value * 1000.0f;
        double rounded = Math.floor((double) scaled + 0.5);
        if (!Float.isFinite(value) || !Double.isFinite(rounded) || rounded < -0x1p63 || rounded >= 0x1p63) {
            throw new IllegalArgumentException("Coordinate outside signed-long range");
        }
        long result = (long) rounded;
        if (result < -(Long.MAX_VALUE >> 2) || result > (Long.MAX_VALUE >> 2)) {
            throw new IllegalArgumentException("Coordinate outside Clipper64 supported range");
        }
        return result;
    }

    public static void addPath(Object owner, int count, ByteBuffer buffer, boolean isClip, boolean closed) {
        State state = state(owner);
        if (!closed) {
            throw new UnsupportedOperationException("Open paths not qualified");
        }
        if (buffer == null || !buffer.isDirect() || count < 3 || count > Short.MAX_VALUE || count > buffer.capacity() / 8) {
            throw new IllegalArgumentException("Invalid polygon buffer");
        }
        ByteBuffer read = buffer.duplicate().order(ByteOrder.BIG_ENDIAN);
        read.clear();
        Path64 path = new Path64();
        for (int index = 0; index < count; index++) {
            path.add(new Point64(coordinate(read.getFloat()), coordinate(read.getFloat())));
        }
        if (isClip) {
            state.engine.addClip(path);
        } else {
            state.engine.addSubject(path);
        }
        state.polygons.clear();
    }

    private static void addCoordinates(Object owner, boolean isClip, float... coordinates) {
        State state = state(owner);
        Path64 path = new Path64();
        for (int index = 0; index < coordinates.length; index += 2) {
            path.add(new Point64(coordinate(coordinates[index]), coordinate(coordinates[index + 1])));
        }
        if (isClip) {
            state.engine.addClip(path);
        } else {
            state.engine.addSubject(path);
        }
        state.polygons.clear();
    }

    public static void addAABB(Object owner, float left, float top, float right, float bottom) {
        // Native calls preserve the supplied winding, including reversed bounds.
        addCoordinates(owner, false, left, top, right, top, right, bottom, left, bottom);
    }

    public static void addPolygon(Object owner, float x1, float y1, float x2, float y2,
            float x3, float y3, float x4, float y4) {
        addCoordinates(owner, false, x1, y1, x2, y2, x3, y3, x4, y4);
    }

    public static void clipAABB(Object owner, float left, float top, float right, float bottom) {
        addCoordinates(owner, true, left, top, right, top, right, bottom, left, bottom);
    }

    private static void collect(PolyPath64 node, ArrayList<Polygon> polygons) {
        if (node.getPolygon() != null && !node.getIsHole()) {
            ArrayList<Path64> holes = new ArrayList<>();
            for (int index = 0; index < node.getCount(); index++) {
                PolyPath64 child = node.get(index);
                if (child.getIsHole()) {
                    holes.add(child.getPolygon());
                }
            }
            polygons.add(new Polygon(node.getPolygon(), holes));
        }
        for (int index = 0; index < node.getCount(); index++) {
            collect(node.get(index), polygons);
        }
    }

    public static int generate(Object owner, int operation, double offset, int join) {
        State state = state(owner);
        // shortcut: only zero-offset intersection/difference are native-qualified; extend after native comparisons.
        if ((operation != 1 && operation != 3) || offset != 0 || join != 0) {
            throw new UnsupportedOperationException("Only native-qualified zero-offset intersection and difference are enabled");
        }
        PolyTree64 tree = new PolyTree64();
        ClipType type = operation == 1 ? ClipType.Intersection : ClipType.Difference;
        if (!state.engine.execute(type, FillRule.Positive, tree)) {
            throw new IllegalStateException("Clipper2 execution failed");
        }
        state.polygons.clear();
        collect(tree, state.polygons);
        return state.polygons.size();
    }

    private static int ringBytes(Path64 ring) {
        if (ring.size() > Short.MAX_VALUE) {
            throw new IllegalArgumentException("Polygon ring exceeds JNI short count");
        }
        return Math.addExact(2, Math.multiplyExact(ring.size(), 8));
    }

    private static void writeRing(ByteBuffer output, Path64 ring) {
        output.putShort((short) ring.size());
        for (Point64 point : ring) {
            output.putFloat((float) (point.x / 1000.0));
            output.putFloat((float) (point.y / 1000.0));
        }
    }

    public static int getPolygon(Object owner, int index, ByteBuffer buffer) {
        Polygon polygon = state(owner).polygons.get(index);
        int bytes = Math.addExact(ringBytes(polygon.outer), 2);
        if (polygon.holes.size() > Short.MAX_VALUE) {
            throw new IllegalArgumentException("Too many holes");
        }
        for (Path64 hole : polygon.holes) {
            bytes = Math.addExact(bytes, ringBytes(hole));
        }
        if (buffer == null || !buffer.isDirect() || buffer.isReadOnly()) {
            throw new IllegalArgumentException("Invalid output buffer");
        }
        if (bytes > buffer.capacity()) {
            throw new BufferOverflowException();
        }
        ByteBuffer output = buffer.duplicate().order(ByteOrder.BIG_ENDIAN);
        output.clear();
        writeRing(output, polygon.outer);
        output.putShort((short) polygon.holes.size());
        for (Path64 hole : polygon.holes) {
            writeRing(output, hole);
        }
        return 0;
    }

    private static Triangulation triangulate(Polygon polygon) {
        ArrayList<Path64> rings = new ArrayList<>();
        rings.add(polygon.outer);
        rings.addAll(polygon.holes);
        ArrayList<Point64> vertices = new ArrayList<>();
        for (Path64 ring : rings) {
            for (Point64 point : ring) {
                long exactIntegerLimit = 1L << 53;
                if (point.x < -exactIntegerLimit || point.x > exactIntegerLimit
                        || point.y < -exactIntegerLimit || point.y > exactIntegerLimit)
                    throw new UnsupportedOperationException("Triangulation coordinates exceed exact double-integer precision");
                vertices.add(point);
            }
        }
        if (vertices.size() > Short.MAX_VALUE)
            throw new UnsupportedOperationException("Triangulation exceeds the original signed-short vertex table");
        Tessellation callback = new Tessellation(vertices);
        GLUtessellator tessellator = GLUtessellatorImpl.gluNewTess();
        tessellator.gluTessNormal(0, 0, 1);
        for (int event : new int[] { GLU.GLU_TESS_BEGIN, GLU.GLU_TESS_VERTEX, GLU.GLU_TESS_EDGE_FLAG,
                GLU.GLU_TESS_ERROR, GLU.GLU_TESS_COMBINE }) tessellator.gluTessCallback(event, callback);
        tessellator.gluTessProperty(GLU.GLU_TESS_WINDING_RULE, GLU.GLU_TESS_WINDING_ODD);
        try {
            tessellator.gluTessBeginPolygon(null);
            int index = 0;
            for (Path64 ring : rings) {
                tessellator.gluTessBeginContour();
                for (Point64 point : ring)
                    tessellator.gluTessVertex(new double[] { point.x, point.y, 0 }, 0, index++);
                tessellator.gluTessEndContour();
            }
            tessellator.gluTessEndPolygon();
        } finally { tessellator.gluDeleteTess(); }
        if (callback.failure != null) throw new UnsupportedOperationException(callback.failure);
        if (callback.indices.size() % 3 != 0) throw new IllegalStateException("GLU emitted an incomplete triangle");
        for (int index = 0; index < callback.indices.size(); index += 3) {
            Point64 a = vertices.get(callback.indices.get(index));
            Point64 b = vertices.get(callback.indices.get(index + 1));
            Point64 c = vertices.get(callback.indices.get(index + 2));
            double cross = ((double) b.x - a.x) * ((double) c.y - a.y)
                    - ((double) b.y - a.y) * ((double) c.x - a.x);
            if (cross == 0) throw new UnsupportedOperationException("GLU emitted a degenerate triangle");
            if (cross < 0) {
                int swap = callback.indices.get(index + 1);
                callback.indices.set(index + 1, callback.indices.get(index + 2));
                callback.indices.set(index + 2, swap);
            }
        }
        return new Triangulation(vertices, callback.indices);
    }

    /** Emits the original indexed ABI using the already-shipped pure Java GLU tessellator. */
    public static int triangulate2(Object owner, int index, ByteBuffer buffer) {
        Polygon polygon = state(owner).polygons.get(index);
        if (buffer == null || !buffer.isDirect() || buffer.isReadOnly())
            throw new IllegalArgumentException("Invalid triangulation output buffer");
        Triangulation mesh = triangulate(polygon);
        int bytes = Math.addExact(2, Math.addExact(Math.multiplyExact(mesh.vertices.size(), 8),
                Math.multiplyExact(mesh.indices.size(), 2)));
        if (bytes > buffer.capacity()) throw new BufferOverflowException();
        ByteBuffer output = buffer.duplicate().order(ByteOrder.BIG_ENDIAN);
        output.clear();
        output.putShort((short) mesh.vertices.size());
        for (Point64 point : mesh.vertices) {
            output.putFloat((float) (point.x / 1000.0));
            output.putFloat((float) (point.y / 1000.0));
        }
        for (int vertex : mesh.indices) output.putShort((short) vertex);
        return mesh.indices.size();
    }
}
