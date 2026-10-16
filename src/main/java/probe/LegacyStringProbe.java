package probe;

/** Standard-library behavior only. No game code or platform charset dependency. */
@SuppressWarnings("deprecation")
public final class LegacyStringProbe {
    public static void main(String[] args) {
        String[] names = {"unsigned-bytes", "slice", "high-byte", "truncated-high-byte",
                "negative-high-byte", "empty-end", "negative-offset", "negative-count",
                "offset-past-end", "count-past-end", "range-overflow", "max-count",
                "null-bytes", "null-invalid-range", "min-offset", "min-count"};
        int[] high = {0, 0, 0x12, 0x1234, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
        int[] offset = {0, 1, 0, 0, 0, 4, -1, 0, 5, 2, Integer.MAX_VALUE, 0, 0, -1, Integer.MIN_VALUE, 0};
        int[] count = {4, 2, 4, 4, 4, 0, 1, -1, 0, 3, 2, Integer.MAX_VALUE, 0, -1, 1, Integer.MIN_VALUE};
        String[] expected = {"\u0000\u007f\u0080\u00ff", "\u007f\u0080", "\u1200\u127f\u1280\u12ff",
                "\u3400\u347f\u3480\u34ff", "\uff00\uff7f\uff80\uffff", ""};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            byte[] bytes = i == 12 || i == 13 ? null : new byte[]{0, 127, (byte) 128, (byte) 255};
            int measure;
            int hash;
            try {
                String result = new String(bytes, high[i], offset[i], count[i]);
                if (i >= expected.length || !result.equals(expected[i])) throw new AssertionError(names[i]);
                measure = result.length();
                hash = result.hashCode();
            } catch (NullPointerException failure) {
                if (i != 12 && i != 13) throw failure;
                measure = -1;
                hash = "NullPointerException".hashCode();
            } catch (StringIndexOutOfBoundsException failure) {
                if (i < expected.length || i == 12 || i == 13) throw failure;
                measure = -2;
                hash = "StringIndexOutOfBoundsException".hashCode();
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, measure);
            json.append(",\"contentHash\":");
            append(json, hash);
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
