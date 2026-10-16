package probe;

import java.util.Arrays;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.concurrent.ConcurrentLinkedQueue;

/** Standard-library queue contracts, separate from original-game coverage. */
public final class QueueProbe {
    public static void main(String[] args) {
        String[] names = {"fifo", "empty", "nulls", "collection-addAll", "invalid-addAll",
                "iterator-node-removal", "iterator-retained-node", "collection-surface"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            ConcurrentLinkedQueue<String> q = new ConcurrentLinkedQueue<>();
            int checks = 0;
            String result;
            switch (i) {
                case 0:
                    q.offer("a"); q.add("b"); q.offer("c");
                    result = q.peek() + q.poll() + q.remove() + q.element() + q.poll();
                    check(result.equals("aabcc") && q.isEmpty());
                    checks = 1;
                    break;
                case 1:
                    check(q.peek() == null && q.poll() == null && q.size() == 0);
                    reject(q::remove, NoSuchElementException.class);
                    reject(q::element, NoSuchElementException.class);
                    reject(() -> q.iterator().next(), NoSuchElementException.class);
                    checks = 4;
                    result = q.toString();
                    break;
                case 2:
                    reject(() -> q.offer(null), NullPointerException.class);
                    reject(() -> q.add(null), NullPointerException.class);
                    reject(() -> new ConcurrentLinkedQueue<String>(null), NullPointerException.class);
                    reject(() -> new ConcurrentLinkedQueue<>(Arrays.asList("a", null)), NullPointerException.class);
                    check(!q.contains(null) && !q.remove(null) && q.isEmpty());
                    checks = 5;
                    result = q.toString();
                    break;
                case 3:
                    q.addAll(new ConcurrentLinkedQueue<>(Arrays.asList("a", "b")));
                    check(q.addAll(Arrays.asList("c", "d")));
                    check(!q.addAll(Arrays.asList()));
                    check(q.size() == 4 && Arrays.equals(q.toArray(new String[0]), new String[]{"a", "b", "c", "d"}));
                    checks = 3;
                    result = q.toString();
                    break;
                case 4:
                    q.add("kept");
                    ConcurrentLinkedQueue<String> target = q;
                    reject(() -> target.addAll(null), NullPointerException.class);
                    reject(() -> target.addAll(target), IllegalArgumentException.class);
                    reject(() -> target.addAll(Arrays.asList("a", null, "b")), NullPointerException.class);
                    check(q.size() == 1 && q.peek().equals("kept"));
                    checks = 4;
                    result = q.toString();
                    break;
                case 5:
                    q.addAll(Arrays.asList("same", "middle", "same"));
                    Iterator<String> iterator = q.iterator();
                    reject(iterator::remove, IllegalStateException.class);
                    iterator.next(); iterator.next(); iterator.next();
                    iterator.remove();
                    reject(iterator::remove, IllegalStateException.class);
                    check(q.toString().equals("[same, middle]"));
                    checks = 3;
                    result = q.toString();
                    break;
                case 6:
                    q.addAll(Arrays.asList("a", "b", "c"));
                    Iterator<String> retained = q.iterator();
                    check(q.poll().equals("a"));
                    check(retained.next().equals("a"));
                    retained.remove();
                    check(q.toString().equals("[b, c]"));
                    check(retained.next().equals("b"));
                    retained.remove();
                    check(retained.next().equals("c") && !retained.hasNext());
                    check(q.toString().equals("[c]"));
                    checks = 6;
                    result = q.toString();
                    break;
                default:
                    q.addAll(Arrays.asList("a", "b", "c", "d"));
                    check(q.containsAll(Arrays.asList("a", "d")));
                    check(q.remove("b") && !q.remove("missing"));
                    check(q.removeAll(Arrays.asList("a", "x")));
                    check(q.retainAll(Arrays.asList("d")));
                    check(q.toString().equals("[d]"));
                    q.clear(); q.add("reused");
                    Spliterator<String> split = q.spliterator();
                    check(split.characteristics() == (Spliterator.ORDERED | Spliterator.NONNULL | Spliterator.CONCURRENT));
                    reject(() -> split.tryAdvance(null), NullPointerException.class);
                    StringBuilder visited = new StringBuilder();
                    check(split.tryAdvance(visited::append) && visited.toString().equals("reused"));
                    check(!split.tryAdvance(visited::append));
                    check(q.poll().equals("reused") && q.isEmpty());
                    checks = 10;
                    result = q.toString();
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"checks\":");
            append(json, checks);
            json.append(",\"contentHash\":");
            append(json, result.hashCode());
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Queue contract differs");
    }

    private static void reject(Runnable action, Class<? extends RuntimeException> expected) {
        try { action.run(); }
        catch (RuntimeException error) {
            if (expected.isInstance(error)) return;
            throw new AssertionError("Unexpected rejection", error);
        }
        throw new AssertionError("Invalid operation accepted");
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
