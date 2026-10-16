import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.ConcurrentModificationException;
import port.host.ArrayListFirstSupport;

/** Authored-only JDK 25 reference versus browser SDK 17 adapter qualification. */
public final class ArrayListFirstQualification {
    private static boolean baseline;
    private static int checks;
    public static native void report(String json);

    private static void first(ArrayList<Object> list, Object value) throws Throwable {
        if (!baseline) {
            ArrayListFirstSupport.addFirst(list, value);
            return;
        }
        // The adapted call is invokevirtual; a null receiver must fail before reflection.
        if (list == null) throw new NullPointerException();
        try {
            ArrayList.class.getMethod("addFirst", Object.class).invoke(list, value);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Check " + checks + " failed");
        checks++;
    }

    public static void main(String[] args) {
        baseline = args.length > 0 && args[0].equals("baseline");
        boolean stdout = args.length > 1 && args[1].equals("stdout");
        try {
            Object head = new Object(), tail = new Object();
            ArrayList<Object> list = new ArrayList<>(0);
            first(list, tail);
            check(list.size() == 1 && list.get(0) == tail);
            first(list, head);
            check(list.size() == 2 && list.get(0) == head && list.get(1) == tail);
            first(list, null);
            check(list.size() == 3 && list.get(0) == null && list.get(1) == head && list.get(2) == tail);
            var iterator = list.iterator();
            first(list, head);
            try {
                iterator.next();
                throw new AssertionError("Insertion did not invalidate iterator");
            } catch (ConcurrentModificationException expected) { checks++; }
            list.ensureCapacity(1024);
            for (int i = 0; i < 100; i++) first(list, i);
            check(list.size() == 104 && list.get(0).equals(99) && list.get(99).equals(0));
            check(list.get(100) == head && list.get(101) == null && list.get(102) == head && list.get(103) == tail);
            list.trimToSize();
            first(list, tail);
            check(list.size() == 105 && list.get(0) == tail && list.get(1).equals(99));
            try {
                first(null, head);
                throw new AssertionError("Null receiver accepted");
            } catch (NullPointerException expected) { checks++; }
            try {
                ArrayListFirstSupport.addFirst(new ArrayList<Object>() { }, head);
                throw new AssertionError("Unqualified subclass accepted");
            } catch (UnsupportedOperationException expected) { checks++; }
            String json = "{\"pass\":true,\"checks\":" + checks + ",\"exactArrayListOnly\":true}";
            if (stdout) System.out.println(json); else report(json);
        } catch (Throwable failure) {
            failure.printStackTrace();
            if (stdout) throw new AssertionError(failure);
            report("{\"pass\":false,\"checks\":" + checks + "}");
        }
    }
}
