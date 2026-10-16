package org.teavm.classlib.java.io;

import java.io.IOException;
import java.util.Objects;
import org.teavm.classlib.java.lang.TObject;

/**
 * Explicit unavailable-capability boundary for retained object-deserialization calls.
 * Only the retained constructor/readObject surface and InputStream superclass are declared.
 * This is not a Java serialization implementation or a complete ObjectInput API.
 */
public class TObjectInputStream extends TInputStream {
    private static final String UNAVAILABLE = "Java object deserialization is unavailable in this browser runtime";

    public TObjectInputStream(TInputStream input) throws IOException {
        Objects.requireNonNull(input);
        throw unavailable();
    }

    public final TObject readObject() throws IOException, ClassNotFoundException {
        throw unavailable();
    }

    @Override public int read() throws IOException {
        throw unavailable();
    }

    private static IOException unavailable() {
        return new IOException(UNAVAILABLE);
    }
}
