package org.teavm.classlib.java.util.concurrent;

import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.function.Consumer;
import org.teavm.classlib.java.io.TSerializable;
import org.teavm.classlib.java.util.TAbstractQueue;
import org.teavm.classlib.java.util.TCollection;
import org.teavm.classlib.java.util.TDeque;
import org.teavm.classlib.java.util.TIterator;
import org.teavm.classlib.java.util.TSpliterator;

/** Deque for TeaVM's cooperative single-agent runtime, without cross-worker sharing. */
public class TConcurrentLinkedDeque<E> extends TAbstractQueue<E> implements TDeque<E>, TSerializable {
    // shortcut: cooperative single-agent links, replace with atomics before cross-worker sharing.
    private Node<E> first;
    private Node<E> last;

    public TConcurrentLinkedDeque() { }
    public TConcurrentLinkedDeque(TCollection<? extends E> values) { addAll(values); }

    @Override public boolean offerFirst(E value) {
        Node<E> node = new Node<>(Objects.requireNonNull(value));
        node.next = first;
        if (first == null) last = node;
        else first.previous = node;
        first = node;
        return true;
    }
    @Override public boolean offerLast(E value) {
        Node<E> node = new Node<>(Objects.requireNonNull(value));
        node.previous = last;
        if (last == null) first = node;
        else last.next = node;
        last = node;
        return true;
    }
    @Override public void addFirst(E value) { offerFirst(value); }
    @Override public void addLast(E value) { offerLast(value); }
    @Override public boolean offer(E value) { return offerLast(value); }
    @Override public E poll() { return pollFirst(); }
    @Override public E peek() { return peekFirst(); }
    @Override public E pollFirst() { return first == null ? null : unlink(first); }
    @Override public E pollLast() { return last == null ? null : unlink(last); }
    @Override public E peekFirst() { return first == null ? null : first.value; }
    @Override public E peekLast() { return last == null ? null : last.value; }
    @Override public E getFirst() { if (first == null) throw new NoSuchElementException(); return first.value; }
    @Override public E getLast() { if (last == null) throw new NoSuchElementException(); return last.value; }
    @Override public E removeFirst() { return unlinkRequired(first); }
    @Override public E removeLast() { return unlinkRequired(last); }
    @Override public void push(E value) { addFirst(value); }
    @Override public E pop() { return removeFirst(); }
    @Override public boolean remove(Object value) { return removeFirstOccurrence(value); }
    @Override public boolean removeFirstOccurrence(Object value) { return removeOccurrence(value, false); }
    @Override public boolean removeLastOccurrence(Object value) { return removeOccurrence(value, true); }

    private boolean removeOccurrence(Object value, boolean reverse) {
        Objects.requireNonNull(value);
        for (Node<E> node = reverse ? last : first; node != null; node = reverse ? node.previous : node.next) {
            if (value.equals(node.value)) { unlink(node); return true; }
        }
        return false;
    }
    private E unlinkRequired(Node<E> node) {
        if (node == null) throw new NoSuchElementException();
        return unlink(node);
    }
    private E unlink(Node<E> node) {
        E value = node.value;
        if (value == null) return null;
        node.value = null;
        if (node.previous == null) first = node.next;
        else node.previous.next = node.next;
        if (node.next == null) last = node.previous;
        else node.next.previous = node.previous;
        return value;
    }
    @Override public int size() {
        int count = 0;
        for (Node<E> node = first; node != null; node = node.next) {
            if (++count == Integer.MAX_VALUE) break;
        }
        return count;
    }
    @Override public boolean addAll(TCollection<? extends E> values) {
        Objects.requireNonNull(values);
        if (values == this) throw new IllegalArgumentException("Cannot add a deque to itself");
        Node<E> head = null;
        Node<E> tail = null;
        for (TIterator<? extends E> iterator = values.iterator(); iterator.hasNext();) {
            Node<E> node = new Node<>(Objects.requireNonNull(iterator.next()));
            node.previous = tail;
            if (head == null) head = node;
            else tail.next = node;
            tail = node;
        }
        if (head == null) return false;
        head.previous = last;
        if (last == null) first = head;
        else last.next = head;
        last = tail;
        return true;
    }
    @Override public TIterator<E> iterator() { return iterator(false); }
    @Override public TIterator<E> descendingIterator() { return iterator(true); }
    private TIterator<E> iterator(boolean reverse) {
        return new TIterator<>() {
            Node<E> next;
            Node<E> returned;
            E nextValue;
            { advance(reverse ? last : first); }
            private void advance(Node<E> node) {
                while (node != null && node.value == null) node = reverse ? node.previous : node.next;
                next = node;
                nextValue = node == null ? null : node.value;
            }
            @Override public boolean hasNext() { return next != null; }
            @Override public E next() {
                if (next == null) throw new NoSuchElementException();
                E result = nextValue;
                returned = next;
                advance(reverse ? next.previous : next.next);
                return result;
            }
            @Override public void remove() {
                if (returned == null) throw new IllegalStateException();
                unlink(returned);
                returned = null;
            }
        };
    }
    @Override public TSpliterator<E> spliterator() {
        return new TSpliterator<>() {
            TIterator<E> iterator;
            @Override public boolean tryAdvance(Consumer<? super E> action) {
                Objects.requireNonNull(action);
                if (iterator == null) iterator = iterator();
                if (!iterator.hasNext()) return false;
                action.accept(iterator.next());
                return true;
            }
            @Override public TSpliterator<E> trySplit() { return null; }
            @Override public long estimateSize() { return Long.MAX_VALUE; }
            @Override public int characteristics() { return ORDERED | NONNULL | CONCURRENT; }
        };
    }
    private static final class Node<E> {
        E value;
        // Removed nodes retain traversal links for iterators already holding them.
        Node<E> previous;
        Node<E> next;
        Node(E value) { this.value = value; }
    }
}
