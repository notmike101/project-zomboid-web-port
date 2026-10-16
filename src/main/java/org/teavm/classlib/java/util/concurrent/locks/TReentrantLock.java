package org.teavm.classlib.java.util.concurrent.locks;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.Objects;
import org.teavm.classlib.java.io.TSerializable;
import org.teavm.classlib.java.util.concurrent.TTimeUnit;

/** Reentrant ownership and condition queues for one cooperative TeaVM agent, without parallel-worker atomics. */
public class TReentrantLock implements TLock, TSerializable {
    private final boolean fair;
    private Thread owner;
    private int holds;
    private final ArrayList<Waiter> queue = new ArrayList<>();

    public TReentrantLock() { this(false); }
    public TReentrantLock(boolean fair) { this.fair = fair; }

    @Override public void lock() {
        try { acquire(false, false, 0); }
        catch (InterruptedException impossible) { throw new AssertionError(impossible); }
    }

    @Override public void lockInterruptibly() throws InterruptedException { acquire(true, false, 0); }

    @Override public boolean tryLock() { return take(Thread.currentThread(), false); }

    @Override public boolean tryLock(long time, TTimeUnit unit) throws InterruptedException {
        return acquire(true, true, Objects.requireNonNull(unit).toNanos(time));
    }

    private boolean acquire(boolean interruptible, boolean timed, long budget) throws InterruptedException {
        if (interruptible && Thread.interrupted()) throw new InterruptedException();
        Thread thread = Thread.currentThread();
        if (take(thread, fair)) return true;
        Waiter waiter = new Waiter(thread);
        queue.add(waiter);
        return acquireQueued(waiter, 1, interruptible, timed, budget);
    }

    private boolean take(Thread thread, boolean respectQueue) {
        if (owner == thread) {
            if (holds == Integer.MAX_VALUE) throw new Error("Maximum lock count exceeded");
            holds++;
            return true;
        }
        if (owner != null || (respectQueue && !queue.isEmpty())) return false;
        owner = thread;
        holds = 1;
        return true;
    }

