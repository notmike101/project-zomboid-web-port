import java.util.*;
import java.lang.reflect.*;
public final class ListFirstQualification {
 public static native void report(String json);
 static boolean baseline;
 static Object first(List<?> list)throws Throwable {if(!baseline)return port.host.ListFirstSupport.getFirst(list);try{return List.class.getMethod("getFirst").invoke(list);}catch(InvocationTargetException e){throw e.getCause();}}
 static void check(boolean condition){if(!condition)throw new AssertionError();}
 static void expect(Class<?> type,List<?> list)throws Throwable{try{first(list);throw new AssertionError("Expected "+type);}catch(Throwable e){if(!type.isInstance(e))throw e;}}
 public static void main(String[] args){baseline=args.length>0&&args[0].equals("--jvm");try{
  Object head=new Object(),tail=new Object();var list=new ArrayList<>(List.of(head,tail));check(first(list)==head);
  var nullable=new ArrayList<Object>();nullable.add(null);nullable.add(tail);check(first(nullable)==null);
  expect(NoSuchElementException.class,new ArrayList<>());expect(NullPointerException.class,null);
  check(first(list)==head&&list.size()==2&&list.get(1)==tail);list.set(0,tail);check(first(list)==tail&&list.size()==2);
  for(List<?> unsupported:List.of(new LinkedList<>(),new ArrayList<Object>(){})){try{port.host.ListFirstSupport.getFirst(unsupported);throw new AssertionError("Unqualified receiver accepted");}catch(UnsupportedOperationException expected){}}
  String result="{\"pass\":true,\"checks\":8,\"exactArrayListOnly\":true}";if(baseline)System.out.println(result);else report(result);
 }catch(Throwable e){e.printStackTrace();if(baseline)throw new AssertionError(e);else report("{\"pass\":false}");}}
}
