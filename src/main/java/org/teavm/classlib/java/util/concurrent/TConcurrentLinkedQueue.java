package org.teavm.classlib.java.util.concurrent;

import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.function.Consumer;
import org.teavm.classlib.java.io.TSerializable;
import org.teavm.classlib.java.util.TAbstractQueue;
import org.teavm.classlib.java.util.TCollection;
import org.teavm.classlib.java.util.TIterator;
import org.teavm.classlib.java.util.TSpliterator;

/** Nonblocking queue for TeaVM's cooperative single-agent runtime, without cross-worker sharing. */
public class TConcurrentLinkedQueue<E> extends TAbstractQueue<E> implements TSerializable {
    private Node<E> head = new Node<>(null);
    private Node<E> tail = head;

    public TConcurrentLinkedQueue() { }

    public TConcurrentLinkedQueue(TCollection<? extends E> values) {
        addAll(values);
    }

    @Override
    public boolean offer(E value) {
        Node<E> node = new Node<>(Objects.requireNonNull(value));
        tail.next = node;
        tail = node;
        return true;
    }

    @Override
    public E poll() {
        for (Node<E> node = head.next; node != null; node = node.next) {
            E value = node.value;
            head = node;
            if (value != null) {
                node.value = null;
                return value;
            }
        }
        return null;
    }

    @Override
    public E peek() {
        for (Node<E> node = head.next; node != null; node = node.next) {
            if (node.value != null) return node.value;
        }
        return null;
    }

    @Override
    public int size() {
        int count = 0;
        for (Node<E> node = head.next; node != null; node = node.next) {
            if (node.value != null && ++count == Integer.MAX_VALUE) break;
        }
        return count;
    }

    @Override
    public boolean addAll(TCollection<? extends E> values) {
        Objects.requireNonNull(values);
        if (values == this) throw new IllegalArgumentException("Cannot add a queue to itself");
        Node<E> first = null;
        Node<E> last = null;
        for (TIterator<? extends E> iterator = values.iterator(); iterator.hasNext();) {
            Node<E> node = new Node<>(Objects.requireNonNull(iterator.next()));
            if (first == null) first = node;
            else last.next = node;
            last = node;
        }
        if (first == null) return false;
        tail.next = first;
        tail = last;
        return true;
    }

    @Override
    public TIterator<E> iterator() {
        return new TIterator<>() {
            Node<E> next;
            E nextValue;
            Node<E> last;
            { advance(head.next); }

            private void advance(Node<E> node) {
                while (node != null && node.value == null) node = node.next;
                next = node;
                nextValue = node == null ? null : node.value;
            }

            @Override
            public boolean hasNext() { return next != null; }

            @Override
            public E next() {
                if (next == null) throw new NoSuchElementException();
                E value = nextValue;
                last = next;
                advance(next.next);
                return value;
            }

            @Override
            public void remove() {
                if (last == null) throw new IllegalStateException();
                unlink(last);
                last = null;
            }
        };
    }

    @Override
    public TSpliterator<E> spliterator() {
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

    private void unlink(Node<E> removed) {
        if (removed.value == null) return;
        removed.value = null;
        for (Node<E> previous = head; previous.next != null; previous = previous.next) {
            if (previous.next == removed) {
                previous.next = removed.next;
                if (tail == removed) tail = previous;
                return;
            }
        }
    }

    private static final class Node<E> {
        E value;
        // Retained iterators must still reach successors after this node leaves the queue.
        Node<E> next;
        Node(E value) { this.value = value; }
    }
}
