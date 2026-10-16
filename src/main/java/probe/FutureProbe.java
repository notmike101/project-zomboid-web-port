package probe;

import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Real standard-library task outcomes, separate from original-game coverage. */
public final class FutureProbe {
    private static int checks;

    public static void main(String[] args) throws Exception {
        String[] names = {"callable-success", "runnable-result", "null-result", "failure-identity",
                "cancel-before-run", "interrupt-cancel-before-run", "pending-timeout", "delayed-get",
                "interrupted-get", "cancel-running-no-interrupt", "cancel-running-interrupt",
                "protected-result", "protected-failure", "run-and-reset", "null-contracts", "future-defaults"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            checks = 0;
            int result = exercise(i);
            check(!Thread.interrupted());
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"checks\":");
            append(json, checks);
            json.append(",\"result\":");
            append(json, result);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static int exercise(int index) throws Exception {
        switch (index) {
            case 0: {
                Flags flags = new Flags();
                ObservedTask<Integer> task = new ObservedTask<>(() -> ++flags.calls);
                check(!task.isDone() && !task.isCancelled() && task.state() == Future.State.RUNNING);
                task.run(); task.run();
                check(task.get() == 1 && flags.calls == 1 && task.doneCount == 1);
                check(task.state() == Future.State.SUCCESS && task.resultNow() == 1 && !task.cancel(true));
                return task.get();
            }
            case 1: {
                Flags flags = new Flags();
                FutureTask<Integer> task = new FutureTask<>(() -> { flags.calls++; }, 42);
                task.run();
                check(task.get() == 42 && flags.calls == 1);
                check(task.get(0, TimeUnit.NANOSECONDS) == 42);
                return task.resultNow();
            }
            case 2: {
                FutureTask<Object> task = new FutureTask<>(() -> null);
                task.run();
                check(task.get() == null && task.resultNow() == null);
                check(task.state() == Future.State.SUCCESS);
                reject(task::exceptionNow, IllegalStateException.class);
                return 0;
            }
            case 3: {
                RuntimeException cause = new IllegalArgumentException("original failure");
                ObservedTask<Integer> task = new ObservedTask<>(() -> { throw cause; });
                task.run();
                try { task.get(); throw new AssertionError("Failure hidden"); }
                catch (ExecutionException expected) { check(expected.getCause() == cause); }
                check(task.exceptionNow() == cause && task.state() == Future.State.FAILED && task.doneCount == 1);
                reject(task::resultNow, IllegalStateException.class);
                return 1;
            }
            case 4, 5: {
                Flags flags = new Flags();
                ObservedTask<Integer> task = new ObservedTask<>(() -> ++flags.calls);
                check(task.cancel(index == 5));
                task.run();
                check(task.isCancelled() && task.isDone() && task.state() == Future.State.CANCELLED);
                check(flags.calls == 0 && task.doneCount == 1 && !task.cancel(true));
                reject(task::get, CancellationException.class);
                reject(() -> task.get(1, TimeUnit.SECONDS), CancellationException.class);
                return flags.calls;
            }
            case 6: {
                FutureTask<Integer> task = new FutureTask<>(() -> 1);
                try {
                    reject(() -> task.get(0, TimeUnit.NANOSECONDS), TimeoutException.class);
                    reject(() -> task.get(-1, TimeUnit.SECONDS), TimeoutException.class);
                    long start = System.nanoTime();
                    reject(() -> task.get(2, TimeUnit.MILLISECONDS), TimeoutException.class);
                    check(System.nanoTime() - start >= TimeUnit.MILLISECONDS.toNanos(2));
                    check(!task.isDone());
                } finally { task.cancel(false); }
                return 0;
            }
            case 7: {
                FutureTask<Integer> task = new FutureTask<>(() -> { Thread.sleep(3); return 42; });
                Thread worker = new Thread(task);
                worker.start();
                try { check(task.get(2, TimeUnit.SECONDS) == 42); }
                finally { task.cancel(true); worker.join(2000); }
                check(!worker.isAlive() && task.state() == Future.State.SUCCESS);
                return task.get();
            }
            case 8: {
                FutureTask<Integer> task = new FutureTask<>(() -> 1);
                Thread.currentThread().interrupt();
                try { reject(task::get, InterruptedException.class); }
                finally { task.cancel(false); }
                check(!Thread.currentThread().isInterrupted());
                return 1;
            }
            case 9, 10: {
                Flags flags = new Flags();
                ObservedTask<Integer> task = new ObservedTask<>(() -> {
                    flags.started = true;
                    try {
                        if (index == 10) Thread.sleep(10_000);
                        else while (!flags.release) Thread.sleep(1);
                        flags.calls++;
                        return 42;
                    } catch (InterruptedException expected) {
                        flags.interrupted = true;
                        throw expected;
                    } finally { flags.finished = true; }
                });
                Thread worker = new Thread(task);
                worker.start();
                try {
                    await(flags, false);
                    check(task.cancel(index == 10));
                    flags.release = true;
                    await(flags, true);
                    worker.join(2000);
                    check(!worker.isAlive() && task.isCancelled() && task.doneCount == 1);
                    check(flags.interrupted == (index == 10));
                    check(flags.calls == (index == 10 ? 0 : 1));
                    reject(task::get, CancellationException.class);
                } finally {
                    flags.release = true;
                    task.cancel(true);
                    worker.join(2000);
                }
                return flags.calls;
            }
            case 11: {
                Flags flags = new Flags();
                ObservedTask<Integer> task = new ObservedTask<>(() -> ++flags.calls);
                task.complete(42); task.complete(99); task.run();
                check(task.get() == 42 && flags.calls == 0 && task.doneCount == 1);
                check(!task.cancel(false));
                return task.resultNow();
            }
            case 12: {
                RuntimeException cause = new IllegalStateException("protected failure");
                ObservedTask<Integer> task = new ObservedTask<>(() -> 1);
                task.fail(cause); task.complete(42); task.run();
                check(task.exceptionNow() == cause && task.doneCount == 1);
                try { task.get(); throw new AssertionError("Protected failure hidden"); }
                catch (ExecutionException expected) { check(expected.getCause() == cause); }
                return 1;
            }
            case 13: {
                Flags flags = new Flags();
                ObservedTask<Integer> task = new ObservedTask<>(() -> ++flags.calls);
                check(task.resetRun() && task.resetRun());
                check(!task.isDone() && flags.calls == 2 && task.doneCount == 0);
                task.run();
                check(task.get() == 3 && task.doneCount == 1 && !task.resetRun());
                return task.get();
            }
            case 14: {
                reject(() -> new FutureTask<Integer>((Callable<Integer>) null), NullPointerException.class);
                reject(() -> new FutureTask<Integer>((Runnable) null, 1), NullPointerException.class);
                FutureTask<Integer> task = new FutureTask<>(() -> 1);
                reject(() -> task.get(0, null), NullPointerException.class);
                task.run();
                reject(() -> task.get(0, null), NullPointerException.class);
                return task.get();
            }
            default: {
                FutureTask<Integer> task = new FutureTask<>(() -> 42);
                Future<Integer> view = new FutureView<>(task);
                check(view.state() == Future.State.RUNNING);
                reject(view::resultNow, IllegalStateException.class);
                reject(view::exceptionNow, IllegalStateException.class);
                task.run();
                check(view.state() == Future.State.SUCCESS && view.resultNow() == 42);
                reject(view::exceptionNow, IllegalStateException.class);
                Thread.currentThread().interrupt();
                check(view.resultNow() == 42);
                check(Thread.interrupted());
                RuntimeException cause = new IllegalStateException("default failure");
                FutureTask<Integer> failed = new FutureTask<>(() -> { throw cause; });
                failed.run();
                Future<Integer> failure = new FutureView<>(failed);
                check(failure.state() == Future.State.FAILED && failure.exceptionNow() == cause);
                reject(failure::resultNow, IllegalStateException.class);
                FutureTask<Integer> cancelled = new FutureTask<>(() -> 1);
                cancelled.cancel(false);
                Future<Integer> cancellation = new FutureView<>(cancelled);
                check(cancellation.state() == Future.State.CANCELLED);
                reject(cancellation::resultNow, IllegalStateException.class);
                reject(cancellation::exceptionNow, IllegalStateException.class);
                return view.resultNow();
            }
        }
    }

    private static final class Flags {
        volatile boolean started, finished, release, interrupted;
        volatile int calls;
    }

    private static final class ObservedTask<V> extends FutureTask<V> {
        int doneCount;
        ObservedTask(Callable<V> callable) { super(callable); }
        @Override protected void done() { doneCount++; }
        void complete(V result) { set(result); }
        void fail(Throwable cause) { setException(cause); }
        boolean resetRun() { return runAndReset(); }
    }

    private static final class FutureView<V> implements Future<V> {
        final Future<V> task;
        FutureView(Future<V> task) { this.task = task; }
        @Override public boolean cancel(boolean interrupt) { return task.cancel(interrupt); }
        @Override public boolean isCancelled() { return task.isCancelled(); }
        @Override public boolean isDone() { return task.isDone(); }
        @Override public V get() throws InterruptedException, ExecutionException {
            if (Thread.interrupted()) throw new InterruptedException();
            return task.get();
        }
        @Override public V get(long timeout, TimeUnit unit) throws InterruptedException, ExecutionException, TimeoutException {
            return task.get(timeout, unit);
        }
    }

    private static void await(Flags flags, boolean finished) throws InterruptedException {
        long start = System.nanoTime();
        while (!(finished ? flags.finished : flags.started)) {
            if (System.nanoTime() - start > TimeUnit.SECONDS.toNanos(2)) throw new AssertionError("Worker did not progress");
            Thread.sleep(1);
        }
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Future contract differs");
        checks++;
    }

    private interface ThrowingAction { void run() throws Exception; }

    private static void reject(ThrowingAction action, Class<? extends Throwable> type) throws Exception {
        try { action.run(); }
        catch (Throwable error) {
            if (type.isInstance(error)) { checks++; return; }
            throw new AssertionError("Unexpected future exception", error);
        }
        throw new AssertionError("Invalid future operation accepted");
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
