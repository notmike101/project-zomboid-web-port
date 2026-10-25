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
import com.github.micycle1.clipper2.offset.ClipperOffset;
import com.github.micycle1.clipper2.offset.JoinType;
import com.github.micycle1.clipper2.offset.EndType;
import com.github.micycle1.clipper2.engine.PolyPath64;
import com.github.micycle1.clipper2.engine.PolyTree64;

/** Real Clipper2 engine and qualified original JNI byte-buffer contract. */
public final class ClipperSupport {
    private static java.lang.reflect.Field originalAddress;
    private static java.lang.reflect.Method originalStdErr;

    /** Resolves the actual original JNI class/field/method contract without fabricating native addresses. */
    public static synchronized void initializeOriginalBindings() throws ReflectiveOperationException {
        Class<?> type = zombie.vehicles.Clipper.class;
        java.lang.reflect.Field address = type.getDeclaredField("address");
        java.lang.reflect.Method writer = type.getDeclaredMethod("writeToStdErr", String.class);
        if (address.getType() != long.class || java.lang.reflect.Modifier.isStatic(address.getModifiers())
                || writer.getReturnType() != void.class || !java.lang.reflect.Modifier.isStatic(writer.getModifiers()))
            throw new IllegalStateException("Unexpected original Clipper JNI bindings");
        originalAddress = address;
        originalStdErr = writer;
    }

    /** Reports actual resolved descriptors for the focused original-init qualification. */
    public static synchronized String originalBindingDescription() {
        if (originalAddress == null || originalStdErr == null)
            throw new IllegalStateException("Original Clipper JNI bindings were not resolved");
        return originalAddress.getDeclaringClass().getName() + "." + originalAddress.getName() + ":"
                + originalAddress.getType().getName() + ";" + originalStdErr.getName() + "("
                + originalStdErr.getParameterTypes()[0].getName() + "):" + originalStdErr.getReturnType().getName();
    }

    // Original static Clipper instances survive world replacement; ownership lasts for this browser JVM.
    private static final IdentityHashMap<Object, State> states = new IdentityHashMap<>();
    private static final IdentityHashMap<Object, OffsetState> offsets = new IdentityHashMap<>();
    private static long nextOffset = 1;

    private static final class OffsetState {
        final ClipperOffset engine = new ClipperOffset();
        final ArrayList<Polygon> polygons = new ArrayList<>();
    }

    private static final class State {
        final Clipper64 engine = new Clipper64();
        final ArrayList<Polygon> polygons = new ArrayList<>();
    }

    private record Polygon(Path64 outer, ArrayList<Path64> holes) { }

    private record Triangulation(ArrayList<Point64> vertices, ArrayList<Integer> indices) { }

    private static native int[] triangulateNative(double[] coordinates, int[] ends);

    private ClipperSupport() { }

    /** Owns the original offset receiver; the returned ordinal is not a native address. */
    public static synchronized long allocateOffset(Object owner) {
        if (owner == null || offsets.containsKey(owner))
            throw new IllegalArgumentException("Invalid or duplicate offset owner");
        if (nextOffset > 9_007_199_254_740_991L)
            throw new IllegalStateException("Offset owner ordinal exceeds exact browser Java long transport");
        offsets.put(owner, new OffsetState());
        return nextOffset++;
    }

    private static OffsetState offset(Object owner) {
        OffsetState state = offsets.get(owner);
        if (state == null) throw new IllegalArgumentException("Unknown offset owner");
        return state;
    }

    public static synchronized void clearOffset(Object owner) {
        // Original clear removes input groups, retaining published polygons until execute.
        offset(owner).engine.clear();
    }

    public static synchronized void addOffsetPath(Object owner, int count, ByteBuffer buffer, int join, int end) {
        OffsetState state = offset(owner);
        if (join != 3 || end != 2)
            throw new UnsupportedOperationException("Only original street Miter/Butt offsets are qualified");
        if (buffer == null || !buffer.isDirect() || count < 0 || count > Short.MAX_VALUE || count > buffer.capacity() / 8)
            throw new IllegalArgumentException("Invalid offset path buffer");
        ByteBuffer read = buffer.duplicate().order(ByteOrder.BIG_ENDIAN);
        read.clear();
        Path64 path = new Path64();
        for (int index = 0; index < count; index++)
            path.add(new Point64(offsetCoordinate(read.getFloat()), offsetCoordinate(read.getFloat())));
        state.engine.addPath(path, JoinType.Miter, EndType.Butt);
    }

    private static long offsetCoordinate(float value) {
        // Native addPath does both multiply and add at float32 before floor/int32 conversion.
        float shifted = value * 1000.0f + 0.5f;
        double rounded = Math.floor(shifted);
        if (!Float.isFinite(value) || rounded < Integer.MIN_VALUE || rounded > Integer.MAX_VALUE)
            throw new IllegalArgumentException("Offset coordinate outside native int32 range");
        return (long) rounded;
    }

