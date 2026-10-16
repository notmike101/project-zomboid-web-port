import java.lang.reflect.InvocationTargetException;
import java.util.ConcurrentModificationException;
import java.util.NoSuchElementException;
import java.util.Stack;
import port.host.StackFirstSupport;

/** JDK 25 reference versus browser SDK 17 adapter; no original game code is loaded. */
public final class StackFirstQualification {
    private static boolean baseline;
    private static int checks;
    public static native void report(String json);

    private static Object first(Stack<?> stack) throws Throwable {
        if (!baseline) return StackFirstSupport.removeFirst(stack);
        try {
            return java.util.List.class.getMethod("removeFirst").invoke(stack);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Check " + checks + " failed");
        checks++;
    }

    private static void expect(Class<?> type, Stack<?> stack) throws Throwable {
        try {
            first(stack);
            throw new AssertionError("Expected " + type.getName());
        } catch (Throwable failure) {
            if (!type.isInstance(failure)) throw failure;
            checks++;
        }
    }

    private static final class Witness {
        volatile boolean started;
        volatile boolean completed;
        volatile Object result;
        volatile Throwable failure;
    }

    private static void monitorCheck() throws Throwable {
        Object value = new Object();
        Stack<Object> stack = new Stack<>();
        stack.push(value);
        Witness witness = new Witness();
        Thread worker = new Thread(() -> {
            witness.started = true;
            try {
                witness.result = first(stack);
            } catch (Throwable failure) {
                witness.failure = failure;
            } finally {
                witness.completed = true;
            }
        }, "owned-stack-removal");
        boolean blocked;
        try {
            synchronized (stack) {
                worker.start();
                long deadline = System.nanoTime() + 5_000_000_000L;
                while (!witness.started && System.nanoTime() < deadline) Thread.sleep(1);
                if (!witness.started) throw new AssertionError("Owned worker did not start");
                Thread.sleep(20);
                blocked = !witness.completed && stack.size() == 1;
            }
        } finally {
            worker.join(5000);
        }
        if (worker.isAlive()) throw new AssertionError("Owned worker did not exit");
        if (witness.failure != null) throw witness.failure;
        check(blocked && witness.completed && witness.result == value && stack.isEmpty());
    }

    public static void main(String[] args) {
        baseline = args.length > 0 && args[0].equals("--jvm");
        boolean emitToStdout = args.length > 0;
        try {
            Object head = new Object(), tail = new Object();
            Stack<Object> stack = new Stack<>();
            stack.push(head);
            stack.push(tail);
            check(first(stack) == head && stack.size() == 1 && stack.peek() == tail);
            check(first(stack) == tail && stack.isEmpty());
            expect(NoSuchElementException.class, stack);
            expect(NullPointerException.class, null);
            stack.push(null);
            stack.push(tail);
            check(first(stack) == null && stack.peek() == tail);
            stack.clear();
            stack.push(head);
            var iterator = stack.iterator();
            first(stack);
            try {
                iterator.next();
                throw new AssertionError("Iterator did not detect actual removal");
            } catch (ConcurrentModificationException expected) {
                checks++;
            }
            stack.push(head);
            synchronized (stack) {
                check(first(stack) == head && stack.isEmpty());
            }
            monitorCheck();
            try {
                StackFirstSupport.removeFirst(new Stack<Object>() { });
                throw new AssertionError("Unqualified subclass accepted");
            } catch (UnsupportedOperationException expected) {
                checks++;
            }
            String result = "{\"pass\":true,\"checks\":" + checks
                    + ",\"exactStackOnly\":true,\"individualVectorLocks\":true,\"wholeOperationAtomicityClaimed\":false}";
            if (emitToStdout) System.out.println(result);
            else report(result);
        } catch (Throwable failure) {
            failure.printStackTrace();
            if (emitToStdout) throw new AssertionError(failure);
            report("{\"pass\":false,\"checks\":" + checks + "}");
        }
    }
}
