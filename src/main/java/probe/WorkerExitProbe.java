package probe;

/** Browser-worker-only probe. Running this entry point on a JVM would terminate that JVM. */
public final class WorkerExitProbe {
    public static void main(String[] args) throws InterruptedException {
        Thread delayed = new Thread(() -> {
            try { Thread.sleep(100); }
            catch (InterruptedException failure) { System.out.println("late-fiber-interrupted"); return; }
            System.out.println("late-fiber");
        });
        delayed.start();
        Thread.sleep(1);
        System.out.println("before-exit");
        try { System.exit(7); }
        catch (Throwable failure) { System.out.println("caught-exit"); }
        finally { System.out.println("finally-exit"); }
        System.out.println("after-exit");
    }
}
