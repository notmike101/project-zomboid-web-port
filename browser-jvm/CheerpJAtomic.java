package probe;
import java.lang.invoke.*;
public final class CheerpJAtomic {
 public volatile Object value;
 public static native void report(String json);
 public static void main(String[] args){String stage="lookup";try{
  VarHandle handle=MethodHandles.lookup().findVarHandle(CheerpJAtomic.class,"value",Object.class);
  CheerpJAtomic receiver=new CheerpJAtomic();Object a=new Object(),b=new Object();receiver.value=a;
  stage="getVolatile";if(handle.getVolatile(receiver)!=a)throw new AssertionError("volatile witness");
  stage="compareAndSet-false";if(handle.compareAndSet(receiver,b,null)||receiver.value!=a)throw new AssertionError("failed CAS mutated");
  stage="compareAndSet-true";if(!handle.compareAndSet(receiver,a,b)||receiver.value!=b)throw new AssertionError("successful CAS missing");
  stage="witness-loop";if(exchange(handle,receiver,a,null)!=b||receiver.value!=b)throw new AssertionError("mismatch witness");
  if(exchange(handle,receiver,b,null)!=b||receiver.value!=null)throw new AssertionError("exchange witness");
  stage="contended-witness";receiver.value=Integer.valueOf(0);Thread[] threads=new Thread[4];Throwable[] errors=new Throwable[4];
  for(int i=0;i<threads.length;i++){final int index=i;threads[i]=new Thread(()->{try{for(int n=0;n<200;n++){while(true){Object old=handle.getVolatile(receiver);Thread.yield();if(port.host.ReferenceExchange.compareAndExchange(handle,receiver,old,Integer.valueOf(((Integer)old)+1))==old)break;}}}catch(Throwable error){errors[index]=error;}});threads[i].start();}
  for(Thread thread:threads)thread.join();for(Throwable error:errors)if(error!=null)throw new AssertionError(error);if(!Integer.valueOf(800).equals(receiver.value))throw new AssertionError("lost exchanges: "+receiver.value);
  stage="original-lazy";int[] calls={0};Object shared=new Object();var value=new zombie.util.LazyValue<Object>(()->{calls[0]++;return shared;});if(value.get()!=shared||value.get()!=shared||calls[0]!=1)throw new AssertionError("original memoized identity");
  var nil=new zombie.util.LazyValue<Object>(()->{calls[0]++;return null;});if(nil.get()!=null||nil.get()!=null||calls[0]!=2)throw new AssertionError("original memoized null");
  int[] failures={0};var retry=new zombie.util.LazyValue<Object>(()->{if(failures[0]++==0)throw new IllegalStateException("expected");return shared;});try{retry.get();throw new AssertionError("supplier exception swallowed");}catch(IllegalStateException expected){}if(retry.get()!=shared||failures[0]!=2)throw new AssertionError("original retry");
  stage="original-resettable";int[] resets={0};var reset=new zombie.util.ResettableLazyValue<Object>(()->Integer.valueOf(++resets[0]));if(!Integer.valueOf(1).equals(reset.get()))throw new AssertionError("first");reset.reset();if(!Integer.valueOf(2).equals(reset.get())||!Integer.valueOf(2).equals(reset.get()))throw new AssertionError("reset");
  stage="original-reentrant";zombie.util.LazyValue<?>[] reentrant=new zombie.util.LazyValue<?>[1];int[] recursion={0};Object inner=new Object(),outer=new Object();reentrant[0]=new zombie.util.LazyValue<Object>(()->{if(recursion[0]++==0){if(reentrant[0].get()!=inner)throw new AssertionError("inner");return outer;}return inner;});if(reentrant[0].get()!=inner||reentrant[0].get()!=inner||recursion[0]!=2)throw new AssertionError("original inner witness lost");
  report("{\"pass\":true,\"primitiveChecks\":5,\"contendedExchanges\":800,\"originalLazyCases\":5,\"ownedThreadsJoined\":4}");
 }catch(Throwable failure){failure.printStackTrace();report("{\"pass\":false,\"stage\":\""+stage+"\",\"error\":\""+failure.toString().replace("\"","'")+"\"}");}}
 public static Object exchange(VarHandle handle,Object receiver,Object expected,Object update){while(true){Object witness=handle.getVolatile(receiver);if(witness!=expected)return witness;if(handle.compareAndSet(receiver,expected,update))return expected;}}
}
