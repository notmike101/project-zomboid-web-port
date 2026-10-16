package org.teavm.classlib.java.lang;

/** Preserves the inherited, initially unset cause for linkage failures. */
public class TUnsatisfiedLinkError extends TLinkageError {
    private boolean causeInitialized;
    public TUnsatisfiedLinkError() { super(); }
    public TUnsatisfiedLinkError(String message) { super(message); }
    @Override public TThrowable initCause(TThrowable cause) {
        // TeaVM 0.16 otherwise treats an explicitly assigned null cause as unset.
        if (causeInitialized) throw new IllegalStateException("Cause already initialized");
        TThrowable result = super.initCause(cause);
        causeInitialized = true;
        return result;
    }
}
