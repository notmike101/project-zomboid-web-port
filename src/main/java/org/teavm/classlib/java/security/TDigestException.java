package org.teavm.classlib.java.security;

import org.teavm.classlib.java.lang.TThrowable;

public class TDigestException extends TGeneralSecurityException {
    public TDigestException() { }
    public TDigestException(String message) { super(message); }
    public TDigestException(String message, TThrowable cause) { super(message, cause); }
    public TDigestException(TThrowable cause) { super(cause); }
}
