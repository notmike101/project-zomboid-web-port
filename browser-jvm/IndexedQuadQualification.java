import org.lwjgl.opengl.GL11C;
import org.lwjgl.opengl.GL12C;

/** Actual prepared vendor entry points, including real Java rejection cleanup. */
public final class IndexedQuadQualification {
    private static native void setup(int variant);
    private static native void report(int checks);

    private static int checks;

    private static void check(boolean value) {
        if (!value) throw new AssertionError("Indexed quad ABI check " + checks);
        checks++;
    }

    public static void main(String[] args) {
        setup(0);
        GL12C.glDrawRangeElements(7, 0, 8, 8, 5123, 0L);
        check(GL11C.glGetError() == 0);
        setup(1);
        int caught = 0, completed = 0;
        try {
            GL11C.glDrawElements(7, 4, 5125, 0L);
        } catch (UnsupportedOperationException expected) {
            caught++;
        } finally {
            completed++;
        }
        try {
            GL12C.glDrawRangeElements(7, 0, -1, 4, 5125, 0L);
        } catch (UnsupportedOperationException expected) {
            caught++;
        } finally {
            completed++;
        }
        setup(2);
        try {
            GL11C.glDrawElements(7, 4100, 5125, 0L);
        } catch (UnsupportedOperationException expected) {
            caught++;
        } finally {
            completed++;
        }
        check(caught == 3 && completed == 3);
        setup(1);
        check(GL11C.glGetError() == 0);
        GL11C.glDrawElements(7, -1, 5125, 0L);
        check(GL11C.glGetError() == 1281);
        GL11C.glDrawElements(7, 4, 5126, 0L);
        check(GL11C.glGetError() == 1280);
        GL11C.glDrawElements(7, 4, 5125, 1L);
        check(GL11C.glGetError() == 1282);
        GL12C.glDrawRangeElements(7, 9, 1, 4, 5125, 0L);
        check(GL11C.glGetError() == 1281);
        // Incomplete tails are not primitives, even when their index is reserved.
        GL11C.glDrawElements(7, 3, 5125, 0L);
        check(GL11C.glGetError() == 0);
        report(checks);
    }
}
