package port.host;
import java.util.*;
/** The List.removeLast default operation for the original Pool's ArrayList receiver. */
public final class PoolListSupport {
    public static <E> E removeLast(List<E> list) {
        if (list.getClass() != ArrayList.class)
            throw new UnsupportedOperationException("Unqualified List.removeLast receiver: " + list.getClass().getName());
        if (list.isEmpty()) throw new NoSuchElementException();
        return list.remove(list.size() - 1);
    }
}
