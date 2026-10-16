package port.runtime;

import java.util.Objects;
import java.util.concurrent.TimeUnit;

/** Standard saturating conversions; an overflowing timeout must never change sign. */
public final class TimeUnitSupport {
    private static final long[] NANOS = {1, 1000, 1000000, 1000000000, 60000000000L, 3600000000000L, 86400000000000L};
    public static long convert(TimeUnit target, long value, TimeUnit source) {
        long from = NANOS[Objects.requireNonNull(source).ordinal()];
        long to = NANOS[Objects.requireNonNull(target).ordinal()];
        if (from <= to) return value / (to / from);
        long factor = from / to;
        if (value > Long.MAX_VALUE / factor) return Long.MAX_VALUE;
        if (value < Long.MIN_VALUE / factor) return Long.MIN_VALUE;
        return value * factor;
    }
}
