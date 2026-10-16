package org.teavm.classlib.java.util;

import java.util.Objects;

/** Missing formatter argument with the JDK exception hierarchy and diagnostic. */
public class TMissingFormatArgumentException extends TIllegalFormatException {
    private static final long serialVersionUID = 19190115L;
    private String s;

    public TMissingFormatArgumentException(String specifier) {
        s = Objects.requireNonNull(specifier);
    }

    public String getFormatSpecifier() { return s; }
    @Override public String getMessage() { return "Format specifier '" + s + "'"; }
}
