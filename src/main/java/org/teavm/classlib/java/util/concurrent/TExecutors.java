package org.teavm.classlib.java.util.concurrent;

import java.util.Objects;
import java.util.ArrayList;
import org.teavm.classlib.java.lang.TRunnable;
import org.teavm.classlib.java.lang.TThread;
import org.teavm.classlib.java.util.TArrayList;
import org.teavm.classlib.java.util.TList;

/** Fixed-width cooperative fibers, without parallel workers or shared-memory thread guarantees. */
public final class TExecutors {
    private TExecutors() { }

    public static TExecutorService newFixedThreadPool(int threads) {
        if (threads <= 0) throw new IllegalArgumentException("Nonpositive pool size");
        return new FixedPool(threads);
    }

    private static final class FixedPool implements TExecutorService {
        private final int width;
        private final TConcurrentLinkedQueue<TRunnable> queue = new TConcurrentLinkedQueue<>();
        private final ArrayList<TThread> workers = new ArrayList<>();
        private boolean started;
        private boolean shutdown;
        private boolean stop;
        private int live;

        FixedPool(int width) { this.width = width; }

        @Override public void execute(TRunnable task) {
            Objects.requireNonNull(task);
            if (shutdown) throw new TRejectedExecutionException("Executor is shut down");
            queue.add(task);
            if (!started) {
                started = true;
                for (int i = 0; i < width; i++) startWorker();
            }
        }

        private void startWorker() {
            TThread worker = new TThread(this::work, "browser-executor-" + workers.size());
            workers.add(worker);
            live++;
            worker.start();
        }

        private void work() {
            try {
                while (!stop) {
                    TRunnable task = queue.poll();
                    if (task == null) {
                        if (shutdown) return;
                        try { Thread.sleep(1); }
                        catch (InterruptedException interrupted) { if (stop) return; }
                    } else {
                        TThread.interrupted();
                        task.run();
                    }
                }
            } finally {
                live--;
                workers.remove(TThread.currentThread());
                if (!stop && (!shutdown || !queue.isEmpty())) startWorker();
            }
        }

        @Override public void shutdown() { shutdown = true; }

        @Override public TList<TRunnable> shutdownNow() {
            shutdown = true;
            stop = true;
            TArrayList<TRunnable> pending = new TArrayList<>();
            TRunnable task;
            while ((task = queue.poll()) != null) pending.add(task);
            for (TThread worker : workers) worker.interrupt();
            return pending;
        }

        @Override public boolean isShutdown() { return shutdown; }
        @Override public boolean isTerminated() { return shutdown && live == 0; }

        @Override public boolean awaitTermination(long timeout, TTimeUnit unit) throws InterruptedException {
            long budget = Objects.requireNonNull(unit).toNanos(timeout);
            long start = System.nanoTime();
            if (TThread.interrupted()) throw new InterruptedException();
            while (!isTerminated()) {
                if (budget <= 0 || System.nanoTime() - start >= budget) return false;
                Thread.sleep(1);
            }
            return true;
        }
    }
}
