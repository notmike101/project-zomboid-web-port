package port.runtime;

/** The deprecated byte/high-byte String constructor's UTF-16 mapping. */
public final class LegacyStringSupport {
    public static String fromBytes(byte[] bytes, int highByte, int offset, int count) {
        int length = bytes.length;
        if (offset < 0 || count < 0 || offset > length - count) {
            throw new StringIndexOutOfBoundsException("Invalid byte range");
        }
        char[] chars = new char[count];
        for (int i = 0; i < count; i++) {
            chars[i] = (char) ((highByte << 8) | (bytes[offset + i] & 0xff));
        }
        return new String(chars);
    }
}
