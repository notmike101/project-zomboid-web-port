package probe;

import zombie.core.math.PZMath;

/** Calls shipped bytecode. Contains no implementation of angle arithmetic. */
public final class AngleProbe {
    public static void main(String[] args) {
        String[] names = {"ordinary", "alpha-zero", "alpha-one", "positive-seam",
                "negative-seam", "half-turn-below", "half-turn-at", "half-turn-above"};
        float[][] cases = {
                {-1.0f, 1.0f, 0.25f},
                {-1.0f, 1.0f, 0.0f},
                {-1.0f, 1.0f, 1.0f},
                {3.0f, -3.0f, 0.5f},
                {-3.0f, 3.0f, 0.5f},
                {0.0f, Float.intBitsToFloat(0x40490fda), 0.5f},
                {0.0f, Float.intBitsToFloat(0x40490fdb), 0.5f},
                {0.0f, Float.intBitsToFloat(0x40490fdc), 0.5f}
        };
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-f32-raw-bits\",\"cases\":[");
        for (int i = 0; i < cases.length; i++) {
            float[] c = cases[i];
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[");
            for (int j = 0; j < c.length; j++) {
                if (j != 0) json.append(',');
                appendFloat(json, c[j]);
            }
            json.append("],\"outputs\":{");
            json.append("\"closestAngle\":");
            appendFloat(json, PZMath.getClosestAngle(c[0], c[1]));
            json.append(",\"lerpAngle\":");
            appendFloat(json, PZMath.lerpAngle(c[0], c[1], c[2]));
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void appendFloat(StringBuilder json, float value) {
        // Compare bits, not decimal formatting. Strings preserve the complete representation.
        String bits = Integer.toHexString(Float.floatToRawIntBits(value));
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
