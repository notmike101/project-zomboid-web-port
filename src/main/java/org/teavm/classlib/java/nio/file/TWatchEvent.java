package org.teavm.classlib.java.nio.file;

public interface TWatchEvent<T> {
    Kind<T> kind();
    int count();
    T context();
    interface Kind<T> { String name(); Class<T> type(); }
    interface Modifier { String name(); }
}
