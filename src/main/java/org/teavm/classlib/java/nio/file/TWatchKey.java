package org.teavm.classlib.java.nio.file;

import java.util.List;

public interface TWatchKey {
    boolean isValid();
    List<TWatchEvent<?>> pollEvents();
    boolean reset();
    void cancel();
    TWatchable watchable();
}
