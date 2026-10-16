package port.host;
import java.lang.invoke.VarHandle;
/** Reference instance-field compare-and-exchange using real volatile reads and CAS. */
public final class ReferenceExchange {
 public static Object compareAndExchange(VarHandle handle,Object receiver,Object expected,Object update){
  while(true){Object witness=handle.getVolatile(receiver);if(witness!=expected)return witness;if(handle.compareAndSet(receiver,expected,update))return expected;}
 }
}
