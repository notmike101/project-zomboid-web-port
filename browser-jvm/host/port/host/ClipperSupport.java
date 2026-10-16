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

/** Real Clipper2 engine and qualified original JNI byte-buffer contract. */
public final class ClipperSupport {
    // Original static Clipper instances survive world replacement; ownership lasts for this browser JVM.
    private static final IdentityHashMap<Object, State> states = new IdentityHashMap<>();

    private static final class State {
        final Clipper64 engine = new Clipper64();
        final ArrayList<Polygon> polygons = new ArrayList<>();
    }

    private record Polygon(Path64 outer, ArrayList<Path64> holes) { }

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
        // shortcut: only zero-offset intersection is native-qualified; extend after native comparisons.
        if (operation != 1 || offset != 0 || join != 0) {
            throw new UnsupportedOperationException("Only native-qualified zero-offset intersection is enabled");
        }
        PolyTree64 tree = new PolyTree64();
        if (!state.engine.execute(ClipType.Intersection, FillRule.Positive, tree)) {
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
}
