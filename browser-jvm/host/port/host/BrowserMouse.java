package port.host;

/** Delivers real DOM motion/button events through the unchanged vendor event queue. */
public final class BrowserMouse {

    private BrowserMouse() {}

    private static native String drain();

    public static native int button(long window, int index);

    public static void poll() {
        String text = drain();
        if (!text.isEmpty()) for (String event : text.split("\n")) {
            String[] f = event.split(",", -1);
            if (f.length != 3) throw new IllegalArgumentException(
                "Invalid DOM event transport"
            );
            if (f[0].equals("M")) org.lwjglx.input.Mouse.addMoveEvent(
                Double.parseDouble(f[1]),
                Double.parseDouble(f[2])
            );
            else if (f[0].equals("B")) org.lwjglx.input.Mouse.addButtonEvent(
                Integer.parseInt(f[1]),
                f[2].equals("1")
            );
            else throw new IllegalArgumentException("Unsupported DOM event");
        }
        org.lwjglx.input.Mouse.poll();
    }
}
