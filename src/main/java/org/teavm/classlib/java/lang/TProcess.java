package org.teavm.classlib.java.lang;

import java.io.InputStream;
import java.io.OutputStream;

/** Process handle type only: the browser backend cannot create desktop processes. */
public abstract class TProcess {
    public abstract OutputStream getOutputStream();
    public abstract InputStream getInputStream();
    public abstract InputStream getErrorStream();
    public abstract int waitFor() throws InterruptedException;
    public abstract int exitValue();
    public abstract void destroy();
}
