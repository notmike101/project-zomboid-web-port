package org.teavm.classlib.java.nio.file;

import java.io.IOException;

public interface TWatchable {
    TWatchKey register(TWatchService watcher, TWatchEvent.Kind<?>[] kinds, TWatchEvent.Modifier... modifiers) throws IOException;
    TWatchKey register(TWatchService watcher, TWatchEvent.Kind<?>... kinds) throws IOException;
}
