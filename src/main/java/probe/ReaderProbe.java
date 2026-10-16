package probe;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.io.Writer;

/** Standard-library compatibility checks, separate from original-game coverage. */
public final class ReaderProbe {
    public static void main(String[] args) throws Exception {
        String[] names = {"empty", "ascii", "unicode", "buffer-boundary", "null-writer",
                "read-failure", "write-failure", "streams-remain-open"};
        String[] inputs = {"", "Project Zomboid\n", "a\uD83E\uDDDF\n", "abc".repeat(2731), "abc", "abc", "abc", "open"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            TrackedReader source = new TrackedReader(inputs[i]);
            BufferedReader reader = new BufferedReader(source);
            TrackedWriter writer = new TrackedWriter();
            long measure;
            int hash;
            if (i == 4) {
                try {
                    reader.transferTo(null);
                    throw new AssertionError("Null writer accepted");
                } catch (NullPointerException expected) {
                    measure = 1;
                    hash = reader.read();
                }
            } else if (i == 5 || i == 6) {
                IOException failure = new IOException("Expected I/O failure");
                if (i == 5) source.failure = failure;
                else writer.failure = failure;
                try {
                    reader.transferTo(writer);
                    throw new AssertionError("I/O failure swallowed");
                } catch (IOException caught) {
                    if (caught != failure) throw new AssertionError("I/O failure replaced");
                    measure = 1;
                    hash = writer.text.toString().hashCode();
                }
            } else {
                measure = reader.transferTo(writer);
                if (!writer.text.toString().equals(inputs[i])) throw new AssertionError("Transferred text differs");
                hash = writer.text.toString().hashCode();
            }
            if (source.closed || writer.closed) throw new AssertionError("transferTo closed a stream");
            if (i == 7) {
                writer.write(new char[]{'!'}, 0, 1);
                hash = writer.text.toString().hashCode();
                if (reader.read() != -1) throw new AssertionError("Source is not exhausted");
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, Long.toString(measure), Long.toHexString(measure), 16);
            json.append(",\"contentHash\":");
            append(json, Integer.toString(hash), Integer.toHexString(hash), 8);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, String value, String bits, int width) {
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < width; i++) json.append('0');
        json.append(bits).append("\"}");
    }

    private static final class TrackedReader extends StringReader {
        boolean closed;
        IOException failure;
        TrackedReader(String value) { super(value); }
        @Override public int read(char[] target, int offset, int length) throws IOException {
            if (failure != null) throw failure;
            return super.read(target, offset, length);
        }
        @Override public void close() { closed = true; super.close(); }
    }

    private static final class TrackedWriter extends Writer {
        final StringBuilder text = new StringBuilder();
        boolean closed;
        IOException failure;
        @Override public void write(char[] input, int offset, int length) throws IOException {
            if (failure != null) throw failure;
            if (closed) throw new IOException("Writer closed");
            text.append(input, offset, length);
        }
        @Override public void flush() { }
        @Override public void close() { closed = true; }
    }
}
