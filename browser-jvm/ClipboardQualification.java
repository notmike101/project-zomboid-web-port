import java.awt.datatransfer.*;
import java.io.IOException;
import org.lwjgl.glfw.GLFW;
import port.host.BrowserClipboard;

/** Data-only original consumer proof against a genuine JDK Clipboard owner; no system clipboard access. */
public final class ClipboardQualification {
    private static int checks;
    private static native void report(String json);
    private static void check(boolean value,String why){if(!value)throw new AssertionError(why);checks++;}
    private static java.awt.datatransfer.Clipboard app(){return BrowserClipboard.owner();}
    private static String platform()throws Exception{return (String)app().getData(DataFlavor.stringFlavor);}
    private static Object field(String name)throws Exception{var f=zombie.core.Clipboard.class.getDeclaredField(name);f.setAccessible(true);return f.get(null);}
    private static void unsupported(Runnable work){boolean caught=false,finished=false;try{work.run();}catch(UnsupportedOperationException expected){caught=true;}finally{finished=true;}check(caught&&finished,"Unsupported native pointer is a genuine Java exception/finally");}
    public static void main(String[]args)throws Exception{
        app().setContents(new StringSelection("owned-initial"),null);
        check(app()==app()&&app().getName().equals("Project Zomboid browser"),"Real named JDK application-local clipboard owner identity");
        zombie.core.Clipboard.initMainThread();
        check(field("mainThread")==Thread.currentThread(),"Original thread owner assigned by original init");
        check("owned-initial".equals(field("previousKnownValue")),"Original init actually reads AWT backing");
        check(BrowserClipboard.reads()==1&&BrowserClipboard.errorCallbackCalls()==2,"Actual selected platform calls, clear/restore original finally");
        check("jdk-app-local-clipboard".equals(GLFW.getLibrary().getName())&&GLFW.getLibrary().getPath()==null,"Truthful browser provider descriptor, no shared file claim");
        unsupported(()->GLFW.getLibrary().address());
        unsupported(()->GLFW.getLibrary().getFunctionAddress("glfwInit"));
        check(GLFW.glfwSetErrorCallback(null)==null,"Actual initial error callback is absent, no callback pointer");
        String text="unicode-\u00e9\u03a9\u4e2d-\ud83c\udfae";
        zombie.core.Clipboard.setClipboard(text);
        check(platform().equals(text),"Original set writes actual AWT StringSelection");
        check(zombie.core.Clipboard.getClipboard().equals(text),"Actual original get reads platform Unicode");
        zombie.core.Clipboard.setClipboard("");
        check(platform().isEmpty()&&zombie.core.Clipboard.getClipboard().isEmpty(),"Actual empty-string roundtrip");
        zombie.core.Clipboard.setClipboard("prefix\0not-copied");
        check(platform().equals("prefix")&&zombie.core.Clipboard.getClipboard().equals("prefix"),"Original GLFW NUL-terminated write contract");
        app().setContents(new StringSelection("read-prefix\0not-returned"),null);
        check(zombie.core.Clipboard.getClipboard().equals("read-prefix"),"Original GLFW NUL-terminated read contract");
        app().setContents(new StringSelection("remembered"),null);
        zombie.core.Clipboard.rememberCurrentValue();
        check("remembered".equals(field("previousKnownValue")),"Original remember reads actual AWT clipboard");
        app().setContents(new StringSelection("external-app-local"),null);
        String[] observed={null};Throwable[] error={null};
        int writes=BrowserClipboard.writes();
        Thread worker=new Thread(()->{try{observed[0]=zombie.core.Clipboard.getClipboard();zombie.core.Clipboard.setClipboard("deferred-owner-write");}catch(Throwable problem){error[0]=problem;}},"owned-clipboard-worker");
        worker.start();worker.join(2000);
        check(!worker.isAlive()&&error[0]==null,"Real bounded secondary Java thread completed");
        check("remembered".equals(observed[0]),"Original non-owner get uses original cache");
        check(platform().equals("external-app-local")&&BrowserClipboard.writes()==writes,"Original cross-thread setter defers platform write");
        check("deferred-owner-write".equals(field("delaySetMainThread")),"Original pending field owns deferred text");
        zombie.core.Clipboard.updateMainThread();
        check(platform().equals("deferred-owner-write")&&field("delaySetMainThread")==null,"Original owner update publishes and clears pending write");
        check(BrowserClipboard.writes()==writes+1,"One real AWT publication");
        app().setContents(new Transferable(){
            public DataFlavor[] getTransferDataFlavors(){return new DataFlavor[0];}
            public boolean isDataFlavorSupported(DataFlavor flavor){return false;}
            public Object getTransferData(DataFlavor flavor)throws UnsupportedFlavorException{throw new UnsupportedFlavorException(flavor);}
        },null);
        int callbacks=BrowserClipboard.errorCallbackCalls();
        check(zombie.core.Clipboard.getClipboard().isEmpty(),"Actual no-text data causes original String(null)/catch empty fallback");
        check(BrowserClipboard.errorCallbackCalls()==callbacks+2,"Original no-text error callback finally restoration");
        app().setContents(new Transferable(){
            public DataFlavor[] getTransferDataFlavors(){return new DataFlavor[]{DataFlavor.stringFlavor};}
            public boolean isDataFlavorSupported(DataFlavor flavor){return flavor.equals(DataFlavor.stringFlavor);}
            public Object getTransferData(DataFlavor flavor)throws IOException{throw new IOException("Owned clipboard source failure");}
        },null);
        callbacks=BrowserClipboard.errorCallbackCalls();
        check(zombie.core.Clipboard.getClipboard().isEmpty(),"Real Transferable IOException follows original read catch");
        check(BrowserClipboard.errorCallbackCalls()==callbacks+2,"Original IOException finally restores absent callback");
        app().setContents(new StringSelection("jdk-owner-after-adapter-close"),null);
        GLFW.getLibrary().free();
        boolean caught=false,finished=false;
        try{zombie.core.Clipboard.getClipboard();}catch(IllegalStateException expected){caught=true;}finally{finished=true;}
        check(caught&&finished,"Closed error callback prelude lies outside original read catch");
        check(platform().equals("jdk-owner-after-adapter-close"),"Closing adapter does not destroy JDK-owned application clipboard");
        report("{\"pass\":true,\"checks\":"+checks+",\"appLocal\":true,\"originalClipboardMethodsUnchanged\":true,\"reads\":"+BrowserClipboard.reads()+",\"writes\":"+BrowserClipboard.writes()+",\"callbacks\":"+BrowserClipboard.errorCallbackCalls()+",\"workerStopped\":"+!worker.isAlive()+"}");
    }
}
