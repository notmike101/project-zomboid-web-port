/** Exercises actual thread identities across host-service continuations and GC. */
public final class SchedulerStressQualification {
    public static native void report(String text);
    private static int mainPolls;
    private static int mainGcRequests;

    private static final class Worker extends Thread {
        volatile int polls;
        volatile int gcRequests;
        volatile boolean finished;
        volatile boolean finallyRan;
        volatile Throwable failure;

        @Override
        public void run() {
            try {
                work(this);
            } catch (Throwable error) {
                failure = error;
            } finally {
                finished = true;
                finallyRan = true;
            }
        }
    }

    private static void work(Worker worker) {
        Thread expected = worker == null ? Thread.currentThread() : worker;
        long until = System.nanoTime() + 1_200_000_000L;
        byte[][] pressure = new byte[64][];
        int polls = 0;
        int gcRequests = 0;
        try {
            while (System.nanoTime() < until) {
                if (Thread.currentThread() != expected) {
                    throw new AssertionError("Thread identity changed across continuation");
                }
                if ((polls & 1023) == 0) {
                    int slot = (polls >>> 10) & 63;
                    pressure[slot] = new byte[16384];
                    pressure[slot][0] = (byte) polls;
                }
                if ((polls & 32767) == 0) {
                    System.gc();
                    gcRequests++;
                }
                if ((polls & 8191) == 0) {
                    try {
                        throw new IllegalArgumentException("authored-pressure-exception");
                    } catch (IllegalArgumentException expectedError) {
                        // The finally path must retain the actual current Java Thread.
                    } finally {
                        if (Thread.currentThread() != expected) {
                            throw new AssertionError("Finally identity changed");
                        }
                    }
                }
                polls++;
                if (worker != null && (polls & 1023) == 0) {
                    worker.polls = polls;
                }
            }
        } finally {
            if (worker != null) {
                worker.polls = polls;
                worker.gcRequests = gcRequests;
            } else {
                mainPolls = polls;
                mainGcRequests = gcRequests;
            }
        }
    }

    public static void main(String[] args) throws Exception {
        if (!"/files/scheduler-owned".equals(System.getProperty("user.home"))
                || !"/app".equals(System.getProperty("user.dir"))) {
            throw new AssertionError("Supplied initialization Java properties were not applied");
        }
        Worker first = new Worker();
        Worker second = new Worker();
        Thread owner = Thread.currentThread();
        first.start();
        second.start();
        work(null);
        boolean bothProgressedBeforeJoin = first.polls > 0 && second.polls > 0;
        first.join(5000);
        second.join(5000);
        if (first.isAlive() || second.isAlive() || !first.finished || !second.finished
                || first.failure != null || second.failure != null
                || !first.finallyRan || !second.finallyRan || Thread.currentThread() != owner) {
            throw new AssertionError("Real worker/identity/finally failure");
        }
        report("{\"pass\":true,\"bothProgressedBeforeJoin\":" + bothProgressedBeforeJoin
                + ",\"firstPolls\":" + first.polls + ",\"secondPolls\":" + second.polls
                + ",\"mainPolls\":" + mainPolls + ",\"gcRequests\":"
                + (first.gcRequests + second.gcRequests + mainGcRequests)
                + ",\"bothTerminated\":true,\"finallyRan\":true,\"identity\":true}");
    }
}
