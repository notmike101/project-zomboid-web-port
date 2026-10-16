package probe;

/** Standard package names without runtime class lookup or original game loading. */
public final class PackageNameProbe {
    public static final class Nested { }
    public static void main(String[] args) {
        Class<?>[] types = {String.class, int.class, void.class, int[][].class,
                String[][].class, PackageNameProbe.class, Nested.class, new Object() { }.getClass()};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < types.length; i++) {
            String expected = i < 5 ? "java.lang" : "probe";
            String actual = types[i].getPackageName();
            if (!actual.equals(expected) || actual != actual.intern() || actual != types[i].getPackageName())
                throw new AssertionError("Package name differs for " + types[i].getName());
            if (i != 0) json.append(',');
            json.append("{\"id\":\"package-name-").append(i).append("\",\"inputs\":[],\"outputs\":{\"length\":");
            append(json, actual.length());
            json.append(",\"hash\":");
            append(json, actual.hashCode());
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
