import java.nio.file.*;import java.util.*;
public class PathQualification {
 static String call(java.util.function.Supplier<Path> f){try{return "result:"+f.get();}catch(Throwable e){return "error:"+e.getClass().getName();}}
 public static void main(String[]args){Path base=Path.of("base");Object[][] cases={{base,"a",new String[]{"b","c"}},{base,"",new String[0]},{base,"a",new String[]{"/absolute","tail"}},{null,"a",new String[0]},{base,null,new String[0]},{base,"a",null},{base,"a",new String[]{null}},{base,"/absolute",new String[]{"tail"}}};for(var c:cases){Path p=(Path)c[0];String first=(String)c[1];String[] more=(String[])c[2];String expected=call(()->p.resolve(first,more)),actual=call(()->port.host.PathCompat.resolve(p,first,more));if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);}System.out.println("PathCompat PASS8 originalSDK25contractcases");}
}
