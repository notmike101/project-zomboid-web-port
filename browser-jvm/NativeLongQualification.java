public final class NativeLongQualification {
 public static native long sync(int index);
 public static native long async(int index);
 public static native int integer();
 public static native double floating();
 public static native String text();
 public static native Object object();
 public static native long[] array();
 public static native void fail();
 public static native void report(String json);
 public static String input(long value){return Long.toString(value);}
 public static void main(String[]args){
  try{
   long[] expected={0L,1L,-1L,Long.MIN_VALUE,Long.MAX_VALUE,9007199254740991L,9007199254740992L,9007199254740993L,-9007199254740993L,0L,Long.MIN_VALUE,-1L,1L};
   StringBuilder values=new StringBuilder("[");
   for(int i=0;i<expected.length;i++){
    long a=sync(i),b=async(i),want=expected[i];
    if(a!=want||b!=want||a>>1!=want>>1||(a^0x123456789abcdef0L)!=(want^0x123456789abcdef0L))throw new AssertionError("Exact native long differs at "+i);
    if(i>0)values.append(',');values.append('"').append(a).append('"');
   }
   if(integer()!=123456789||floating()!=-0.125||!"Unicode Ω 😃".equals(text())||object()==null)throw new AssertionError("Delegated primitive/object differs");
   long[] array=array();if(!java.util.Arrays.equals(array,expected))throw new AssertionError("Delegated long array differs");
   boolean caught=false,finished=false;
   try{fail();}catch(IllegalStateException e){caught="native-fixture".equals(e.getMessage());}finally{finished=true;}
   if(!caught||!finished)throw new AssertionError("Native exception cleanup differs");
   report("{\"pass\":true,\"nativeLongReturns\":26,\"delegatedTypes\":5,\"javaExceptionCaught\":true,\"finallyExecuted\":true,\"values\":"+values.append(']')+"}");
  }catch(Throwable e){e.printStackTrace();report("{\"pass\":false,\"error\":\""+e.toString().replace("\\","\\\\").replace("\"","\\\"")+"\"}");}
 }
}
