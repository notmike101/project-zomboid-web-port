package port.host;

/** Browser monotonic time in seconds; no GLFW/windowing initialization claim. */
public final class BrowserClock {

    private BrowserClock() {}

    public static native double seconds();
}
