package probe;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.Arrays;

/** Writes only a newly allocated temporary directory and removes owned files. */
public final class FileStreamProbe {
    public static void main(String[] args) throws Exception {
        File directory = File.createTempFile("teavm-printstream-", ".tmp");
        if (!directory.delete() || !directory.mkdir()) throw new IOException("Cannot create isolated temporary directory");
        File file = new File(directory, "output.bin");
        String[] names = {"create", "unicode-default-charset", "truncate", "empty-truncate",
                "closed-stream", "directory-failure", "missing-parent", "null-file"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        try {
            for (int i = 0; i < names.length; i++) {
                int measure;
                int hash;
                if (i >= 5) {
                    File invalid = i == 5 ? directory : i == 6 ? new File(new File(directory, "missing"), "output.bin") : null;
                    try (PrintStream stream = new PrintStream(invalid)) {
                        throw new AssertionError("Invalid file accepted");
                    } catch (FileNotFoundException expected) {
                        if (i == 7) throw expected;
                        measure = -1;
                        hash = "FileNotFoundException".hashCode();
                    } catch (NullPointerException expected) {
                        if (i != 7) throw expected;
                        measure = -2;
                        hash = "NullPointerException".hashCode();
                    }
                } else {
                    if (i == 2 || i == 3) {
                        try (FileOutputStream seed = new FileOutputStream(file)) {
                            seed.write(new byte[]{1, 2, 3, 4, 5, 6});
                        }
                    }
                    String expected = i == 0 ? "abc" : i == 1 ? "a\u00e9\uD83E\uDDDF" : i == 2 ? "x" : i == 3 ? "" : "closed";
                    PrintStream stream = new PrintStream(file);
                    try {
                        stream.print(expected);
                        stream.flush();
                        if (stream.checkError()) throw new AssertionError("Write failed");
                    } finally {
                        stream.close();
                    }
                    if (i == 4) {
                        if (stream.checkError()) throw new AssertionError("Healthy close set error");
                        stream.close();
                        if (stream.checkError()) throw new AssertionError("Repeated close set error");
                        stream.print("must-not-write");
                        if (!stream.checkError()) throw new AssertionError("Closed write did not set error");
                        checkLifecycle();
                    }
                    byte[] bytes;
                    try (FileInputStream input = new FileInputStream(file)) {
                        bytes = input.readAllBytes();
                    }
                    if (!Arrays.equals(bytes, expected.getBytes(Charset.defaultCharset()))) throw new AssertionError(names[i]);
                    measure = bytes.length;
                    hash = Arrays.hashCode(bytes);
                }
                if (i != 0) json.append(',');
                json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
                append(json, measure);
                json.append(",\"contentHash\":");
                append(json, hash);
                json.append("}}");
            }
        } finally {
            if (file.exists() && !file.delete()) throw new IOException("Cannot remove owned temporary file");
            if (!directory.delete()) throw new IOException("Cannot remove owned temporary directory");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }

    private static void checkLifecycle() {
        int[] closes = {0};
        PrintStream[] recursive = new PrintStream[1];
        recursive[0] = new PrintStream(new OutputStream() {
            @Override public void write(int value) { }
            @Override public void close() {
                closes[0]++;
                recursive[0].close();
            }
        });
        recursive[0].close();
        recursive[0].close();
        if (closes[0] != 1 || recursive[0].checkError()) throw new AssertionError("Recursive close differs");
        PrintStream failing = new PrintStream(new OutputStream() {
            @Override public void write(int value) throws IOException { throw new IOException("write failure"); }
            @Override public void close() throws IOException { throw new IOException("close failure"); }
        });
        PrintStream nested = new PrintStream(failing);
        nested.print("failure");
        if (!nested.checkError()) throw new AssertionError("Nested failure hidden");
        nested.close();
        if (nested.checkError()) throw new AssertionError("Nested wrapper gained local error");
        if (!failing.checkError()) throw new AssertionError("Close failure hidden");
    }
}
