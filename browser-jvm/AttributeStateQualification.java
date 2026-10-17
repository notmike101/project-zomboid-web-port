import org.lwjgl.opengl.GL11;

/** Actual original vendor attribute-stack ABI, independent of game startup. */
public final class AttributeStateQualification {
    private static native boolean exercise();
    private static native void report(int checks, boolean pass);
    private static int checks;
    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
        checks++;
    }
    public static void main(String[] args) {
        boolean pass = false;
        try {
            check(GL11.glGetInteger(GL11.GL_CLIENT_ATTRIB_STACK_DEPTH) == 0, "Client stack starts empty");
            check(GL11.glGetInteger(GL11.GL_MAX_CLIENT_ATTRIB_STACK_DEPTH) == 16, "Real supported client limit");
            GL11.glPushClientAttrib(0x40000000);
            check(GL11.glGetInteger(GL11.GL_CLIENT_ATTRIB_STACK_DEPTH) == 1, "Unknown client bits ignored but entry pushed");
            GL11.glPopClientAttrib();
            for (int i = 0; i < 16; i++) GL11.glPushClientAttrib(GL11.GL_CLIENT_ALL_ATTRIB_BITS);
            GL11.glPushClientAttrib(0);
            check(GL11.glGetError() == GL11.GL_STACK_OVERFLOW, "Client overflow reports actual compatibility error");
            check(GL11.glGetInteger(GL11.GL_CLIENT_ATTRIB_STACK_DEPTH) == 16, "Overflow leaves saved ownership intact");
            for (int i = 0; i < 16; i++) GL11.glPopClientAttrib();
            GL11.glPopClientAttrib();
            check(GL11.glGetError() == GL11.GL_STACK_UNDERFLOW, "Client underflow reports actual compatibility error");
            check(GL11.glGetInteger(GL11.GL_CLIENT_ATTRIB_STACK_DEPTH) == 0, "Client underflow leaves empty state");
            GL11.glPushAttrib(GL11.GL_ALL_ATTRIB_BITS);
            GL11.glPushClientAttrib(GL11.GL_CLIENT_ALL_ATTRIB_BITS);
            check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 1 && GL11.glGetInteger(GL11.GL_CLIENT_ATTRIB_STACK_DEPTH) == 1, "Original skybox masks use independent stacks");
            GL11.glPopAttrib();
            GL11.glPopClientAttrib();
            check(GL11.glGetError() == 0, "Actual original all-mask sequence is error free");
            check(exercise(), "Actual production stack pixel/state/retention checks");
            boolean caught = false, finished = false;
            try { GL11.glEnableClientState(GL11.GL_VERTEX_ARRAY); }
            catch (UnsupportedOperationException expected) { caught = true; }
            finally { finished = true; }
            check(caught && finished, "Unsupported conventional arrays retain real Java catch/finally");
            check(GL11.glGetError() == 0, "Final original GL ABI has no error");
            pass = true;
        } finally {
            report(checks, pass);
        }
    }
}
