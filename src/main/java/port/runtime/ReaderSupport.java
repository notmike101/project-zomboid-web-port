package port.runtime;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.util.Objects;

/** Supplies Java 25 character-copy behavior through TeaVM's existing stream APIs. */
public final class ReaderSupport {
    public static long transferTo(Reader reader, Writer writer) throws IOException {
        Objects.requireNonNull(writer, "out");
        char[] buffer = new char[8192];
        long total = 0;
        int count;
        while ((count = reader.read(buffer, 0, buffer.length)) != -1) {
            writer.write(buffer, 0, count);
            total = total > Long.MAX_VALUE - count ? Long.MAX_VALUE : total + count;
        }
        return total;
    }
}
