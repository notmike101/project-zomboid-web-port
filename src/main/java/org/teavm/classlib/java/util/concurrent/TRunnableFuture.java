package org.teavm.classlib.java.util.concurrent;

import org.teavm.classlib.java.lang.TRunnable;
import org.teavm.classlib.java.lang.TObject;

public interface TRunnableFuture<V extends TObject> extends TRunnable, TFuture<V> {
    @Override void run();
}
