package probe;

import java.util.IllegalFormatException;
import java.util.MissingFormatArgumentException;

/** Constructor, diagnostic, and catch hierarchy checks for a missing standard exception. */
public final class FormatExceptionProbe {
    public static void main(String[] args) {
        String[] specifiers = {"%s", "%2$d", "", "quote'%", "\u00e9\uD83E\uDDDF", null, "%<s", "%03d"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < specifiers.length; i++) {
            int flags;
            int hash;
            if (i == 5) {
                try { new MissingFormatArgumentException(null); throw new AssertionError("Null specifier accepted"); }
                catch (NullPointerException expected) { flags = 1; hash = "NullPointerException".hashCode(); }
            } else {
                String specifier = specifiers[i];
                MissingFormatArgumentException failure = new MissingFormatArgumentException(specifier);
                String message = "Format specifier '" + specifier + "'";
                if (failure.getFormatSpecifier() != specifier || !failure.getMessage().equals(message)
                        || !failure.getLocalizedMessage().equals(message) || failure.getCause() != null
                        || !(failure instanceof IllegalArgumentException)) throw new AssertionError("Exception contract differs");
                flags = 7;
                hash = failure.getMessage().hashCode();
                if (i == 6) {
                    try { throw failure; }
                    catch (MissingFormatArgumentException caught) {
                        if (caught != failure) throw new AssertionError("Specific catch replaced exception");
                        flags |= 8;
                    }
                    try { throw failure; }
                    catch (IllegalFormatException caught) {
                        if (caught != failure) throw new AssertionError("Superclass catch replaced exception");
                        flags |= 16;
                    }
                }
                if (i == 7) {
                    RuntimeException cause = new IllegalStateException("cause");
                    if (failure.initCause(cause) != failure || failure.getCause() != cause) throw new AssertionError("Cause differs");
                    try { failure.initCause(cause); throw new AssertionError("Repeated cause assignment accepted"); }
                    catch (IllegalStateException expected) { flags |= 32; }
                }
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"format-exception-").append(i).append("\",\"inputs\":[],\"outputs\":{\"flags\":");
            append(json, flags);
            json.append(",\"messageHash\":");
            append(json, hash);
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
