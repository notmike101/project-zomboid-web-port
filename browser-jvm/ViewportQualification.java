import org.lwjgl.opengl.GL11;

/** Actual vendor entry points over the prepared host facade, with no game startup. */
public final class ViewportQualification {
    public static native void state(int x, int y, int width, int height);
    public static native void report(int checks);
    private static int checks;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    public static void main(String[] args) {
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 0, "Initial empty stack");
        check(GL11.glGetInteger(GL11.GL_MAX_ATTRIB_STACK_DEPTH) == 16, "Actual supported stack limit");
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Compatibility queries do not reach WebGL invalid enums");
        GL11.glViewport(0, 0, 2, 2);
        GL11.glPushAttrib(GL11.GL_VIEWPORT_BIT | 0x40000000);
        GL11.glViewport(2, 0, 2, 2);
        GL11.glPopAttrib();
        state(0, 0, 2, 2);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Undefined mask bits ignored");
        GL11.glPushAttrib(0x40000000);
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 1, "Undefined-only mask pushes empty entry");
        GL11.glViewport(2, 0, 2, 2);
        GL11.glPopAttrib();
        state(2, 0, 2, 2);
        boolean rejected = false;
        boolean finished = false;
        try {
            GL11.glPushAttrib(GL11.GL_VIEWPORT_BIT | GL11.GL_COLOR_BUFFER_BIT);
        } catch (UnsupportedOperationException exception) {
            rejected = exception.getMessage().contains("attribute groups");
        } finally {
            finished = true;
        }
        check(rejected && finished, "Valid unsupported group throws Java exception and runs finally");
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 0, "Rejected group does not push");
        state(2, 0, 2, 2);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Unsupported group does not invent a GL error");
        for (int i = 0; i < 16; i++) GL11.glPushAttrib(GL11.GL_VIEWPORT_BIT);
        GL11.glPushAttrib(GL11.GL_VIEWPORT_BIT);
        check(GL11.glGetError() == GL11.GL_STACK_OVERFLOW, "Overflow reports compatibility GL error");
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 16, "Overflow retains full stack");
        for (int i = 0; i < 16; i++) GL11.glPopAttrib();
        GL11.glPopAttrib();
        check(GL11.glGetError() == GL11.GL_STACK_UNDERFLOW, "Underflow reports compatibility GL error");
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 0, "Underflow retains empty stack");
        state(2, 0, 2, 2);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "All errors consumed");
        GL11.glClear(GL11.GL_ACCUM_BUFFER_BIT);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Absent accumulation buffer clear is harmless");
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_ACCUM_BUFFER_BIT);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Combined original clear mask is valid");
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_ACCUM_BUFFER_BIT | 0x800);
        check(GL11.glGetError() == GL11.GL_INVALID_VALUE, "Undefined clear bits retain actual GL error");
        org.lwjglx.opengl.Display.setVSyncEnabled(false);
        org.lwjglx.opengl.Display.update(false);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Original Display.update presents without GLFW");
        org.lwjglx.opengl.Display.setVSyncEnabled(true);
        org.lwjglx.opengl.Display.update(true);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Original update retains actual DOM event pump");
        report(checks);
    }
}
