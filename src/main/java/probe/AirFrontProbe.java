package probe;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.util.Arrays;
import zombie.iso.weather.ClimateManager.AirFront;

/** Original climate state and serialization. Streams stay entirely in memory. */
public final class AirFrontProbe {
    static final String[] NAMES = {"warm-weak", "warm-peak", "warm-decay", "warm-cache-hold",
                "warm-cache-expired", "cold-reset", "cold-peak", "cold-zero"};
    static final float[] SAMPLES = {0.2f, 0.8f, 0.1f, 0.1f, 0.1f, -0.3f, -0.9f, 0.0f};

    public static void main(String[] args) throws Exception {
        AirFront state = new AirFront();
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < SAMPLES.length; i++) {
            if (i == 0) state.setFrontType(1);
            if (i == 5) state.setFrontType(-1);
            state.addDaySample(SAMPLES[i]);
            byte[] saved = save(state);
            if (saved.length != 36) throw new AssertionError("Unexpected AirFront record size: " + saved.length);
            AirFront restored = new AirFront();
            restored.load(new DataInputStream(new ByteArrayInputStream(saved)));
            if (!Arrays.equals(saved, save(restored))) throw new AssertionError("Original save/load round trip differs: " + NAMES[i]);
            if (i != 0) json.append(',');
            json.append(describe(i, restored, saved));
            state = restored;
        }
        System.out.println(json.append("]}"));
    }

    static String describe(int index, AirFront restored, byte[] saved) throws Exception {
            StringBuilder json = new StringBuilder("{\"id\":\"").append(NAMES[index]).append("\",\"inputs\":[");
            appendFloat(json, SAMPLES[index]);
            json.append("],\"outputs\":{\"days\":");
            appendFloat(json, restored.getDays());
            json.append(",\"maxNoise\":");
            appendFloat(json, restored.getMaxNoise());
            json.append(",\"totalNoise\":");
            appendFloat(json, restored.getTotalNoise());
            json.append(",\"strength\":");
            appendFloat(json, restored.getStrength());
            json.append(",\"frontType\":");
            appendInt(json, restored.getType());
            DataInputStream words = new DataInputStream(new ByteArrayInputStream(saved));
            for (int word = 0; word < saved.length / 4; word++) {
                json.append(",\"savedWord").append(word).append("\":");
                appendInt(json, words.readInt());
            }
            return json.append("}}").toString();
    }

    static byte[] save(AirFront state) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        state.save(new DataOutputStream(bytes));
        return bytes.toByteArray();
    }

    private static void appendFloat(StringBuilder json, float value) {
        append(json, Float.toString(value), Float.floatToRawIntBits(value));
    }

    private static void appendInt(StringBuilder json, int value) {
        append(json, Integer.toString(value), value);
    }

    private static void append(StringBuilder json, String value, int raw) {
        String bits = Integer.toHexString(raw);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
