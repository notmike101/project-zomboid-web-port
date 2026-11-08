package port.host;

/** Java 21 clamp semantics for the original game callers on the Java 17 browser runtime. */
public final class MathClampSupport {
    private MathClampSupport() { }

    public static long clamp(long value, long min, long max) {
        if (min > max) throw new IllegalArgumentException(min + " > " + max);
        return Math.min(max, Math.max(value, min));
    }

    public static double clamp(double value, double min, double max) {
        if (!(min < max)) {
            if (Double.isNaN(min)) throw new IllegalArgumentException("min is NaN");
            if (Double.isNaN(max)) throw new IllegalArgumentException("max is NaN");
            if (Double.compare(min, max) > 0) throw new IllegalArgumentException(min + " > " + max);
        }
        return Math.min(max, Math.max(value, min));
    }

    public static float clamp(float value, float min, float max) {
        if (!(min < max)) {
            if (Float.isNaN(min)) throw new IllegalArgumentException("min is NaN");
            if (Float.isNaN(max)) throw new IllegalArgumentException("max is NaN");
            if (Float.compare(min, max) > 0) throw new IllegalArgumentException(min + " > " + max);
        }
        return Math.min(max, Math.max(value, min));
    }
}
