package port.host;

/** Primitive-array transport for the original FMOD JNI output arrays. */
public final class FmodArrays {
    private FmodArrays() {}
    public static int arrayLength(long[] array) { return array.length; }
    public static void write(long[] array, String values) {
        String[] fields = values.isEmpty() ? new String[0] : values.split(",", -1);
        if (fields.length > array.length) throw new IllegalArgumentException("FMOD output array too short");
        for (int i = 0; i < fields.length; i++) array[i] = Long.parseLong(fields[i]);
    }
}
