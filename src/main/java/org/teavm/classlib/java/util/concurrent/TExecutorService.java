package org.teavm.classlib.java.util.concurrent;

import java.util.Objects;
import org.teavm.classlib.java.lang.TAutoCloseable;
import org.teavm.classlib.java.lang.TObject;
import org.teavm.classlib.java.lang.TRunnable;
import org.teavm.classlib.java.lang.TThread;
import org.teavm.classlib.java.util.TArrayList;
import org.teavm.classlib.java.util.TCollection;
import org.teavm.classlib.java.util.TIterator;
import org.teavm.classlib.java.util.TList;

/** Executor contracts using actual tasks and cooperative waits on TeaVM's single agent. */
public interface TExecutorService extends TExecutor, TAutoCloseable {
    void shutdown();
    TList<TRunnable> shutdownNow();
    boolean isShutdown();
    boolean isTerminated();
    boolean awaitTermination(long timeout, TTimeUnit unit) throws InterruptedException;

    default <T extends TObject> TFuture<T> submit(TCallable<T> task) {
        TFutureTask<T> future = new TFutureTask<>(Objects.requireNonNull(task));
        execute(future);
        return future;
    }

    default <T extends TObject> TFuture<T> submit(TRunnable task, T result) {
        TFutureTask<T> future = new TFutureTask<>(Objects.requireNonNull(task), result);
        execute(future);
        return future;
    }

    default TFuture<?> submit(TRunnable task) { return submit(task, null); }

    default <T extends TObject> TList<TFuture<T>> invokeAll(TCollection<? extends TCallable<T>> tasks)
            throws InterruptedException {
        TList<TFuture<T>> futures = createTasks(tasks);
        try {
            for (int i = 0; i < futures.size(); i++) execute((TRunnable) futures.get(i));
            for (int i = 0; i < futures.size(); i++) {
                try { futures.get(i).get(); }
                catch (TExecutionException | TCancellationException ignored) { }
            }
            return futures;
        } finally { cancelIncomplete(futures); }
    }

    default <T extends TObject> TList<TFuture<T>> invokeAll(TCollection<? extends TCallable<T>> tasks,
            long timeout, TTimeUnit unit) throws InterruptedException {
        long budget = Objects.requireNonNull(unit).toNanos(timeout);
        long start = System.nanoTime();
        TList<TFuture<T>> futures = createTasks(tasks);
        try {
            for (int i = 0; i < futures.size(); i++) {
                if (budget <= 0 || System.nanoTime() - start >= budget) return futures;
                execute((TRunnable) futures.get(i));
            }
            for (int i = 0; i < futures.size(); i++) {
                if (futures.get(i).isDone()) continue;
                long elapsed = System.nanoTime() - start;
                if (budget <= 0 || elapsed >= budget) return futures;
                long remaining = budget - elapsed;
                try { futures.get(i).get(remaining, TTimeUnit.NANOSECONDS); }
                catch (TExecutionException | TCancellationException ignored) { }
                catch (TTimeoutException expired) { return futures; }
            }
            return futures;
        } finally { cancelIncomplete(futures); }
    }

    default <T extends TObject> T invokeAny(TCollection<? extends TCallable<T>> tasks)
            throws InterruptedException, TExecutionException {
        try { return awaitAny(tasks, 0, false); }
        catch (TTimeoutException impossible) { throw new AssertionError(impossible); }
    }

    default <T extends TObject> T invokeAny(TCollection<? extends TCallable<T>> tasks,
            long timeout, TTimeUnit unit) throws InterruptedException, TExecutionException, TTimeoutException {
        return awaitAny(tasks, Objects.requireNonNull(unit).toNanos(timeout), true);
    }

    private <T extends TObject> T awaitAny(TCollection<? extends TCallable<T>> tasks, long budget, boolean timed)
            throws InterruptedException, TExecutionException, TTimeoutException {
        long start = System.nanoTime();
        TList<TFuture<T>> futures = createTasks(tasks);
        if (futures.isEmpty()) throw new IllegalArgumentException("No tasks");
        try {
            for (int i = 0; i < futures.size(); i++) execute((TRunnable) futures.get(i));
            TExecutionException failure = null;
            while (true) {
                boolean pending = false;
                for (int i = 0; i < futures.size(); i++) {
                    TFuture<T> future = futures.get(i);
                    if (!future.isDone()) { pending = true; continue; }
                    try { return future.get(); }
                    catch (TExecutionException caught) { failure = caught; }
                    catch (TCancellationException caught) { failure = new TExecutionException(caught); }
                }
                if (!pending) throw failure;
                if (timed && (budget <= 0 || System.nanoTime() - start >= budget)) throw new TTimeoutException();
                Thread.sleep(1);
            }
        } finally { cancelIncomplete(futures); }
    }

    private static <T extends TObject> TList<TFuture<T>> createTasks(TCollection<? extends TCallable<T>> tasks) {
        TArrayList<TFuture<T>> futures = new TArrayList<>();
        TIterator<? extends TCallable<T>> iterator = Objects.requireNonNull(tasks).iterator();
        while (iterator.hasNext()) futures.add(new TFutureTask<>(Objects.requireNonNull(iterator.next())));
        return futures;
    }

    private static void cancelIncomplete(TList<? extends TFuture<?>> futures) {
        for (int i = 0; i < futures.size(); i++) {
            TFuture<?> future = futures.get(i);
            if (!future.isDone()) future.cancel(true);
        }
    }

    @Override default void close() {
        shutdown();
        boolean interrupted = false;
        try {
            while (!isTerminated()) {
                try { awaitTermination(1, TTimeUnit.DAYS); }
                catch (InterruptedException caught) {
                    if (!interrupted) shutdownNow();
                    interrupted = true;
                }
            }
        } finally {
            if (interrupted) TThread.currentThread().interrupt();
        }
    }
}
