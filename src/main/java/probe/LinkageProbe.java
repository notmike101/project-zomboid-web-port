package probe;

/** Runtime compatibility only. This probe does not load original game classes. */
public final class LinkageProbe {
    public static void main(String[] args) {
        String[] names = {"initializer-default", "initializer-message", "initializer-cause",
                "initializer-null-cause", "initializer-null-message", "link-default",
                "link-message", "link-null-cause"};
        Throwable cause = new IllegalArgumentException("cause");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            LinkageError error = switch (i) {
                case 0 -> new ExceptionInInitializerError();
                case 1 -> new ExceptionInInitializerError("message");
                case 2 -> new ExceptionInInitializerError(cause);
                case 3 -> new ExceptionInInitializerError((Throwable) null);
                case 4 -> new ExceptionInInitializerError((String) null);
                case 5, 7 -> new UnsatisfiedLinkError();
                default -> new UnsatisfiedLinkError("message");
            };
            Throwable expectedCause = i == 2 ? cause : null;
            String expectedMessage = i == 1 || i == 6 ? "message" : null;
            int checks = 0;
            if (error.getCause() == expectedCause) checks |= 1;
            if (expectedMessage == null ? error.getMessage() == null : expectedMessage.equals(error.getMessage())) checks |= 2;
            if (i < 5 ? ((ExceptionInInitializerError) error).getException() == expectedCause
                    : error instanceof UnsatisfiedLinkError) checks |= 4;
            int causeChecks;
            try {
                Throwable assigned = i == 7 ? null : cause;
                Throwable returned = error.initCause(assigned);
                causeChecks = returned == error && error.getCause() == assigned ? 1 : 0;
                try {
                    error.initCause(cause);
                } catch (IllegalStateException expected) {
                    causeChecks |= 2;
                }
            } catch (IllegalStateException expected) {
                causeChecks = error.getCause() == expectedCause ? 4 : 0;
            }
            if (checks != 7 || causeChecks != (i < 5 ? 4 : 3)) {
                throw new AssertionError(names[i] + " constructor/cause mismatch");
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"constructorChecks\":");
            append(json, checks);
            json.append(",\"causeChecks\":");
            append(json, causeChecks);
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
