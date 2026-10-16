package org.teavm.classlib.java.nio.file;

import org.teavm.classlib.java.lang.TIllegalArgumentException;

/** Standard exception for incompatible filesystem provider paths. */
public class TProviderMismatchException extends TIllegalArgumentException {
    public TProviderMismatchException() { }
    public TProviderMismatchException(String message) { super(message); }
}
