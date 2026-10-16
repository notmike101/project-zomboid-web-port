package probe;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.util.Arrays;
import org.teavm.jso.JSExport;
import zombie.iso.weather.ClimateManager.AirFront;

/** Browser host transports original records. Game state and calculations remain original. */
public final class BrowserSaveProbe {
    public static void main(String[] args) throws Exception {
        AirFrontProbe.main(args);
    }

    @JSExport
    public static String initialSnapshot() throws Exception {
        return encode(AirFrontProbe.save(new AirFront()));
    }

    @JSExport
    public static String advanceSnapshot(String snapshot, int index) throws Exception {
        if (index < 0 || index >= AirFrontProbe.SAMPLES.length) throw new IllegalArgumentException("Unknown snapshot step");
        byte[] input = decode(snapshot);
        AirFront state = new AirFront();
        state.load(new DataInputStream(new ByteArrayInputStream(input)));
        if (index == 0) state.setFrontType(1);
        if (index == 5) state.setFrontType(-1);
        state.addDaySample(AirFrontProbe.SAMPLES[index]);
        byte[] saved = AirFrontProbe.save(state);
        AirFront restored = new AirFront();
        restored.load(new DataInputStream(new ByteArrayInputStream(saved)));
        if (!Arrays.equals(saved, AirFrontProbe.save(restored))) throw new AssertionError("Original snapshot round trip differs");
        return "{\"snapshot\":\"" + encode(saved) + "\",\"case\":" + AirFrontProbe.describe(index, restored, saved) + "}";
    }

    private static byte[] decode(String hex) {
        if (hex == null || hex.length() != 72) throw new IllegalArgumentException("Expected a 36-byte snapshot");
        byte[] bytes = new byte[36];
        for (int i = 0; i < bytes.length; i++) {
            int high = Character.digit(hex.charAt(i * 2), 16);
            int low = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IllegalArgumentException("Invalid snapshot hex");
            bytes[i] = (byte) ((high << 4) | low);
        }
        if (bytes[24] != 0 || bytes[25] != 0 || bytes[26] != 0 || bytes[27] != 2) {
            throw new IllegalArgumentException("Unexpected original snapshot cache length");
        }
        return bytes;
    }

    private static String encode(byte[] bytes) {
        StringBuilder hex = new StringBuilder();
        for (byte value : bytes) {
            int unsigned = value & 255;
            hex.append(Character.forDigit(unsigned >>> 4, 16));
            hex.append(Character.forDigit(unsigned & 15, 16));
        }
        return hex.toString();
    }
}
