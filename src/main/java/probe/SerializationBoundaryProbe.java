package probe;

import java.io.IOException;
import java.io.InputStream;
import java.io.ObjectInputStream;

/** Browser-only rejection checks, not serialization compatibility or a JVM comparison. */
public final class SerializationBoundaryProbe {
    private static final String UNAVAILABLE = "Java object deserialization is unavailable in this browser runtime";

    public static void main(String[] args) throws Exception {
        TrackingInput input = new TrackingInput();
        IOException rejected = null;
        try {
            new ObjectInputStream(input);
            throw failure("Unavailable deserialization constructed a stream");
        } catch (IOException expected) {
            rejected = expected;
        }
        if (!UNAVAILABLE.equals(rejected.getMessage()) || input.reads != 0 || input.closes != 0)
            throw failure("Unavailable deserialization consumed or closed its input");
        int nullChecks = 0;
        try {
            new ObjectInputStream(null);
            throw failure("Null deserialization input accepted");
        } catch (NullPointerException expected) {
            nullChecks++;
        }
        if (input.read() != 0xac || input.reads != 1 || input.closes != 0)
            throw failure("Rejected stream no longer owned by its caller");
        input.close();
        if (input.closes != 1) throw failure("Caller close did not retain ownership");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-serialization-boundary\",\"cases\":[{\"id\":\"explicit-unavailable-deserialization\",\"inputs\":[],\"outputs\":{");
        integer(json, "messageHash", rejected.getMessage().hashCode()); json.append(',');
        integer(json, "unconsumed", 1);
        json.append("}},{\"id\":\"null-and-input-ownership\",\"inputs\":[],\"outputs\":{");
        integer(json, "nullChecks", nullChecks); json.append(',');
        integer(json, "callerReadsAndCloses", input.reads * 10 + input.closes);
        System.out.println(json.append("}}],\"pass\":true}"));
    }
    private static final class TrackingInput extends InputStream {
        int reads;
        int closes;
        @Override public int read() { reads++; return 0xac; }
        @Override public void close() { closes++; }
    }
    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
