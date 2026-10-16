package probe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.util.Arrays;
import org.teavm.jso.JSExport;
import zombie.core.Color;
import zombie.iso.weather.ClimateColorInfo;

/** Connected original climate colors, callable directly from browser JavaScript. */
public final class ColorProbe {
    private static final String[] NAMES = {"default", "alpha-zero", "alpha-one", "quarter",
            "alias-source", "alias-destination", "copy-isolation", "restore-continue"};
    private static final float[] ALPHAS = {0, 0, 1, 0.25f, 0.5f, 0.75f, 0, 0.5f};
    private static final float[] SCALES = {1, 1, 1, 0.5f, 1, 1, 1, 0.75f};

    public static void main(String[] args) throws Exception {
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < NAMES.length; i++) {
            if (i != 0) json.append(',');
            json.append(colorCase(i));
        }
        System.out.println(json.append("]}"));
    }

    @JSExport
    public static String colorCase(int index) throws Exception {
        if (index < 0 || index >= NAMES.length) throw new IllegalArgumentException("Unknown color case");
        ClimateColorInfo a = new ClimateColorInfo(0.1f, 0.2f, 0.3f, 0.4f, 0.5f, 0.6f, 0.7f, 0.8f);
        ClimateColorInfo b = new ClimateColorInfo(0.9f, 0.8f, 0.7f, 0.6f, 0.4f, 0.3f, 0.2f, 0.1f);
        ClimateColorInfo result = new ClimateColorInfo();
        if (index >= 1 && index <= 5) {
            if (index == 4) result = a;
            if (index == 5) result = b;
            a.interp(b, ALPHAS[index], result);
            result.scale(SCALES[index]);
        } else if (index == 6) {
            result.setTo(a);
            byte[] before = save(result);
            a.scale(0);
            if (!Arrays.equals(before, save(result))) throw new AssertionError("Original copy shares color state");
        } else if (index == 7) {
            a.interp(b, ALPHAS[index], result);
            result = restore(save(result));
            result.scale(SCALES[index]);
        }
        byte[] saved = save(result);
        if (saved.length != 32) throw new AssertionError("Unexpected original color record size");
        ClimateColorInfo restored = restore(saved);
        if (!Arrays.equals(saved, save(restored))) throw new AssertionError("Original color round trip differs");
        StringBuilder json = new StringBuilder("{\"id\":\"").append(NAMES[index]).append("\",\"inputs\":[");
        append(json, Float.toString(ALPHAS[index]), Float.floatToRawIntBits(ALPHAS[index]));
        json.append(',');
        append(json, Float.toString(SCALES[index]), Float.floatToRawIntBits(SCALES[index]));
        json.append("],\"outputs\":{");
        Color[] colors = {restored.getInterior(), restored.getExterior()};
        String[] channels = {"R", "G", "B", "A"};
        for (int i = 0; i < colors.length; i++) {
            Color c = colors[i];
            float[] values = {c.r, c.g, c.b, c.a};
            for (int j = 0; j < values.length; j++) {
                if (i != 0 || j != 0) json.append(',');
                json.append('"').append(i == 0 ? "interior" : "exterior").append(channels[j]).append("\":");
                append(json, Float.toString(values[j]), Float.floatToRawIntBits(values[j]));
            }
        }
        DataInputStream words = new DataInputStream(new ByteArrayInputStream(saved));
        for (int i = 0; i < 8; i++) {
            int word = words.readInt();
            json.append(",\"savedWord").append(i).append("\":");
            append(json, Integer.toString(word), word);
        }
        return json.append("}}").toString();
    }

    private static byte[] save(ClimateColorInfo value) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        value.save(new DataOutputStream(bytes));
        return bytes.toByteArray();
    }

    private static ClimateColorInfo restore(byte[] bytes) throws Exception {
        ClimateColorInfo value = new ClimateColorInfo();
        value.load(new DataInputStream(new ByteArrayInputStream(bytes)), 0);
        return value;
    }

    private static void append(StringBuilder json, String value, int raw) {
        String bits = Integer.toHexString(raw);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
