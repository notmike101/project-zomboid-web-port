import org.lwjgl.opengl.GL11;

/** Actual vendor entry points over the prepared host facade, with no game startup. */
public final class ViewportQualification {
    public static native void state(int x, int y, int width, int height);
    public static native void report(int checks);
    public static native void rasterSurface(boolean multisample);
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
        GL11.glPushAttrib(GL11.GL_VIEWPORT_BIT | GL11.GL_COLOR_BUFFER_BIT);
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 1, "Combined supported groups push once");
        GL11.glViewport(0, 0, 1, 1);
        GL11.glPopAttrib();
        check(GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH) == 0, "Combined groups pop once");
        state(2, 0, 2, 2);
        check(GL11.glGetError() == GL11.GL_NO_ERROR, "Combined groups preserve original GL state");
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
        for(int face:new int[]{GL11.GL_FRONT,GL11.GL_BACK,GL11.GL_FRONT_AND_BACK}){
            GL11.glPolygonMode(face,GL11.GL_FILL);
            check(GL11.glGetError()==GL11.GL_NO_ERROR,"Filled face keeps real WebGL rasterization");
        }
        GL11.glPolygonMode(0,GL11.GL_FILL);
        check(GL11.glGetError()==GL11.GL_INVALID_ENUM,"Invalid polygon face reports original GL error");
        GL11.glPolygonMode(GL11.GL_FRONT_AND_BACK,0);
        check(GL11.glGetError()==GL11.GL_INVALID_ENUM,"Invalid polygon mode reports original GL error");
        for(int mode:new int[]{GL11.GL_LINE,GL11.GL_POINT}){
            boolean unsupported=false,cleanup=false;
            try { GL11.glPolygonMode(GL11.GL_FRONT_AND_BACK,mode); }
            catch(UnsupportedOperationException exception){unsupported=exception.getMessage().contains("rasterization mode");}
            finally { cleanup=true; }
            check(unsupported&&cleanup,"Unimplemented rasterization rejects through actual Java finally");
        }
        GL11.glPolygonMode(GL11.GL_FRONT_AND_BACK,GL11.GL_FILL);
        check(GL11.glGetError()==GL11.GL_NO_ERROR,"Rejected modes preserve fill and GL state");
        for(int array:new int[]{GL11.GL_VERTEX_ARRAY,GL11.GL_COLOR_ARRAY,GL11.GL_TEXTURE_COORD_ARRAY}){
            GL11.glDisableClientState(array);
            check(!GL11.glIsEnabled(array)&&GL11.glGetInteger(array)==0,"Conventional array remains disabled");
        }
        boolean clientRejected=false;
        try { GL11.glEnableClientState(GL11.GL_VERTEX_ARRAY); }
        catch(UnsupportedOperationException expected){clientRejected=true;}
        check(clientRejected,"Unimplemented conventional input rejects before state mutation");
        GL11.glDisableClientState(0);
        check(GL11.glGetError()==GL11.GL_INVALID_ENUM,"Invalid client array reports GL enum error");
        GL11.glLineWidth(1);
        GL11.glFrontFace(GL11.GL_CW);
        check(GL11.glGetInteger(GL11.GL_FRONT_FACE)==GL11.GL_CW,"Actual front winding changed");
        GL11.glFrontFace(GL11.GL_CCW);
        GL11.glEnable(GL11.GL_LINE_SMOOTH);
        check(GL11.glIsEnabled(GL11.GL_LINE_SMOOTH)&&GL11.glGetInteger(GL11.GL_LINE_SMOOTH)==1,"Actual compatibility line-smooth state enabled");
        check(GL11.glGetInteger(org.lwjgl.opengl.GL13.GL_SAMPLE_BUFFERS)==1,"Default surface really multisampled");
        rasterSurface(false);
        boolean smoothRejected=false,smoothFinally=false;
        try { GL11.glDrawArrays(GL11.GL_LINES,0,2); }
        catch(UnsupportedOperationException expected){smoothRejected=true;}
        finally { smoothFinally=true; }
        check(smoothRejected&&smoothFinally,"Single-sample smooth line rejects through Java finally");
        rasterSurface(true);
        GL11.glDrawArrays(GL11.GL_LINES,0,2);
        check(GL11.glGetError()==GL11.GL_NO_ERROR,"Multisample line uses real GPU coverage");
        GL11.glDisable(GL11.GL_LINE_SMOOTH);
        check(!GL11.glIsEnabled(GL11.GL_LINE_SMOOTH)&&GL11.glGetInteger(GL11.GL_LINE_SMOOTH)==0,"Line smooth state disabled");
        report(checks);
    }
}
