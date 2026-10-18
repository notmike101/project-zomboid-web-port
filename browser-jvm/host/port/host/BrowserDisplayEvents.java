package port.host;

/** Real browser event boundary; the original Display owns all Java caches and listeners. */
public final class BrowserDisplayEvents {
    private BrowserDisplayEvents() {}
    public static native void pollEvents();
    public static native int windowAttrib(long window, int attribute);
    public static native void setInputMode(long window, int selector, int value);
    private static native void checkSurfaceCursor();

    /** Reject before original updateMouseCursor writes its cached mode. */
    public static void checkCursorState(int previous) {
        if (zombie.core.Core.getInstance().getOptionLockCursorToWindow()
                || previous != -1 && previous != 212993 && previous != 212994) {
            throw new UnsupportedOperationException("Disabled/relative browser cursor is unqualified");
        }
        checkSurfaceCursor();
    }
}