    public static synchronized void executeOffset(Object owner, double delta) {
        OffsetState state = offset(owner);
        if (!Double.isFinite(delta) || delta < 0)
            throw new UnsupportedOperationException("Negative or nonfinite open-path offset");
        state.polygons.clear();
        PolyTree64 tree = new PolyTree64();
        state.engine.execute(delta * 1000.0, tree);
        collect(tree, state.polygons);
    }

    public static synchronized int offsetPolygonCount(Object owner) {
        return offset(owner).polygons.size();
    }

    public static synchronized int getOffsetPolygon(Object owner, int index, ByteBuffer buffer) {
        Polygon polygon = offset(owner).polygons.get(index);
        int bytes = Math.addExact(ringBytes(polygon.outer), 2);
        if (polygon.holes.size() > Short.MAX_VALUE) throw new IllegalArgumentException("Too many offset holes");
        for (Path64 hole : polygon.holes) bytes = Math.addExact(bytes, ringBytes(hole));
        if (buffer == null || !buffer.isDirect() || buffer.isReadOnly())
            throw new IllegalArgumentException("Invalid offset output buffer");
        if (bytes > buffer.capacity()) throw new BufferOverflowException();
        ByteBuffer output = buffer.duplicate().order(ByteOrder.BIG_ENDIAN);
        output.clear();
        writeOffsetRing(output, polygon.outer);
        output.putShort((short) polygon.holes.size());
        for (Path64 hole : polygon.holes) writeOffsetRing(output, hole);
        return 0;
    }

    private static void writeOffsetRing(ByteBuffer output, Path64 ring) {
        output.putShort((short) ring.size());
        for (Point64 point : ring) {
            output.putFloat((float) point.x / 1000.0f);
            output.putFloat((float) point.y / 1000.0f);
        }
    }

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

    private static void addOffsetRings(PolyPath64 node, ClipperOffset offsetter) {
        if (node.getPolygon() != null) {
            // Native single-path groups preserve its independently expanded hole boundaries.
            offsetter.addPath(node.getPolygon(), JoinType.Square, EndType.Polygon);
        }
        for (int index = 0; index < node.getCount(); index++) {
            addOffsetRings(node.get(index), offsetter);
        }
    }

    public static int generate(Object owner, int operation, double offset, int join) {
        State state = state(owner);
        // shortcut: only the original highway's native-qualified Square offsets are enabled; compare other widths/joins before extending.
        if ((operation != 1 && operation != 3) || join != 0
                || (offset != 0 && (operation != 3 || (offset != 1 && offset != 2 && offset != 4 && offset != 6)))) {
            throw new UnsupportedOperationException("Only zero-offset intersection/difference and Difference/Square offsets 1,2,4,6 are qualified");
        }
        PolyTree64 tree = new PolyTree64();
        ClipType type = operation == 1 ? ClipType.Intersection : ClipType.Difference;
        if (!state.engine.execute(type, FillRule.Positive, tree)) {
            throw new IllegalStateException("Clipper2 execution failed");
        }
        if (offset != 0) {
            ClipperOffset offsetter = new ClipperOffset();
            addOffsetRings(tree, offsetter);
            tree = new PolyTree64();
            offsetter.execute(offset * 1000.0, tree);
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
        int[] ends = new int[rings.size()];
        for (int ringIndex = 0; ringIndex < rings.size(); ringIndex++) {
            for (Point64 point : rings.get(ringIndex)) {
                long limit = 1L << 53;
                if (point.x < -limit || point.x > limit || point.y < -limit || point.y > limit)
                    throw new UnsupportedOperationException("Triangulation coordinates exceed exact double-integer precision");
                vertices.add(point);
            }
            ends[ringIndex] = vertices.size();
        }
        if (vertices.size() > Short.MAX_VALUE)
            throw new UnsupportedOperationException("Triangulation exceeds the original signed-short vertex table");
        double[] coordinates = new double[vertices.size() * 2];
        for (int index = 0; index < vertices.size(); index++) {
            coordinates[index * 2] = vertices.get(index).x;
            coordinates[index * 2 + 1] = vertices.get(index).y;
        }
        int[] emitted = triangulateNative(coordinates, ends);
        if (emitted.length % 3 != 0) throw new IllegalStateException("Earcut emitted an incomplete triangle");
        ArrayList<Integer> indices = new ArrayList<>();
        for (int id : emitted) {
            if (id < 0 || id >= vertices.size()) throw new IllegalStateException("Earcut index outside original vertex table");
            indices.add(id);
        }
        for (int index = 0; index < indices.size(); index += 3) {
            Point64 a = vertices.get(indices.get(index));
            Point64 b = vertices.get(indices.get(index + 1));
            Point64 c = vertices.get(indices.get(index + 2));
            double cross = ((double) b.x - a.x) * ((double) c.y - a.y)
                - ((double) b.y - a.y) * ((double) c.x - a.x);
            if (cross <= 0) throw new UnsupportedOperationException("Earcut emitted a non-positive triangle");
        }
        return new Triangulation(vertices, indices);
    }

    /** Emits the original indexed ABI using pinned upstream Earcut WASM. */
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
