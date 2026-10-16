package probe;

import zombie.erosion.utils.Noise2D;

/** Original seeded layer construction, sampling, reset, and reconstruction. */
public final class ErosionProbe {
    public static void main(String[] args) {
        Noise2D noise = new Noise2D();
        float[][] points = {{0, 0}, {0.25f, 0.75f}, {-1.25f, 2.5f}, {100.125f, 200.75f}};
        String[] phases = {"one-layer", "three-layers", "reset-rebuild", "alternate-seeds"};
        int[] previous = new int[points.length];
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-f32-raw-bits\",\"cases\":[");
        for (int phase = 0; phase < phases.length; phase++) {
            if (phase == 0) noise.addLayer(17, 3.0f, 0.5f);
            if (phase == 1) {
                noise.addLayer(31, 5.0f, 2.0f);
                noise.addLayer(47, 8.0f, 8.0f);
            }
            if (phase >= 2) {
                noise.reset();
                int offset = phase == 2 ? 0 : 1;
                noise.addLayer(17 + offset, 3.0f, 0.5f);
                noise.addLayer(31 + offset, 5.0f, 2.0f);
                noise.addLayer(47 + offset, 8.0f, 8.0f);
            }
            for (int i = 0; i < points.length; i++) {
                float[] p = points[i];
                float value = noise.layeredNoise(p[0], p[1]);
                if (phase == 1) previous[i] = Float.floatToRawIntBits(value);
                if (phase == 2 && previous[i] != Float.floatToRawIntBits(value)) {
                    throw new AssertionError("Original seeded rebuild differs at point " + i);
                }
                if (phase != 0 || i != 0) json.append(',');
                json.append("{\"id\":\"").append(phases[phase]).append('-').append(i).append("\",\"inputs\":[");
                appendFloat(json, p[0]);
                json.append(',');
                appendFloat(json, p[1]);
                json.append("],\"outputs\":{\"layeredNoise\":");
                appendFloat(json, value);
                json.append("}}");
            }
        }
        System.out.println(json.append("]}"));
    }

    private static void appendFloat(StringBuilder json, float value) {
        if (!Float.isFinite(value)) throw new AssertionError("Expected finite original noise output");
        String bits = Integer.toHexString(Float.floatToRawIntBits(value));
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
