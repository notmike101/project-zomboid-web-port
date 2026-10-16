package probe;

import java.util.Arrays;
import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.concurrent.ConcurrentLinkedDeque;

/** Cooperative deque semantics, independent from original game coverage. */
public final class DequeProbe {
    public static void main(String[] args) {
        String[] names = {"both-ends", "empty", "occurrences", "null-bulk-atomic",
                "forward-retention", "descending-retention", "iterator-node-remove", "spliterator"};
        String[] expected = {"1234:1423", "empty", "[b, a]", "[a]", "abc", "cba", "[b, a]", "abc"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            ConcurrentLinkedDeque<String> deque = new ConcurrentLinkedDeque<>();
            String result;
            switch (i) {
                case 0:
                    deque.addLast("2"); deque.addFirst("1"); deque.offer("3"); deque.offerLast("4");
                    String order = deque.getFirst() + "2" + "3" + deque.getLast();
                    result = order + ":" + deque.removeFirst() + deque.removeLast() + deque.pollFirst() + deque.pollLast();
                    deque.push("x");
                    if (!deque.pop().equals("x") || !deque.isEmpty()) throw new AssertionError(names[i]);
                    break;
                case 1:
                    if (deque.pollFirst() != null || deque.pollLast() != null || deque.peekFirst() != null || deque.peekLast() != null) throw new AssertionError(names[i]);
                    try { deque.removeLast(); throw new AssertionError(); } catch (NoSuchElementException expectedFailure) { }
                    try { deque.getFirst(); throw new AssertionError(); } catch (NoSuchElementException expectedFailure) { }
                    result = "empty";
                    break;
                case 2:
                    deque.addAll(Arrays.asList("a", "b", "a", "a"));
                    if (!deque.removeFirstOccurrence("a") || !deque.removeLastOccurrence("a")) throw new AssertionError(names[i]);
                    try { deque.remove(null); throw new AssertionError(); } catch (NullPointerException expectedFailure) { }
                    result = deque.toString();
                    break;
                case 3:
                    deque.add("a");
                    try { deque.addAll(Arrays.asList("b", null)); throw new AssertionError(); } catch (NullPointerException expectedFailure) { }
                    try { deque.offerFirst(null); throw new AssertionError(); } catch (NullPointerException expectedFailure) { }
                    try { deque.offerLast(null); throw new AssertionError(); } catch (NullPointerException expectedFailure) { }
                    try { deque.addAll(deque); throw new AssertionError(); } catch (IllegalArgumentException expectedFailure) { }
                    result = deque.toString();
                    break;
                case 4: case 5:
                    deque.addAll(Arrays.asList("a", "b", "c"));
                    Iterator<String> retained = i == 4 ? deque.iterator() : deque.descendingIterator();
                    String start = retained.next();
                    if (i == 4) deque.pollFirst(); else deque.pollLast();
                    result = start + retained.next() + retained.next();
                    if (retained.hasNext()) throw new AssertionError(names[i]);
                    ConcurrentLinkedDeque<String> pending = new ConcurrentLinkedDeque<>(Arrays.asList("a", "b", "c"));
                    Iterator<String> pendingIterator = i == 4 ? pending.iterator() : pending.descendingIterator();
                    pendingIterator.next();
                    pending.remove("b");
                    if (!pendingIterator.next().equals("b") || !pendingIterator.next().equals(i == 4 ? "c" : "a")) throw new AssertionError("Removed node lost successor");
                    break;
                case 6:
                    deque.addAll(Arrays.asList("a", "b", "a"));
                    Iterator<String> iterator = deque.iterator();
                    try { iterator.remove(); throw new AssertionError(); } catch (IllegalStateException expectedFailure) { }
                    iterator.next(); deque.pollFirst(); iterator.remove();
                    try { iterator.remove(); throw new AssertionError(); } catch (IllegalStateException expectedFailure) { }
                    result = deque.toString();
                    break;
                default:
                    deque.addAll(Arrays.asList("a", "b", "c"));
                    Spliterator<String> split = deque.spliterator();
                    int flags = Spliterator.ORDERED | Spliterator.NONNULL | Spliterator.CONCURRENT;
                    if (split.characteristics() != flags || split.estimateSize() != Long.MAX_VALUE) throw new AssertionError(names[i]);
                    try { split.tryAdvance(null); throw new AssertionError(); } catch (NullPointerException expectedFailure) { }
                    StringBuilder collected = new StringBuilder();
                    split.forEachRemaining(collected::append);
                    result = collected.toString();
            }
            if (!result.equals(expected[i])) throw new AssertionError(names[i] + ":" + result);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, result.length());
            json.append(",\"contentHash\":");
            append(json, result.hashCode());
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
}
