package org.teavm.classlib.java.util.concurrent;

import org.teavm.classlib.java.lang.TObject;

/** Future contracts for TeaVM's cooperative threads, without shared-worker guarantees. */
public interface TFuture<V extends TObject> {
    boolean cancel(boolean mayInterruptIfRunning);
    boolean isCancelled();
    boolean isDone();
    V get() throws InterruptedException, TExecutionException;
    V get(long timeout, TTimeUnit unit) throws InterruptedException, TExecutionException, TTimeoutException;

    default V resultNow() {
        if (!isDone()) throw new IllegalStateException("Task is pending");
        try { return completedResult(); }
        catch (TExecutionException | TCancellationException failure) {
            throw new IllegalStateException("Task has no successful result");
        }
    }

    default Throwable exceptionNow() {
        if (!isDone() || isCancelled()) throw new IllegalStateException("Task has no failure");
        try { completedResult(); }
        catch (TExecutionException failure) { return failure.getCause(); }
        throw new IllegalStateException("Task completed successfully");
    }

    enum State { RUNNING, SUCCESS, FAILED, CANCELLED }

    default State state() {
        if (!isDone()) return State.RUNNING;
        if (isCancelled()) return State.CANCELLED;
        try { completedResult(); return State.SUCCESS; }
        catch (TExecutionException failure) { return State.FAILED; }
    }

    private V completedResult() throws TExecutionException {
        boolean interrupted = false;
        try {
            for (;;) {
                try { return get(); }
                catch (InterruptedException retry) { interrupted = true; }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }
}
