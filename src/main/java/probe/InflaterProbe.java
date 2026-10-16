package probe;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/** Standard inflate results, including valid no-progress states; no original game classes. */
public final class InflaterProbe {
    private static final byte[] COMPRESSED = bytes(120,156,75,42,202,47,47,78,45,210,205,204,75,203,73,44,73,45,210,77,206,207,43,41,74,76,46,209,77,26,149,25,149,25,149,25,97,50,0,165,207,153,192);
    private static final byte[] EXPECTED = "browser-inflater-contract-".repeat(40).getBytes(StandardCharsets.UTF_8);
    public static void main(String[] args) throws Exception {
        String[] ids = {"new-empty-input", "small-output-progress", "single-byte-input", "truncated-input",
                "malformed-input", "preset-dictionary", "reset-empty-input", "explicit-empty-input"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int index = 0; index < ids.length; index++) {
            Inflater inflater = new Inflater();
            int checks = 0;
            int contentHash = 0;
            try {
                if (index == 0 || index == 7) {
                    if (index == 7) inflater.setInput(new byte[0]);
                    if (inflater.inflate(new byte[289]) != 0 || !inflater.needsInput() || inflater.finished()
                            || inflater.getBytesRead() != 0 || inflater.getBytesWritten() != 0) throw new AssertionError("Empty input differs");
                    checks = 1;
                } else if (index == 4) {
                    inflater.setInput(bytes(255,255,255,255,255));
                    try { inflater.inflate(new byte[100]); throw new AssertionError("Malformed input accepted"); }
                    catch (DataFormatException expected) { checks = 1; }
                } else if (index == 5) {
                    byte[] dictionary = "shared-dictionary-prefix::".getBytes(StandardCharsets.UTF_8);
                    byte[] expected = "shared-dictionary-prefix::shared-dictionary-prefix::payload".getBytes(StandardCharsets.UTF_8);
                    inflater.setInput(bytes(120,187,138,145,10,10,43,38,67,166,32,177,50,39,63,49,5,0,178,133,22,253));
                    if (inflater.inflate(new byte[100]) != 0 || !inflater.needsDictionary()) throw new AssertionError("Dictionary request differs");
                    inflater.setDictionary(dictionary);
                    byte[] decoded = drain(inflater, 13);
                    if (!inflater.finished() || !Arrays.equals(expected, decoded)) throw new AssertionError("Dictionary decode differs");
                    checks = 1; contentHash = Arrays.hashCode(decoded);
                } else {
                    byte[] decoded;
                    if (index == 2) {
                        ByteArrayOutputStream output = new ByteArrayOutputStream();
                        byte[] buffer = new byte[17];
                        int cursor = 0;
                        for (int limit = 0; !inflater.finished() && limit < 10000; limit++) {
                            if (inflater.needsInput() && cursor < COMPRESSED.length) inflater.setInput(COMPRESSED, cursor++, 1);
                            int length = inflater.inflate(buffer);
                            output.write(buffer, 0, length);
                            if (length == 0 && inflater.needsInput() && cursor == COMPRESSED.length) break;
                        }
                        decoded = output.toByteArray();
                    } else {
                        inflater.setInput(COMPRESSED, 0, COMPRESSED.length - (index == 3 ? 4 : 0));
                        decoded = drain(inflater, 31);
                    }
                    if (!Arrays.equals(EXPECTED, decoded) || (index == 3 ? inflater.finished() || !inflater.needsInput() : !inflater.finished()))
                        throw new AssertionError("Inflater output/state differs: " + ids[index]);
                    if (index == 6) {
                        inflater.reset();
                        if (inflater.inflate(new byte[5]) != 0 || !inflater.needsInput() || inflater.finished()) throw new AssertionError("Reset input differs");
                        inflater.setInput(COMPRESSED);
                        if (!Arrays.equals(EXPECTED, drain(inflater, 19)) || !inflater.finished()) throw new AssertionError("Reset decode differs");
                    }
                    checks = 1; contentHash = Arrays.hashCode(decoded);
                }
            } catch (Exception failure) {
                System.out.println(ids[index] + ": " + failure); throw failure;
            } finally { inflater.end(); }
            if (index != 0) json.append(',');
            json.append("{\"id\":\"").append(ids[index]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "checks", checks); json.append(','); integer(json, "contentHash", contentHash); json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static byte[] drain(Inflater inflater, int chunk) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[chunk];
        for (int limit = 0; limit < 10000; limit++) {
            int length = inflater.inflate(buffer);
            output.write(buffer, 0, length);
            if (inflater.finished() || length == 0 && (inflater.needsInput() || inflater.needsDictionary())) return output.toByteArray();
        }
        throw new AssertionError("Inflater made no bounded progress");
    }
    private static byte[] bytes(int... values) {
        byte[] bytes = new byte[values.length];
        for (int index = 0; index < values.length; index++) bytes[index] = (byte) values[index];
        return bytes;
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
