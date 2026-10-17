package port.host;

import org.lwjglx.input.Keyboard;

/** Feeds real browser events through the original vendor keyboard producers. */
public final class BrowserKeyboardEvents {
    private static int scancodeQueries;

    private BrowserKeyboardEvents() {}

    /** Browser physical codes have no OS scancode; retain original portable names. */
    public static int unavailableScancode(int key) {
        scancodeQueries++;
        return -1;
    }

    public static int scancodeQueries() {
        return scancodeQueries;
    }

    private static native String drain();

    /** Call before the normal GameKeyboard cache and Core text-entry lifecycle. */
    public static void poll() {
        String records = drain();
        if (!records.isEmpty()) {
            for (String record : records.split("\n")) {
                String[] fields = record.split(",");
                if (fields.length != 3) {
                    throw new IllegalStateException("Invalid owned keyboard event");
                }
                int value = Integer.parseInt(fields[1]);
                if (fields[0].equals("K")) {
                    Keyboard.addKeyEvent(value, Integer.parseInt(fields[2]));
                } else if (fields[0].equals("C")) {
                    // Original Display.Callbacks casts GLFW codepoints to char.
                    Keyboard.addCharEvent((char) value);
                } else {
                    throw new IllegalStateException("Unknown owned keyboard event");
                }
            }
        }
        Keyboard.poll();
    }
}
