package port.host;
import java.nio.file.Path;
/** Java25 Path.resolve(String,String...) contract expressed using Java17 Path.resolve(String). */
public final class PathCompat {
 private PathCompat(){}
 public static <E> java.util.List<E> reversedImmutableList(java.util.List<E> base){java.util.Objects.requireNonNull(base);java.util.List<E> view=base instanceof java.util.RandomAccess?new ReverseRandomAccess<>(base):new Reverse<>(base);return java.util.Collections.unmodifiableList(view);}
 private static class Reverse<E> extends java.util.AbstractList<E>{final java.util.List<E> base;Reverse(java.util.List<E> base){this.base=base;}public int size(){return base.size();}public E get(int index){java.util.Objects.checkIndex(index,size());return base.get(size()-1-index);}}
 private static final class ReverseRandomAccess<E> extends Reverse<E> implements java.util.RandomAccess{ReverseRandomAccess(java.util.List<E> base){super(base);}}
 public static Path resolve(Path receiver,String first,String[] more){Path result=receiver.resolve(first);for(String part:more)result=result.resolve(part);return result;}
}
