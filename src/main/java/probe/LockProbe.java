package probe;

import java.util.ArrayList;
import java.util.Date;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BooleanSupplier;

/** Lock and condition lifecycle checks with bounded, owned threads. */
public final class LockProbe {
    public static void main(String[] args) throws Exception {
        String[] names = {"reentrant", "ownership-errors", "contended-try", "entry-interrupt",
                "queued-interrupt", "uninterruptible-lock", "fair-order", "condition-signal",
                "condition-signal-all", "interrupted-await", "uninterruptible-await", "condition-timeouts",
                "huge-condition-timeout", "remaining-nanos", "introspection", "huge-lock-timeout"};
        int[] expectedMeasure = {2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 1, 4, 1, 1, 2, 1};
        int[] expectedResult = {0, 1, 0, 1, 0, 1, 12, 1, 2, 1, 1, 2, 1, 1, 1, 1};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            InspectableLock lock = new InspectableLock(i == 6);
            Condition condition = lock.newCondition();
            ArrayList<Thread> threads = new ArrayList<>();
            AtomicReference<Throwable> failure = new AtomicReference<>();
            AtomicBoolean released = new AtomicBoolean();
            AtomicInteger a = new AtomicInteger();
            AtomicInteger b = new AtomicInteger();
            int measure;
            int result;
            try {
                switch (i) {
                    case 0:
                        lock.lock(); lock.lock();
                        measure = lock.getHoldCount();
                        check(lock.isHeldByCurrentThread() && lock.isLocked());
                        lock.unlock(); check(lock.getHoldCount() == 1); lock.unlock();
                        result = lock.isLocked() ? 1 : 0;
                        break;
                    case 1:
                        try { lock.unlock(); throw new AssertionError("Unowned unlock accepted"); }
                        catch (IllegalMonitorStateException expected) { a.incrementAndGet(); }
                        try { condition.signal(); throw new AssertionError("Unowned signal accepted"); }
                        catch (IllegalMonitorStateException expected) { a.incrementAndGet(); }
                        try { condition.await(); throw new AssertionError("Unowned await accepted"); }
                        catch (IllegalMonitorStateException expected) { }
                        measure = a.get(); result = 1;
                        break;
                    case 2:
                        lock.lock();
                        start(threads, failure, () -> {
                            if (!lock.tryLock()) a.incrementAndGet();
                            if (!lock.tryLock(Long.MIN_VALUE, TimeUnit.NANOSECONDS)) a.incrementAndGet();
                        });
                        join(threads.get(0));
                        measure = a.get(); result = lock.getQueueLength(); lock.unlock();
                        break;
                    case 3:
                        lock.lock(); Thread.currentThread().interrupt();
                        try { lock.lockInterruptibly(); throw new AssertionError("Entry interruption ignored"); }
                        catch (InterruptedException expected) { measure = Thread.interrupted() ? 0 : 1; }
                        result = lock.getHoldCount(); lock.unlock();
                        break;
                    case 4: {
                        lock.lock();
                        Thread waiter = start(threads, failure, () -> {
                            try { lock.lockInterruptibly(); lock.unlock(); }
                            catch (InterruptedException expected) { a.incrementAndGet(); }
                        });
                        await(() -> lock.hasQueuedThread(waiter));
                        waiter.interrupt(); join(waiter);
                        measure = a.get(); result = lock.getQueueLength(); lock.unlock();
                        break;
                    }
                    case 5: {
                        lock.lock();
                        Thread waiter = start(threads, failure, () -> {
                            lock.lock();
                            try { a.set(Thread.interrupted() ? 1 : 0); b.set(lock.getHoldCount()); }
                            finally { lock.unlock(); }
                        });
                        await(() -> lock.hasQueuedThread(waiter));
                        waiter.interrupt(); lock.unlock(); join(waiter);
                        measure = a.get(); result = b.get();
                        break;
                    }
                    case 6: {
                        lock.lock();
                        Thread first = start(threads, failure, () -> { lock.lock(); try { a.set(a.get() * 10 + 1); } finally { lock.unlock(); } });
                        await(() -> lock.hasQueuedThread(first));
                        Thread second = start(threads, failure, () -> { lock.lock(); try { a.set(a.get() * 10 + 2); } finally { lock.unlock(); } });
                        await(() -> lock.hasQueuedThread(second));
                        measure = lock.getQueueLength();
                        check(lock.isFair() && lock.queuedSize() == 2);
                        lock.unlock(); join(first); join(second); result = a.get();
                        break;
                    }
                    case 7:
                        start(threads, failure, () -> {
                            lock.lock(); lock.lock();
                            try { while (!released.get()) condition.await(); a.set(lock.getHoldCount()); b.set(1); }
                            finally { lock.unlock(); lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 1);
                        lock.lock(); try { released.set(true); condition.signal(); } finally { lock.unlock(); }
                        join(threads.get(0)); measure = a.get(); result = b.get();
                        break;
                    case 8:
                        for (int n = 0; n < 2; n++) start(threads, failure, () -> {
                            lock.lock();
                            try { while (!released.get()) condition.await(); a.incrementAndGet(); }
                            finally { lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 2);
                        lock.lock();
                        try { measure = lock.getWaitQueueLength(condition); released.set(true); condition.signalAll(); }
                        finally { lock.unlock(); }
                        for (Thread thread : threads) join(thread);
                        result = a.get();
                        break;
                    case 9: {
                        Thread waiter = start(threads, failure, () -> {
                            lock.lock(); lock.lock();
                            try {
                                try { condition.await(); throw new AssertionError("Await interruption ignored"); }
                                catch (InterruptedException expected) { a.set(lock.getHoldCount()); b.set(Thread.interrupted() ? 0 : 1); }
                            } finally { lock.unlock(); lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 1);
                        lock.lock(); waiter.interrupt();
                        await(() -> lock.hasQueuedThread(waiter)); check(a.get() == 0);
                        lock.unlock(); join(waiter); measure = a.get(); result = b.get();
                        break;
                    }
                    case 10:
                        start(threads, failure, () -> {
                            lock.lock(); Thread.currentThread().interrupt();
                            try { while (!released.get()) condition.awaitUninterruptibly(); a.set(Thread.interrupted() ? 1 : 0); b.set(lock.getHoldCount()); }
                            finally { lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 1);
                        lock.lock(); try { released.set(true); condition.signal(); } finally { lock.unlock(); }
                        join(threads.get(0)); measure = a.get(); result = b.get();
                        break;
                    case 11:
                        lock.lock(); lock.lock();
                        measure = 0;
                        if (!condition.await(Long.MIN_VALUE, TimeUnit.DAYS)) measure++;
                        if (condition.awaitNanos(Long.MIN_VALUE) <= 0) measure++;
                        if (!condition.awaitUntil(new Date(Long.MIN_VALUE))) measure++;
                        if (!condition.await(2, TimeUnit.MILLISECONDS)) measure++;
                        result = lock.getHoldCount(); lock.unlock(); lock.unlock();
                        break;
                    case 12:
                        start(threads, failure, () -> {
                            lock.lock();
                            try { a.set(condition.await(Long.MAX_VALUE, TimeUnit.DAYS) ? 1 : 0); b.set(lock.getHoldCount()); }
                            finally { lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 1);
                        lock.lock(); try { condition.signal(); } finally { lock.unlock(); }
                        join(threads.get(0)); measure = a.get(); result = b.get();
                        break;
                    case 13:
                        start(threads, failure, () -> {
                            lock.lock();
                            try { a.set(condition.awaitNanos(Long.MAX_VALUE) > 0 ? 1 : 0); b.set(lock.getHoldCount()); }
                            finally { lock.unlock(); }
                        });
                        awaitWaiters(lock, condition, 1);
                        lock.lock(); try { condition.signal(); } finally { lock.unlock(); }
                        join(threads.get(0)); measure = a.get(); result = b.get();
                        break;
                    case 14:
                        lock.lock();
                        try { lock.hasWaiters(new ReentrantLock().newCondition()); throw new AssertionError("Foreign condition accepted"); }
                        catch (IllegalArgumentException expected) { a.incrementAndGet(); }
                        try { lock.hasWaiters(null); throw new AssertionError("Null condition accepted"); }
                        catch (NullPointerException expected) { a.incrementAndGet(); }
                        check(!lock.hasWaiters(condition) && lock.waitingSize(condition) == 0 && !lock.hasQueuedThreads());
                        measure = a.get(); result = lock.ownerIsCurrent() ? 1 : 0; lock.unlock();
                        break;
                    case 15: {
                        lock.lock();
                        Thread waiter = start(threads, failure, () -> {
                            if (lock.tryLock(Long.MAX_VALUE, TimeUnit.DAYS)) {
                                try { a.set(1); b.set(lock.getHoldCount()); } finally { lock.unlock(); }
                            }
                        });
                        await(() -> lock.hasQueuedThread(waiter));
                        lock.unlock(); join(waiter); measure = a.get(); result = b.get();
                        break;
                    }
                    default: throw new AssertionError("Unknown lock case");
                }
            } finally {
                Thread.interrupted();
                while (lock.isHeldByCurrentThread()) lock.unlock();
                released.set(true);
                lock.lock(); try { condition.signalAll(); } finally { lock.unlock(); }
                for (Thread thread : threads) thread.interrupt();
                for (Thread thread : threads) join(thread);
            }
            if (failure.get() != null) throw new AssertionError("Owned lock worker failed", failure.get());
            check(measure == expectedMeasure[i] && result == expectedResult[i]);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, measure); json.append(",\"result\":"); append(json, result); json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static Thread start(ArrayList<Thread> threads, AtomicReference<Throwable> failure, Task task) {
        Thread thread = new Thread(() -> { try { task.run(); } catch (Throwable caught) { failure.set(caught); } });
        threads.add(thread); thread.start(); return thread;
    }
    private static void join(Thread thread) throws InterruptedException {
        thread.join(5000); check(!thread.isAlive());
    }
    private static void await(BooleanSupplier ready) throws InterruptedException {
        long start = System.nanoTime();
        while (!ready.getAsBoolean()) {
            if (System.nanoTime() - start > TimeUnit.SECONDS.toNanos(5)) throw new AssertionError("Lock worker did not reach expected state");
            Thread.sleep(1);
        }
    }
    private static void awaitWaiters(InspectableLock lock, Condition condition, int count) throws InterruptedException {
        await(() -> { lock.lock(); try { return lock.getWaitQueueLength(condition) == count; } finally { lock.unlock(); } });
    }
    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
    private static void check(boolean condition) { if (!condition) throw new AssertionError("Lock contract differs"); }
    private interface Task { void run() throws Exception; }
    private static final class InspectableLock extends ReentrantLock {
        InspectableLock(boolean fair) { super(fair); }
        boolean ownerIsCurrent() { return getOwner() == Thread.currentThread(); }
        int queuedSize() { return getQueuedThreads().size(); }
        int waitingSize(Condition condition) { return getWaitingThreads(condition).size(); }
    }
}
