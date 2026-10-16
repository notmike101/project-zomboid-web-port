package probe;
public final class CheerpJInput {
 public static native void report(String result);
 static void awaitKey(boolean expected)throws Exception{long end=System.currentTimeMillis()+15000;while(org.lwjglx.input.Keyboard.isKeyDown(17)!=expected){if(System.currentTimeMillis()>end)throw new AssertionError("DOM W transition timed out");Thread.sleep(10);}}
 public static void main(String[]args){try{
 if(!org.lwjglx.input.Keyboard.isCreated()||org.lwjglx.input.Keyboard.isKeyDown(17))throw new AssertionError("initial keyboard state");
 report("{\"phase\":\"press\"}");awaitKey(true);
 report("{\"phase\":\"release\"}");awaitKey(false);
 report("{\"phase\":\"focus-press\"}");awaitKey(true);
 report("{\"phase\":\"blur\"}");awaitKey(false);
 report("{\"pass\":true,\"originalKeyTranslation\":true,\"pressRelease\":true,\"focusLoss\":true}");
 }catch(Throwable error){error.printStackTrace();report("{\"pass\":false,\"error\":\""+error.toString().replace("\"","'")+"\"}");}}
}
