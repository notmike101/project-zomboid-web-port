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

    /** Invokes a retained callback on the current native owner and reports its Java exception. */
    public static String dispatchCallback(fmod.fmod.FMOD_STUDIO_EVENT_CALLBACK callback,
            String method, long instance, String marker, int position) {
        try {
            switch (method) {
                case "started" -> callback.started(instance);
                case "stopped" -> callback.stopped(instance);
                case "timelineMarker" -> callback.timelineMarker(instance, marker, position);
                default -> throw new IllegalArgumentException("Unknown original FMOD callback: " + method);
            }
            return null;
        } catch (Throwable failure) {
            String name = failure.getClass().getName();
            String message = String.valueOf(failure.getMessage());
            if (message.length() > 1024) message = message.substring(0, 1024);
            StringBuilder trace = new StringBuilder();
            StackTraceElement[] frames = failure.getStackTrace();
            for (int i = 0; i < Math.min(frames.length, 16); i++) {
                if (i != 0) trace.append('\n');
                trace.append(frames[i]);
            }
            String stack = trace.toString();
            if (stack.length() > 4096) stack = stack.substring(0, 4096);
            return "{\"errorName\":" + quote(name) + ",\"errorMessage\":" + quote(message)
                    + ",\"errorStack\":" + quote(stack) + "}";
        }
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        String hex = "0123456789abcdef";
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') result.append('\\').append(c);
            else if (c < 32) result.append("\\u00").append(hex.charAt(c >>> 4)).append(hex.charAt(c & 15));
            else result.append(c);
        }
        return result.append('"').toString();
    }
}
