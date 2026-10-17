/** Runs the original empty-queue WorldStreamer component without a world. */
public final class WorldStreamerStopQualification {
    public static native void phase(String text);
    public static native void report(String text);

    public static void main(String[] args) throws Exception {
        Thread owner = Thread.currentThread();
        Thread worker = null;
        zombie.iso.WorldStreamer streamer = null;
        boolean stopped = false;
        boolean finallyRan = false;
        try {
            phase("entry");
            zombie.core.random.RandStandard.INSTANCE.init();
            if (zombie.network.GameServer.server || zombie.network.GameClient.client) {
                throw new AssertionError("Expected original offline defaults");
            }
            streamer = zombie.iso.WorldStreamer.instance;
            if (streamer.worldStreamer != null || streamer.finished) {
                throw new AssertionError("Unexpected original initial lifecycle");
            }
            phase("before-create");
            streamer.create();
            worker = streamer.worldStreamer;
            if (worker == null || !worker.isAlive()) {
                throw new AssertionError("Original create did not start worker");
            }
            phase("allow-original-worker-progress");
            Thread.sleep(350);
            if (!worker.isAlive() || streamer.finished) {
                throw new AssertionError("Worker not genuinely live before stop");
            }
            phase("before-original-stop");
            streamer.stop();
            if (worker.isAlive() || streamer.worldStreamer != null || !streamer.finished) {
                throw new AssertionError("Original stop did not terminate and clear worker");
            }
            stopped = true;
            phase("after-original-stop");
            try {
                throw new IllegalArgumentException("authored-finally-check");
            } catch (IllegalArgumentException expected) {
                // Exercise an actual Java exception after original stop completed.
            } finally {
                finallyRan = true;
            }
            if (Thread.currentThread() != owner) {
                throw new AssertionError("Main thread identity changed");
            }
            report("{\"pass\":true,\"originalStopReturned\":true,\"actualWorkerTerminated\":true,"
                    + "\"threadIdentity\":true,\"exceptionFinally\":" + finallyRan + "}");
        } catch (Throwable error) {
            error.printStackTrace();
            report("{\"pass\":false,\"error\":\""
                    + error.toString().replace("\\", "/").replace("\"", "'") + "\"}");
        } finally {
            if (!stopped && streamer != null && worker != null && worker.isAlive()) {
                phase("failure-original-stop");
                streamer.stop();
            }
            phase("java-finally");
        }
    }
}
