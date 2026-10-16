package probe;

/** Binary32 FMA checks. NaNs use canonical bits because payloads are unspecified. */
public final class FmaProbe {
    public static void main(String[] args) {
        int[][] edges = {
                {0, 0, 0}, {0x80000000, 0x3f800000, 0x80000000}, {0x80000000, 0x3f800000, 0},
                {0x3f800000, 0x3f800000, 0xbf800000}, {0x3f800001, 0x3f7ffffe, 0xbf800000},
                {0x7f7fffff, 0x40000000, 0xff7fffff}, {0x7f7fffff, 0x40000000, 0},
                {1, 0x3f000000, 0}, {1, 0xbf000000, 0}, {3, 0x3f000000, 0},
                {0x007fffff, 0x3f800000, 1}, {0x00800000, 0x3f000000, 0x80000001},
                {0x3f800000, 0x3f800000, 0x33800000}, {0x3f800001, 0x3f800000, 0x33800000},
                {0x7f800000, 0, 0}, {0x7f800000, 0x3f800000, 0xff800000},
                {0x7fc01234, 0x3f800000, 0}, {0x3f800000, 0x7f800000, 0},
                {0xff800000, 0x3f800000, 0}, {0x3f800000, 0x3f800000, 0x7f800000},
                {0x7f7fffff, 0x3f800000, 0x73000000}, {0xff7fffff, 0x3f800000, 0xf3000000},
                {0x00000001, 0x00000001, 0}, {0x80000001, 0x00000001, 0}
        };
        int seed = 0x184ac91d;
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"nanRule\":\"canonical Float.floatToIntBits; finite values and signed zeros stay exact\",\"cases\":[");
        for (int i = 0; i < 128; i++) {
            int[] bits = new int[3];
            for (int j = 0; j < 3; j++) {
                seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
                bits[j] = i < edges.length ? edges[i][j] : seed;
            }
            float a = Float.intBitsToFloat(bits[0]);
            float b = Float.intBitsToFloat(bits[1]);
            float c = Float.intBitsToFloat(bits[2]);
            float result = Math.fma(a, b, c);
            int resultBits = Float.floatToIntBits(result);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"fma-").append(i).append("\",\"inputs\":[");
            for (int j = 0; j < 3; j++) {
                if (j != 0) json.append(',');
                append(json, bits[j]);
            }
            json.append("],\"outputs\":{\"canonicalResultBits\":");
            append(json, resultBits);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
