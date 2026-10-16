import org.lwjglx.Sys;
import org.lwjglx.opengl.Display;

/** Data-only original vendor clock/pacing qualification; no worker/game lifecycle. */
public final class ClockQualification {

    public static native void report(String json);

    public static void main(String[] args) {
        try {
            if (Sys.getTimerResolution() != 1000) throw new AssertionError(
                "Original timer resolution changed"
            );
            long before = Sys.getTime();
            long nanoBefore = Sys.getNanoTime();
            Thread.sleep(50);
            long after = Sys.getTime();
            long nanoAfter = Sys.getNanoTime();
            if (
                after - before < 25 || nanoAfter - nanoBefore < 25_000_000
            ) throw new AssertionError(
                "Clock did not measure actual elapsed delay"
            );
            for (int index = 0; index < 100; index++) {
                long next = Sys.getNanoTime();
                if (next < nanoAfter) throw new AssertionError(
                    "Clock moved backwards"
                );
                nanoAfter = next;
            }
            Display.sync(20);
            long start = Sys.getNanoTime();
            for (int index = 0; index < 4; index++) Display.sync(20);
            long elapsed = Sys.getNanoTime() - start;
            if (
                elapsed < 100_000_000 || elapsed > 3_000_000_000L
            ) throw new AssertionError(
                "Original Display.sync pacing: " + elapsed
            );
            report(
                "{\"pass\":true,\"scope\":\"original-Sys-and-Display.sync-only\",\"sleepMilliseconds\":" +
                    (after - before) +
                    ",\"syncNanoseconds\":" +
                    elapsed +
                    "}"
            );
        } catch (Throwable error) {
            error.printStackTrace();
            report(
                "{\"pass\":false,\"error\":\"" +
                    error
                        .toString()
                        .replace("\\", "\\\\")
                        .replace("\"", "\\\"") +
                    "\"}"
            );
        }
    }
    /** Builds an isolated mismatched-source archive for the preparation guard test. */
    public static final class SourceGuard {
        public static void main(String[] args) throws Exception {
            try (var input = new java.util.zip.ZipFile(args[0]);
                 var output = new java.util.zip.ZipOutputStream(java.nio.file.Files.newOutputStream(java.nio.file.Path.of(args[1])))) {
                for (String name : new String[]{"zombie/util/LazyValue.class", "org/lwjglx/Sys.class"}) {
                    byte[] bytes;
                    try (var stream = input.getInputStream(input.getEntry(name))) { bytes = stream.readAllBytes(); }
                    if (name.equals("org/lwjglx/Sys.class")) bytes[bytes.length - 1] ^= 1;
                    output.putNextEntry(new java.util.zip.ZipEntry(name));
                    output.write(bytes);
                    output.closeEntry();
                }
            }
        }
    }
}
