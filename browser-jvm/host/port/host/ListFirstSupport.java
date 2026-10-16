package port.host;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
/** Java21 ArrayList.getFirst operation for the original AnimLayer's exact ArrayList receiver. */
public final class ListFirstSupport {
 private ListFirstSupport() { }
 public static <E> E getFirst(List<E> list) {
  if(list.getClass()!=ArrayList.class)throw new UnsupportedOperationException("Unqualified List.getFirst receiver: "+list.getClass().getName());
  if(list.isEmpty())throw new NoSuchElementException();
  return list.get(0);
 }
}
