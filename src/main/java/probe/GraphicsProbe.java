package probe;

import org.lwjgl.opengl.GL11;
import org.teavm.jso.JSExport;
import port.runtime.BrowserGraphics;
import zombie.core.Color;

/** Browser-only graphics assertions. Never run this entry point on a desktop JVM. */
public final class GraphicsProbe {
    public static void main(String[] args) {
        float[][] colors = {{1, 0, 0, 1}, {0, 1, 0, 1}, {0.25f, 0.5f, 0.75f, 0.75f}, {-1, 2, 0.25f, 1}};
        StringBuilder json = new StringBuilder("{\"category\":\"browser-graphics\",\"cases\":[");
        for (int i = 0; i < colors.length; i++) {
            if (i != 0) json.append(',');
            float[] c = colors[i];
            json.append(render(c[0], c[1], c[2], c[3], true));
        }
        GL11.glEnable(-1);
        int invalidEnum = GL11.glGetError();
        int consumed = GL11.glGetError();
        if (invalidEnum != 0x0500 || consumed != 0) throw failure("WebGL error state differs: " + invalidEnum + "," + consumed);
        System.out.println(json.append("],\"invalidEnum\":").append(invalidEnum)
                .append(",\"consumedError\":").append(consumed).append(",\"pass\":true}"));
    }

    @JSExport
    public static String renderColor(float red, float green, float blue, float brightness) {
        return render(red, green, blue, brightness, false);
    }

    private static String render(float red, float green, float blue, float brightness, boolean exactPixels) {
        if (!Float.isFinite(red) || !Float.isFinite(green) || !Float.isFinite(blue)
                || !Float.isFinite(brightness) || brightness < 0 || brightness > 1) {
            throw new IllegalArgumentException("Expected finite colors and brightness between zero and one");
        }
        Color color = new Color(red, green, blue, 1);
        color.scale(brightness);
        GL11.glDisable(0x0BD0);
        GL11.glClearColor(color.r, color.g, color.b, color.a);
        GL11.glClear(0x4000);
        int[] actual = BrowserGraphics.readPixel();
        float[] values = {color.r, color.g, color.b, color.a};
        float[] clearState = BrowserGraphics.clearState();
        StringBuilder json = new StringBuilder("{\"pixels\":[");
        for (int i = 0; i < actual.length; i++) {
            if (Float.floatToRawIntBits(clearState[i]) != Float.floatToRawIntBits(values[i])) {
                throw failure("WebGL clear state differs from original float channel " + i);
            }
            // Fixed cases avoid half-byte positions. Interactive UNORM readback permits one byte; clear-state bits remain exact.
            int expected = Math.round(values[i] * 255);
            if (Math.abs(actual[i] - expected) > (exactPixels ? 0 : 1)) throw failure("Framebuffer channel " + i + " differs: " + actual[i] + " != " + expected + "; original float=" + values[i]);
            if (i != 0) json.append(',');
            json.append(actual[i]);
        }
        int error = GL11.glGetError();
        if (error != 0) throw failure("WebGL operation error: " + error);
        json.append("],\"clearStateBits\":[");
        for (int i = 0; i < values.length; i++) {
            if (i != 0) json.append(',');
            json.append('"').append(Integer.toHexString(Float.floatToRawIntBits(clearState[i]))).append('"');
        }
        return json.append("],\"exactPixels\":").append(exactPixels).append(",\"error\":0}").toString();
    }

    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
}
