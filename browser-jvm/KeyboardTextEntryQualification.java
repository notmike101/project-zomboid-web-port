import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import zombie.ui.UITextBox2;
import zombie.ui.UIFont;
import zombie.input.GameKeyboard;
import zombie.core.Core;
public final class KeyboardTextEntryQualification {
    static native void ready(int phase);
    static native void report(String json);
    static void frame() {
        GameKeyboard.poll();
        GameKeyboard.update();
        Core.getInstance().DoFrameReady();
    }
    static void check(boolean value,String label) {
        if(!value)throw new AssertionError(label);
    }
    public static void main(String[]args) {
        String stage="fonts";
        UITextBox2 box=null;
        Throwable failure=null;
        boolean stopped=false;
        try {
            port.host.BrowserFontBootstrap.mountAssets();
            Path close=Path.of("/files/work/media/ui/inventoryPanes/Button_Close.png");
            Files.createDirectories(close.getParent());
            Files.copy(Path.of("/app/Button_Close.png"),close);
            zombie.ZomboidFileSystem.instance.init();
            port.host.BrowserFontBootstrap.initialize();
            report("{\"progress\":\"original-fonts-ready\"}");
            org.lwjglx.input.Keyboard.create();
            stage="original-textbox-construction";
            box=new UITextBox2(UIFont.Small,0,0,400,40,"",false);
            box.setEditable(true);
            box.focus();
            check(Core.getInstance().isDoingTextEntry(),"Original text entry focus");
            frame();
            frame();
            String[]expected= {
                "Ab","Ab\u00e9\u03a9\u4e2d","Ab\u00e9\u4e2d","b\u00e9\u4e2d","b\u00e9\u4e2dZ","b\u00e9\u4e2dZ","b\u00e9\u4e2dZ","Rename","Renam"
            };
            for(int phase=0;phase<expected.length;phase++) {
                stage="phase"+phase;
                ready(phase);
                port.host.BrowserKeyboardEvents.poll();
                frame();
                check(box.getInternalText().equals(expected[phase]),"Original textbox text phase"+phase);
                report("{\"phase\":"+phase+",\"text\":\""+box.getInternalText()+"\",\"originalFocused\":"+box.isFocused()+"}");
            }
            stage="original-unfocus";
            box.unfocus();
            check(Core.currentTextEntryBox==null&&!box.isFocused(),"Original unfocus releases Core owner");
            report("{\"progress\":\"original-unfocus-clean\"}");
        }
        catch(Throwable e) {
            failure=e;
            report("{\"failureStage\":\""+stage+"\",\"exceptionClass\":\""+e.getClass().getName()+"\",\"stack\":\""+java.util.Arrays.toString(e.getStackTrace()).replace("\\","/").replace("\"","'")+"\"}");
        }
        finally {
            try {
                if(box!=null&&box.isFocused())box.unfocus();
                port.host.BrowserFontBootstrap.close();
                var field=zombie.GameWindow.fileSystem.getClass().getDeclaredField("executor");
                field.setAccessible(true);
                var executor=(ExecutorService)field.get(zombie.GameWindow.fileSystem);
                executor.shutdown();
                stopped=executor.awaitTermination(5,TimeUnit.SECONDS);
                check(stopped,"Asset executor stop");
            }
            catch(Throwable e) {
                if(failure==null)failure=e;
            }
        }
        report("{\"pass\":"+(failure==null)+",\"assetExecutorShutdown\":"+stopped+",\"sourceOriginalTextbox\":true,\"cacheInjected\":false}");
    }
}
