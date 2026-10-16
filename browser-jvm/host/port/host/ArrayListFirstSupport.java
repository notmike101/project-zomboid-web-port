package port.host;

import java.util.ArrayList;

/** Exact ArrayList receiver subset of the JDK 25 addFirst SDK operation. */
public final class ArrayListFirstSupport {
    private ArrayListFirstSupport() { }

    public static <E> void addFirst(ArrayList<E> list, E value) {
        if (list.getClass() != ArrayList.class) {
            throw new UnsupportedOperationException("Unqualified ArrayList.addFirst receiver: " + list.getClass().getName());
        }
        list.add(0, value);
    }
}
