package org.teavm.classlib.java.nio.file;

import java.io.Closeable;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

public interface TWatchService extends Closeable {
    @Override void close() throws IOException;
    TWatchKey poll();
    TWatchKey poll(long timeout, TimeUnit unit) throws InterruptedException;
    TWatchKey take() throws InterruptedException;
}
