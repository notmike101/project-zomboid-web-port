package org.teavm.classlib.java.lang;

/** Constructor and cause semantics for TeaVM's java.lang substitution. */
public class TExceptionInInitializerError extends TLinkageError {
    public TExceptionInInitializerError() { super(null, null); }
    public TExceptionInInitializerError(String message) { super(message, null); }
    public TExceptionInInitializerError(TThrowable cause) { super(null, cause); }
    public TThrowable getException() { return super.getCause(); }
    @Override public TThrowable initCause(TThrowable cause) {
        // TeaVM 0.16 permits replacing a null cause, while this error freezes it.
        throw new IllegalStateException("Cause already initialized");
    }
}
