package port.host;
import java.nio.*;import java.util.*;
/** Owned direct buffers, released for Java GC; no native address exported. */
public final class BrowserBuffers {
 private static final Set<ByteBuffer> owned=Collections.newSetFromMap(new IdentityHashMap<>());
 public static ByteBuffer memAlloc(int bytes){if(bytes<0)throw new IllegalArgumentException("Negative bytes");ByteBuffer value=ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder());owned.add(value);return value;}
 public static void memFree(ByteBuffer value){if(value!=null&&!owned.remove(value))throw new IllegalArgumentException("Buffer not owned or already freed");}
 public static int allocations(){return owned.size();}
}
