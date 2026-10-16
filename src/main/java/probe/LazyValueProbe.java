package probe;

import java.util.function.Supplier;
import zombie.util.LazyValue;

/** Exercises the original lazy-value state machine without threads or engine initialization. */
public final class LazyValueProbe {
    public static void main(String[] args) {
        String[] names = {"ordinary-memoization", "null-memoization", "identity-cached", "exception-retry",
                "null-supplier", "reentrant-witness", "distinct-instances", "mutable-value"};
        int[] expectedCalls = {1, 1, 1, 2, 0, 2, 2, 1};
        int[] expectedResults = {42, 1, 1, 73, 1, 23, 38, 9};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            int[] calls = {0};
            int result;
            switch (i) {
                case 0: {
                    LazyValue<Integer> lazy = new LazyValue<>(() -> { calls[0]++; return 42; });
                    check(calls[0] == 0);
                    result = lazy.get();
                    check(lazy.get() == result);
                    break;
                }
                case 1: {
                    LazyValue<Object> lazy = new LazyValue<>(() -> { calls[0]++; return null; });
                    check(lazy.get() == null && lazy.get() == null);
                    result = 1;
                    break;
                }
                case 2: {
                    Object value = new Object();
                    LazyValue<Object> lazy = new LazyValue<>(() -> { calls[0]++; return value; });
                    check(lazy.get() == value && lazy.get() == value);
                    result = 1;
                    break;
                }
                case 3: {
                    IllegalStateException failure = new IllegalStateException("Expected supplier failure");
                    LazyValue<Integer> lazy = new LazyValue<>(() -> {
                        if (++calls[0] == 1) throw failure;
                        return 73;
                    });
                    try {
                        lazy.get();
                        throw new AssertionError("Supplier failure swallowed");
                    } catch (IllegalStateException caught) { check(caught == failure); }
                    result = lazy.get();
                    check(lazy.get() == result);
                    break;
                }
                case 4: {
                    try {
                        new LazyValue<Object>(null);
                        throw new AssertionError("Null supplier accepted");
                    } catch (NullPointerException expected) { result = 1; }
                    break;
                }
                case 5: {
                    ReentrantSupplier supplier = new ReentrantSupplier();
                    supplier.lazy = new LazyValue<>(supplier);
                    result = supplier.lazy.get();
                    check(supplier.lazy.get() == result && supplier.inner == 23);
                    calls[0] = supplier.calls;
                    break;
                }
                case 6: {
                    LazyValue<Integer> a = new LazyValue<>(() -> { calls[0]++; return 11; });
                    LazyValue<Integer> b = new LazyValue<>(() -> { calls[0]++; return 27; });
                    result = a.get() + b.get();
                    check(a.get() == 11 && b.get() == 27);
                    break;
                }
                case 7: {
                    int[] value = {3};
                    LazyValue<int[]> lazy = new LazyValue<>(() -> { calls[0]++; return value; });
                    check(lazy.get() == value);
                    value[0] = 9;
                    result = lazy.get()[0];
                    check(lazy.get() == value);
                    break;
                }
                default: throw new AssertionError("Unknown lazy-value case");
            }
            check(calls[0] == expectedCalls[i] && result == expectedResults[i]);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"supplierCalls\":");
            append(json, calls[0]);
            json.append(",\"result\":");
            append(json, result);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Original lazy-value contract differs");
    }

    private static final class ReentrantSupplier implements Supplier<Integer> {
        LazyValue<Integer> lazy;
        int calls;
        int inner;
        @Override public Integer get() {
            if (++calls == 1) {
                inner = lazy.get();
                return 99;
            }
            return 23;
        }
    }
}
