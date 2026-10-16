package org.teavm.classlib.java.util.concurrent;

import java.util.Objects;
import org.teavm.classlib.java.lang.TObject;
import org.teavm.classlib.java.lang.TRunnable;

/** Cooperative single-agent execution. State changes never suspend or enter user code. */
public class TFutureTask<V extends TObject> extends TObject implements TRunnableFuture<V> {
    private static final int NEW = 0, RUNNING = 1, SUCCESS = 2, FAILED = 3, CANCELLED = 4;
    private int status;
    private TCallable<V> callable;
    private V result;
    private Throwable failure;
    private Thread runner;

    public TFutureTask(TCallable<V> callable) { this.callable = Objects.requireNonNull(callable); }

    public TFutureTask(TRunnable runnable, V result) { this(adapt(runnable, result)); }

    private static <V extends TObject> TCallable<V> adapt(TRunnable runnable, V result) {
        Objects.requireNonNull(runnable);
        return () -> { runnable.run(); return result; };
    }

    @Override public boolean isCancelled() { return status == CANCELLED; }
    @Override public boolean isDone() { return status >= SUCCESS; }

    @Override
    public boolean cancel(boolean mayInterruptIfRunning) {
        if (isDone()) return false;
        status = CANCELLED;
        callable = null;
        try {
            if (mayInterruptIfRunning && runner != null) runner.interrupt();
        } finally { done(); }
        return true;
    }

    @Override
    public V get() throws InterruptedException, TExecutionException {
        while (!isDone()) {
            if (Thread.interrupted()) throw new InterruptedException();
            Thread.sleep(1);
        }
        return report();
    }

    @Override
    public V get(long timeout, TTimeUnit unit) throws InterruptedException, TExecutionException, TTimeoutException {
        long nanos = Objects.requireNonNull(unit).toNanos(timeout);
        long start = System.nanoTime();
        while (!isDone()) {
            if (Thread.interrupted()) throw new InterruptedException();
            if (nanos <= 0 || System.nanoTime() - start >= nanos) throw new TTimeoutException();
            Thread.sleep(1);
        }
        return report();
    }

    private V report() throws TExecutionException {
        if (status == CANCELLED) throw new TCancellationException();
        if (status == FAILED) throw new TExecutionException(failure);
        return result;
    }

    @Override public V resultNow() {
        if (status != SUCCESS) throw new IllegalStateException("Task has no successful result");
        return result;
    }

    @Override public Throwable exceptionNow() {
        if (status != FAILED) throw new IllegalStateException("Task has no failure");
        return failure;
    }

    @Override public State state() {
        return switch (status) {
            case SUCCESS -> State.SUCCESS;
            case FAILED -> State.FAILED;
            case CANCELLED -> State.CANCELLED;
            default -> State.RUNNING;
        };
    }

    protected void done() { }

    protected void set(V value) {
        if (isDone()) return;
        result = value;
        status = SUCCESS;
        callable = null;
        done();
    }

    protected void setException(Throwable cause) {
        if (isDone()) return;
        failure = cause;
        status = FAILED;
        callable = null;
        done();
    }

    @Override public void run() { execute(false); }
    protected boolean runAndReset() { return execute(true); }

    private boolean execute(boolean reset) {
        if (status != NEW) return false;
        TCallable<V> task = callable;
        runner = Thread.currentThread();
        status = RUNNING;
        try {
            V value;
            try { value = task.call(); }
            catch (Throwable cause) { setException(cause); return false; }
            if (!reset) { set(value); return false; }
            if (status != RUNNING) return false;
            status = NEW;
            return true;
        } finally { runner = null; }
    }

    @Override public String toString() {
        String outcome = switch (status) {
            case SUCCESS -> "Completed normally";
            case FAILED -> "Completed exceptionally: " + failure;
            case CANCELLED -> "Cancelled";
            default -> "Not completed";
        };
        return super.toString() + "[" + outcome + "]";
    }
}
