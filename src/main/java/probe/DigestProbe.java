package probe;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.DigestException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/** SHA-1 vectors and standard-library lifecycle checks. No original game classes. */
public final class DigestProbe {
    private static int checks;
    private static final String EMPTY = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    private static final String ABC = "a9993e364706816aba3e25717850c26c9cd0d89d";

    public static void main(String[] args) throws Exception {
        String[] names = {"empty", "abc", "nist-multiblock", "padding-55", "padding-56", "padding-63",
                "block-64", "blocks-128", "chunked", "bytewise", "heap-buffer", "direct-buffer",
                "reset-and-reuse", "output-buffer", "invalid-input", "aliases-and-equality"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            checks = 0;
            byte[] result = exercise(i);
            check(result.length == 20);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"checks\":");
            append(json, checks);
            for (int word = 0; word < 5; word++) {
                int offset = word * 4;
                int value = (result[offset] & 255) << 24 | (result[offset + 1] & 255) << 16
                        | (result[offset + 2] & 255) << 8 | result[offset + 3] & 255;
                json.append(",\"digestWord").append(word).append("\":");
                append(json, value);
            }
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static byte[] exercise(int index) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-1");
        byte[] abc = "abc".getBytes(StandardCharsets.US_ASCII);
        if (index < 3) {
            String input = index == 0 ? "" : index == 1 ? "abc" : "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
            byte[] result = digest.digest(input.getBytes(StandardCharsets.US_ASCII));
            check(hex(result).equals(index == 0 ? EMPTY : index == 1 ? ABC : "84983e441c3bd26ebaae4aa1f95129e5e54670f1"));
            return result;
        }
        if (index < 7) {
            byte[] input = new byte[]{55, 56, 63, 64};
            byte[] data = new byte[input[index - 3]];
            Arrays.fill(data, (byte) 'a');
            return digest.digest(data);
        }
        byte[] binary = new byte[128];
        for (int i = 0; i < binary.length; i++) binary[i] = (byte) (i * 37 + 11);
        switch (index) {
            case 7: return digest.digest(binary);
            case 8:
                digest.update(binary, 0, 1);
                digest.update(binary, 1, 54);
                digest.update(binary, 55, 9);
                digest.update(binary, 64, 64);
                return digest.digest();
            case 9:
                for (byte value : binary) digest.update(value);
                return digest.digest();
            case 10, 11: {
                ByteBuffer input = index == 10 ? ByteBuffer.allocate(132) : ByteBuffer.allocateDirect(132);
                input.position(2);
                input.put(binary).flip().position(2);
                input = input.asReadOnlyBuffer();
                int limit = input.limit();
                digest.update(input);
                check(input.position() == limit && input.limit() == limit);
                return digest.digest();
            }
            case 12: {
                check(hex(digest.digest(abc)).equals(ABC));
                check(hex(digest.digest()).equals(EMPTY));
                digest.update(binary);
                digest.reset();
                check(hex(digest.digest()).equals(EMPTY));
                digest.update(abc);
                return digest.digest();
            }
            case 13: {
                digest.update(abc);
                byte[] output = new byte[40];
                Arrays.fill(output, (byte) 0x5a);
                reject(() -> digest.digest(output, 5, 19), DigestException.class);
                reject(() -> digest.digest(output, -1, 20), DigestException.class);
                reject(() -> digest.digest(output, 0, -1), DigestException.class);
                reject(() -> digest.digest(new byte[10], 0, 20), IllegalArgumentException.class);
                reject(() -> digest.digest(null, 0, 20), IllegalArgumentException.class);
                check(digest.digest(output, 5, 25) == 20);
                for (int i = 0; i < output.length; i++) {
                    if (i < 5 || i >= 25) check(output[i] == 0x5a);
                }
                byte[] result = Arrays.copyOfRange(output, 5, 25);
                check(hex(result).equals(ABC));
                check(hex(digest.digest()).equals(EMPTY));
                return result;
            }
            case 14:
                reject(() -> digest.update((byte[]) null), NullPointerException.class);
                reject(() -> digest.update(null, 0, 1), IllegalArgumentException.class);
                reject(() -> digest.update(abc, -1, 1), ArrayIndexOutOfBoundsException.class);
                reject(() -> digest.update(abc, 0, -1), ArrayIndexOutOfBoundsException.class);
                reject(() -> digest.update(abc, 2, 2), IllegalArgumentException.class);
                reject(() -> digest.update((ByteBuffer) null), NullPointerException.class);
                reject(() -> MessageDigest.getInstance(null), NullPointerException.class);
                reject(() -> MessageDigest.getInstance("NO-SUCH-DIGEST"), NoSuchAlgorithmException.class);
                return digest.digest(abc);
            default: {
                MessageDigest alias = MessageDigest.getInstance("sha1");
                check(alias.getAlgorithm().equals("sha1") && alias.getDigestLength() == 20);
                check(MessageDigest.isEqual(null, null));
                check(!MessageDigest.isEqual(abc, null) && !MessageDigest.isEqual(null, abc));
                check(MessageDigest.isEqual(new byte[0], new byte[0]));
                check(!MessageDigest.isEqual(new byte[0], abc) && !MessageDigest.isEqual(abc, new byte[0]));
                check(MessageDigest.isEqual(abc, abc.clone()));
                check(!MessageDigest.isEqual(abc, new byte[]{'a', 'b', 'd'}));
                check(!MessageDigest.isEqual(abc, new byte[]{'a', 'b', 'c', 'd'}));
                return alias.digest(abc);
            }
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder();
        for (byte value : bytes) {
            text.append(Character.forDigit((value & 255) >>> 4, 16));
            text.append(Character.forDigit(value & 15, 16));
        }
        return text.toString();
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Digest contract differs");
        checks++;
    }

    private interface ThrowingAction { void run() throws Exception; }
    private static void reject(ThrowingAction action, Class<? extends Throwable> expected) throws Exception {
        try { action.run(); }
        catch (Throwable failure) {
            if (expected.isInstance(failure)) { checks++; return; }
            throw new AssertionError("Unexpected digest rejection", failure);
        }
        throw new AssertionError("Invalid digest operation accepted");
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