    private boolean acquireQueued(Waiter waiter, int count, boolean interruptible, boolean timed, long budget)
            throws InterruptedException {
        long start = System.nanoTime();
        boolean interrupted = false;
        boolean acquired = false;
        try {
            for (;;) {
                if (interruptible && Thread.interrupted()) throw new InterruptedException();
                if (owner == null && (!fair || queue.get(0) == waiter)) {
                    queue.remove(waiter);
                    owner = waiter.thread;
                    holds = count;
                    acquired = true;
                    return true;
                }
                if (timed && (budget <= 0 || System.nanoTime() - start >= budget)) return false;
                try { Thread.sleep(1); }
                catch (InterruptedException caught) {
                    if (interruptible) throw caught;
                    interrupted = true;
                }
            }
        } finally {
            if (!acquired) queue.remove(waiter);
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    @Override public void unlock() {
        requireOwner();
        if (--holds == 0) owner = null;
    }

    @Override public TCondition newCondition() { return new ConditionObject(); }
    public int getHoldCount() { return isHeldByCurrentThread() ? holds : 0; }
    public boolean isHeldByCurrentThread() { return owner == Thread.currentThread(); }
    public boolean isLocked() { return owner != null; }
    public final boolean isFair() { return fair; }
    protected Thread getOwner() { return owner; }
    public final boolean hasQueuedThreads() { return !queue.isEmpty(); }
    public final boolean hasQueuedThread(Thread thread) {
        Objects.requireNonNull(thread);
        for (Waiter waiter : queue) if (waiter.thread == thread) return true;
        return false;
    }
    public final int getQueueLength() { return queue.size(); }
    protected Collection<Thread> getQueuedThreads() {
        ArrayList<Thread> result = new ArrayList<>();
        for (Waiter waiter : queue) result.add(waiter.thread);
        return result;
    }
    public boolean hasWaiters(TCondition condition) { return !condition(condition).waiters.isEmpty(); }
    public int getWaitQueueLength(TCondition condition) { return condition(condition).waiters.size(); }
    protected Collection<Thread> getWaitingThreads(TCondition condition) {
        ArrayList<Thread> result = new ArrayList<>();
        for (Waiter waiter : condition(condition).waiters) result.add(waiter.thread);
        return result;
    }

    private ConditionObject condition(TCondition condition) {
        Objects.requireNonNull(condition);
        if (!(condition instanceof ConditionObject)) throw new IllegalArgumentException("Foreign condition");
        ConditionObject result = (ConditionObject) condition;
        if (result.lock != this) throw new IllegalArgumentException("Foreign condition");
        requireOwner();
        return result;
    }

    private void requireOwner() {
        if (!isHeldByCurrentThread()) throw new IllegalMonitorStateException("Current thread does not own lock");
    }

    @Override public String toString() {
        return super.toString() + (owner == null ? "[Unlocked]" : "[Locked by thread " + owner.getName() + "]");
    }

    private static final class Waiter {
        final Thread thread;
        boolean transferred;
        boolean signalled;
        Waiter(Thread thread) { this.thread = thread; }
    }

    private final class ConditionObject implements TCondition {
        final TReentrantLock lock = TReentrantLock.this;
        final ArrayList<Waiter> waiters = new ArrayList<>();

        @Override public void await() throws InterruptedException { awaitInternal(true, false, 0, false, 0); }
        @Override public void awaitUninterruptibly() {
            try { awaitInternal(false, false, 0, false, 0); }
            catch (InterruptedException impossible) { throw new AssertionError(impossible); }
        }
        @Override public long awaitNanos(long budget) throws InterruptedException {
            long start = System.nanoTime();
            awaitInternal(true, true, budget, false, 0);
            long elapsed = System.nanoTime() - start;
            return budget < Long.MIN_VALUE + elapsed ? Long.MIN_VALUE : budget - elapsed;
        }
        @Override public boolean await(long time, TTimeUnit unit) throws InterruptedException {
            return awaitInternal(true, true, Objects.requireNonNull(unit).toNanos(time), false, 0);
        }
        @Override public boolean awaitUntil(Date deadline) throws InterruptedException {
            return awaitInternal(true, true, 0, true, Objects.requireNonNull(deadline).getTime());
        }

        private boolean awaitInternal(boolean interruptible, boolean timed, long budget, boolean wallClock, long deadline)
                throws InterruptedException {
            if (interruptible && Thread.interrupted()) throw new InterruptedException();
            requireOwner();
            int saved = holds;
            Waiter waiter = new Waiter(Thread.currentThread());
            waiters.add(waiter);
            owner = null;
            holds = 0;
            long start = System.nanoTime();
            boolean interrupted = false;
            boolean throwInterrupted = false;
            while (!waiter.transferred) {
                boolean expired = timed && (wallClock ? System.currentTimeMillis() >= deadline
                        : budget <= 0 || System.nanoTime() - start >= budget);
                if (expired) { transfer(waiter, false); break; }
                try { Thread.sleep(1); }
                catch (InterruptedException caught) {
                    interrupted = true;
                    if (interruptible && !waiter.signalled) {
                        throwInterrupted = true;
                        transfer(waiter, false);
                    }
                }
            }
            acquireQueued(waiter, saved, false, false, 0);
            if (throwInterrupted) {
                Thread.interrupted();
                throw new InterruptedException();
            }
            if (interrupted) Thread.currentThread().interrupt();
            return waiter.signalled;
        }

        private void transfer(Waiter waiter, boolean signalled) {
            if (waiter.transferred) return;
            waiters.remove(waiter);
            waiter.signalled = signalled;
            waiter.transferred = true;
            queue.add(waiter);
        }

        @Override public void signal() {
            requireOwner();
            if (!waiters.isEmpty()) transfer(waiters.get(0), true);
        }
        @Override public void signalAll() {
            requireOwner();
            while (!waiters.isEmpty()) transfer(waiters.get(0), true);
        }
    }
}
