import port.host.BrowserMouse;

/** Actual browser input through original vendor polling and queue. */
public final class MouseQualification {

    static native void ready(int phase);

    static native void report(String text);

    public static void main(String[] args) {
        try {
            for (int phase = 0; phase < 12; phase++) {
                ready(phase);
                BrowserMouse.poll();
                int moves = 0,
                    downs = 0,
                    ups = 0,
                    releaseX = 0,
                    releaseY = 0;
                long previous = 0;
                while (org.lwjglx.input.Mouse.next()) {
                    long now = org.lwjglx.input.Mouse.getEventNanoseconds();
                    if (now < previous) throw new AssertionError(
                        "Event clock regressed"
                    );
                    previous = now;
                    if (org.lwjglx.input.Mouse.getEventButton() < 0) moves++;
                    else if (
                        org.lwjglx.input.Mouse.getEventButtonState()
                    ) downs++;
                    else {
                        ups++;
                        releaseX = org.lwjglx.input.Mouse.getEventX();
                        releaseY = org.lwjglx.input.Mouse.getEventY();
                    }
                }
                report(
                    "{\"phase\":" +
                        phase +
                        ",\"x\":" +
                        org.lwjglx.input.Mouse.getX() +
                        ",\"y\":" +
                        org.lwjglx.input.Mouse.getY() +
                        ",\"left\":" +
                        org.lwjglx.input.Mouse.isButtonDown(0) +
                        ",\"right\":" +
                        org.lwjglx.input.Mouse.isButtonDown(1) +
                        ",\"middle\":" +
                        org.lwjglx.input.Mouse.isButtonDown(2) +
                        ",\"releaseX\":" +
                        releaseX +
                        ",\"releaseY\":" +
                        releaseY +
                        ",\"moves\":" +
                        moves +
                        ",\"downs\":" +
                        downs +
                        ",\"ups\":" +
                        ups +
                        "}"
                );
            }
            ready(12);
            boolean caught = false,
                finished = false;
            try {
                BrowserMouse.poll();
            } catch (IllegalStateException expected) {
                caught = true;
            } finally {
                finished = true;
            }
            if (!caught || !finished) throw new AssertionError(
                "Disposed mouse must throw Java exception and run finally"
            );
            report("{\"disposedCaught\":true,\"finallyRan\":true}");
            report("{\"pass\":true}");
        } catch (Throwable e) {
            report(
                "{\"pass\":false,\"error\":\"" +
                    e.toString().replace("\\", "/").replace("\"", "'") +
                    "\"}"
            );
        }
    }
}
