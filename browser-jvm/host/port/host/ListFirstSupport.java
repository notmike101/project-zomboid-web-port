package port.host;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
/** Java21 endpoint operations for the qualified original callers' exact ArrayList receivers. */
public final class ListFirstSupport {
 private ListFirstSupport() { }
 private static void requireNonEmptyArrayList(List<?> list) {
  if(list.getClass()!=ArrayList.class)throw new UnsupportedOperationException("Unqualified List endpoint receiver: "+list.getClass().getName());
  if(list.isEmpty())throw new NoSuchElementException();
 }
 public static <E> E getFirst(List<E> list) { requireNonEmptyArrayList(list); return list.get(0); }
 public static <E> E getLast(List<E> list) { requireNonEmptyArrayList(list); return list.get(list.size()-1); }
 public static <E> E removeFirst(List<E> list) { requireNonEmptyArrayList(list); return list.remove(0); }
}
