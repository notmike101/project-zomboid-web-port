package probe;

import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Real task scheduling and lifecycle checks, without game classes or parallel-worker claims. */
public final class ExecutorProbe {
    public static void main(String[] args) throws Exception {
        String[] names = {"submit-and-validation", "pool-width", "shutdown-drains", "shutdown-now",
                "task-failure", "bulk-results", "bulk-timeouts", "interrupted-close"};
        int[] expectedMeasure = {2, 2, 1, 1, 1, 2, 2, 1};
        int[] expectedResult = {49, 6, 11, 6, 73, 22, 1, 2};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            ExecutorService pool = Executors.newFixedThreadPool(i == 1 ? 2 : 1);
            int measure;
            int result;
            try {
                switch (i) {
                    case 0: {
                        for (int size : new int[]{0, -1}) {
                            try { Executors.newFixedThreadPool(size); throw new AssertionError("Invalid pool size accepted"); }
                            catch (IllegalArgumentException expected) { }
                        }
                        AtomicInteger calls = new AtomicInteger();
                        Future<Integer> a = pool.submit(() -> { calls.incrementAndGet(); return 42; });
                        Future<Integer> b = pool.submit(calls::incrementAndGet, 7);
                        result = a.get() + b.get();
                        measure = calls.get();
                        break;
                    }
                    case 1: {
                        AtomicInteger started = new AtomicInteger();
                        AtomicInteger active = new AtomicInteger();
                        AtomicInteger maximum = new AtomicInteger();
                        AtomicBoolean release = new AtomicBoolean();
                        Callable<Integer> blocked = () -> {
                            int count = active.incrementAndGet();
                            int previous;
                            do { previous = maximum.get(); }
                            while (count > previous && !maximum.compareAndSet(previous, count));
                            started.incrementAndGet();
                            try { while (!release.get()) Thread.sleep(1); }
                            finally { active.decrementAndGet(); }
                            return 1;
                        };
                        Future<Integer> a = pool.submit(blocked);
                        Future<Integer> b = pool.submit(blocked);
                        Future<Integer> c = pool.submit(() -> { started.incrementAndGet(); return 4; });
                        awaitCount(started, 2);
                        check(started.get() == 2 && maximum.get() == 2);
                        release.set(true);
                        result = a.get() + b.get() + c.get();
                        measure = maximum.get();
                        break;
                    }
                    case 2: {
                        Future<Integer> future = pool.submit(() -> 11);
                        pool.shutdown();
                        try { pool.execute(() -> { }); throw new AssertionError("Shutdown accepted task"); }
                        catch (RejectedExecutionException expected) { measure = 1; }
                        result = future.get();
                        check(pool.isShutdown() && pool.awaitTermination(5, TimeUnit.SECONDS) && pool.isTerminated());
                        break;
                    }
                    case 3: {
                        AtomicInteger started = new AtomicInteger();
                        AtomicBoolean interrupted = new AtomicBoolean();
                        Future<Integer> running = pool.submit(() -> {
                            started.incrementAndGet();
                            try { Thread.sleep(10000); }
                            catch (InterruptedException expected) { interrupted.set(true); }
                            return 5;
                        });
                        awaitCount(started, 1);
                        Future<Integer> queued = pool.submit(() -> 99);
                        List<Runnable> pending = pool.shutdownNow();
                        check(pending.size() == 1 && pending.get(0) == queued && !queued.isDone());
                        queued.cancel(false);
                        result = running.get(5, TimeUnit.SECONDS) + (interrupted.get() ? 1 : 0);
                        measure = pending.size();
                        break;
                    }
                    case 4: {
                        IllegalArgumentException failure = new IllegalArgumentException("Expected task failure");
                        Future<Integer> failed = pool.submit(() -> { throw failure; });
                        try { failed.get(); throw new AssertionError("Task failure swallowed"); }
                        catch (ExecutionException caught) { check(caught.getCause() == failure); measure = 1; }
                        result = pool.submit(() -> 73).get();
                        break;
                    }
                    case 5: {
                        List<Future<Integer>> all = pool.invokeAll(List.of(() -> 1, () -> 2));
                        int any = pool.invokeAny(List.of(() -> { throw new IllegalStateException("Expected"); }, () -> 19));
                        measure = all.size();
                        result = all.get(0).get() + all.get(1).get() + any;
                        check(all.get(0).get() == 1 && all.get(1).get() == 2);
                        break;
                    }
                    case 6: {
                        Callable<Integer> slow = () -> { Thread.sleep(10000); return 1; };
                        List<Future<Integer>> cancelled = pool.invokeAll(List.of(slow, slow), 0, TimeUnit.NANOSECONDS);
                        measure = 0;
                        for (Future<Integer> future : cancelled) if (future.isCancelled()) measure++;
                        try { pool.invokeAny(List.of(slow), 0, TimeUnit.NANOSECONDS); throw new AssertionError("Bulk timeout ignored"); }
                        catch (TimeoutException expected) { result = 1; }
                        check(pool.invokeAll(List.of(slow), Long.MIN_VALUE, TimeUnit.NANOSECONDS).get(0).isCancelled());
                        try { pool.invokeAny(List.of(slow), Long.MIN_VALUE, TimeUnit.NANOSECONDS); throw new AssertionError("Negative bulk timeout ignored"); }
                        catch (TimeoutException expected) { }
                        check(!pool.awaitTermination(Long.MIN_VALUE, TimeUnit.NANOSECONDS));
                        break;
                    }
                    case 7: {
                        AtomicInteger started = new AtomicInteger();
                        AtomicBoolean interrupted = new AtomicBoolean();
                        pool.submit(() -> {
                            started.incrementAndGet();
                            try { Thread.sleep(10000); }
                            catch (InterruptedException expected) { interrupted.set(true); }
                        });
                        awaitCount(started, 1);
                        Thread.currentThread().interrupt();
                        pool.close();
                        measure = Thread.interrupted() ? 1 : 0;
                        result = (pool.isTerminated() ? 1 : 0) + (interrupted.get() ? 1 : 0);
                        break;
                    }
                    default: throw new AssertionError("Unknown executor case");
                }
            } finally {
                Thread.interrupted();
                pool.shutdownNow();
                check(pool.awaitTermination(5, TimeUnit.SECONDS));
            }
            check(measure == expectedMeasure[i] && result == expectedResult[i]);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, measure);
            json.append(",\"result\":");
            append(json, result);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void awaitCount(AtomicInteger counter, int expected) throws InterruptedException {
        long start = System.nanoTime();
        while (counter.get() < expected) {
            if (System.nanoTime() - start > TimeUnit.SECONDS.toNanos(5)) throw new AssertionError("Worker did not start");
            Thread.sleep(1);
        }
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Executor contract differs");
    }
}
