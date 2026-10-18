import org.lwjglx.opengl.Display;

/** Original vendor cache/created branches over the real browser document title. */
public final class DisplayTitleQualification {
    public static native boolean observe(String expected, int calls);
    public static native void attach(boolean connected);
    public static native void loseContext();
    public static native void report(int checks);
    private static int checks;

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
        checks++;
    }

    private static String cachedTitle() throws Exception {
        var field = Display.class.getDeclaredField("windowTitle");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    public static void main(String[] args) throws Exception {
        check(Display.isCreated(), "Actual browser graphics context exists");
        Display.setTitle("Project Zomboid");
        check(cachedTitle().equals("Project Zomboid"), "Original vendor cache assignment retained");
        check(observe("Project Zomboid", 1), "Actual document title");
        Display.setTitle("Zomboid Ω 🧟");
        check(observe("Zomboid Ω 🧟", 2), "Unicode document title");
        Display.setTitle("");
        check(observe("", 3), "Empty document title");
        attach(false);
        boolean caught = false, finalized = false;
        try { Display.setTitle("closed surface"); }
        catch (IllegalStateException expected) { caught = true; }
        finally { finalized = true; }
        check(caught && finalized, "Closed surface delivers Java exception and finally");
        check(cachedTitle().equals("closed surface"), "Original cache assignment precedes host rejection");
        check(observe("", 4), "Rejected operation leaves document title unchanged");
        attach(true);
        Display.setTitle("Ready");
        check(observe("Ready", 5), "Reconnected owned document updates");
        loseContext();
        check(!Display.isCreated(), "Actual context loss preserves original created branch");
        Display.setTitle("cached after context loss");
        check(cachedTitle().equals("cached after context loss"), "Original uncreated cache still updates");
        check(observe("Ready", 5), "Uncreated branch does not invoke host title setter");
        report(checks);
    }
}
