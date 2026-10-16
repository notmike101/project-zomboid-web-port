package probe;

import zombie.core.Core;

/** Browser-only original initializer probe. Never run this entry point on a desktop JVM. */
public final class CoreBootProbe {
    public static void main(String[] args) {
        boolean debug = Core.debug;
        Core core = Core.getInstance();
        if (core == null) throw failure("Core singleton missing after initialization");
        int width = core.getScreenWidth();
        int height = core.getScreenHeight();
        int volume = core.getOptionSoundVolume();
        int state = (core == Core.getInstance() ? 1 : 0) | (core.getOptionZoom() ? 2 : 0)
                | (core.isFullScreen() ? 4 : 0) | (debug ? 8 : 0);
        if (width != 1280 || height != 720 || volume != 10 || state != 3)
            throw failure("Original initial defaults differ: " + width + "," + height + "," + volume + "," + state);
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[{\"id\":\"original-core-initialization\",\"inputs\":[],\"outputs\":{");
        output(json, "width", width); json.append(',');
        output(json, "height", height); json.append(',');
        output(json, "soundVolume", volume); json.append(',');
        output(json, "state", state);
        System.out.println(json.append("}}],\"pass\":true}"));
    }
    private static void output(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
}
