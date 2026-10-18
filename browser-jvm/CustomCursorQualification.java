import java.lang.reflect.Field;
import java.nio.*;
import java.nio.file.*;
import java.util.Map;
import org.lwjglx.input.Cursor;
import org.lwjglx.input.Mouse;
import org.lwjglx.opengl.Display;
import port.host.BrowserCustomCursor;
import port.host.BrowserDisplayEvents;
import zombie.core.Core;

/** Actual original game cursor startup, retaining NativeImage finally and vendor pixel conversion. */
public final class CustomCursorQualification {
    private static int checks;
    public static native void report(String value);
    public static native boolean observe(int phase);
    public static native boolean pixels(int index,byte[] originalDecoded);
    private static void check(boolean value,String why){if(!value)throw new AssertionError(why);checks++;}
    private static Object field(Class<?> type,String name)throws Exception{Field value=type.getDeclaredField(name);value.setAccessible(true);return value.get(null);}
    private static void rejected(Runnable work,Class<? extends Throwable> expected,String why){
        boolean caught=false,cleaned=false;
        try{work.run();}catch(Throwable failure){if(!expected.isInstance(failure))throw failure;caught=true;}
        finally{cleaned=true;}
        check(caught&&cleaned,why);
    }
    public static void main(String[] args)throws Exception{
        IntBuffer input=IntBuffer.wrap(new int[]{0xff0102ff,0xffffffff,0xff7f80fe,0xffa1b2c3}).asReadOnlyBuffer();
        IntBuffer flipped=IntBuffer.allocate(4);
        var flip=Cursor.class.getDeclaredMethod("flipImages",int.class,int.class,int.class,IntBuffer.class,IntBuffer.class);flip.setAccessible(true);
        flip.invoke(null,2,2,1,input,flipped);
        var convert=Cursor.class.getDeclaredMethod("convertARGBIntBuffertoRGBAByteBuffer",int.class,int.class,IntBuffer.class);convert.setAccessible(true);
        ByteBuffer pixels=(ByteBuffer)convert.invoke(null,2,2,flipped);
        byte[] actual=new byte[pixels.remaining()];pixels.get(actual);
        byte[] expected={(byte)254,(byte)128,127,(byte)255,(byte)195,(byte)178,(byte)161,(byte)255,(byte)255,2,1,(byte)255,(byte)255,(byte)255,(byte)255,(byte)255};
        if(!java.util.Arrays.equals(actual,expected)||input.position()!=0||input.limit()!=4)throw new AssertionError("Original vendor conversion or source range differs");
        System.out.println("PASS original vendor readonly2x2 flip+RGBA16bytes "+java.util.HexFormat.of().formatHex(actual));
    }
    public static void run(Path root) throws Exception {
        check(root.getParent().equals(Path.of("/files/display-events")), "Owned cursor root");
        try {
            for (String name : new String[]{"media/ui/cursor_blank.png", "media/ui/cursor_white.png", "media/fileGuidTable.xml"}) {
                Files.createDirectories(root.resolve(name).getParent());
                Files.copy(Path.of("/app", name), root.resolve(name));
            }
            zombie.ZomboidFileSystem.instance.init();
            Cursor blank, white;
            check(!Core.getInstance().isNoSave() && !Core.getInstance().getOptionLockCursorToWindow(), "Untouched save/unlocked policy");
            zombie.input.Mouse.initCustomCursor();
            blank=(Cursor)field(zombie.input.Mouse.class,"blankCursor");white=(Cursor)field(zombie.input.Mouse.class,"defaultCursor");
            check(blank!=null&&white!=null&&blank!=white,"Original distinct blank/default cursor cache");
            check(BrowserCustomCursor.ownedImages()==2,"Actual image owners created");
            check(((Map<?,?>)field(org.lwjgl.stb.STBImage.class,"images")).isEmpty(),"Original NativeImage finally freed STB images");
            for(int index=0;index<2;index++){
                Path image=root.resolve(index==0?"media/ui/cursor_blank.png":"media/ui/cursor_white.png");
                try(var stream=Files.newInputStream(image)){
                    var decoder=new zombie.core.textures.PNGDecoder(stream,false);
                    var bytes=ByteBuffer.allocate(32*32*4);
                    decoder.decode(bytes,32*4,32,zombie.core.textures.PNGDecoder.Format.RGBA,zombie.core.textures.PNGDecoder.IDAT);
                    check(pixels(index,bytes.array()),"Original decoded PNG equals vendor-produced cursor RGBA");
                }
            }
            check(observe(1),"Actual decoded white image URL/hotspot selected");
            Display.processMessages();check(observe(1),"Original normal-mode pump preserves selected custom cursor");
            zombie.input.Mouse.initCustomCursor();
            check(blank==field(zombie.input.Mouse.class,"blankCursor")&&white==field(zombie.input.Mouse.class,"defaultCursor")&&BrowserCustomCursor.ownedImages()==2,"Original init guard preserves owners");
            check(Mouse.setNativeCursor(blank)==null,"Original null previous-cursor return");
            check(observe(2),"Actual transparent original image selected");
            BrowserDisplayEvents.setInputMode(0,208897,212994);check(observe(3),"Actual hidden cursor mode");
            Mouse.setNativeCursor(white);check(observe(3),"Selection while hidden does not reveal cursor");
            BrowserDisplayEvents.setInputMode(0,208897,212993);check(observe(1),"Normal mode restores actual selected white image");
            Cursor selected=white;
            rejected(selected::getHandle,UnsupportedOperationException.class,"No fake native pointer; real Java UOE/finally");
            rejected(()->{try{Mouse.setNativeCursor(null);}catch(org.lwjglx.LWJGLException error){throw new RuntimeException(error);}},NullPointerException.class,"Original null-input dereference contract");
            rejected(()->BrowserCustomCursor.create(selected,32,32,32,1,ByteBuffer.allocate(4096)),IllegalArgumentException.class,"Hotspot bounds reject without new resource");
            rejected(()->BrowserCustomCursor.create(selected,32,32,1,1,ByteBuffer.allocate(2)),IllegalArgumentException.class,"RGBA range reject without new resource");
            check(BrowserCustomCursor.ownedImages()==2&&observe(1),"Rejected operations preserve selected owner");
            white.destroy();check(observe(4),"Destroy selected image restores actual default fallback");
            rejected(()->BrowserCustomCursor.select(selected),IllegalStateException.class,"Destroyed image cannot be selected");
            blank.destroy();check(BrowserCustomCursor.ownedImages()==0&&observe(5),"Both actual URLs released");
            IntBuffer coloredSource=IntBuffer.wrap(new int[]{0xff0102ff,0xffffffff,0xff7f80fe,0xffa1b2c3}).asReadOnlyBuffer();
            Cursor colored=new Cursor(2,2,0,0,1,coloredSource,null);
            check(coloredSource.position()==0&&coloredSource.limit()==4,"Original vendor conversion preserves read-only source range");
            check(pixels(2,new byte[]{(byte)254,(byte)128,127,(byte)255,(byte)195,(byte)178,(byte)161,(byte)255,(byte)255,2,1,(byte)255,(byte)255,(byte)255,(byte)255,(byte)255}),"Nontrivial opaque vendor RGBA survives real browser PNG encode/decode");
            check(Mouse.setNativeCursor(colored)==null&&observe(6),"Actual nontrivial image CSS cursor/hotspot");
            colored.destroy();check(observe(7),"Nontrivial image URL destruction");
            BrowserCustomCursor.dispose();
            check(org.lwjgl.opengl.GL11.glGetError()==0,"Actual graphics state unchanged");
            report("{\"pass\":true,\"checks\":"+checks+",\"images\":"+BrowserCustomCursor.ownedImages()+"}");
        } finally {
            if (BrowserCustomCursor.ownedImages() > 0) BrowserCustomCursor.dispose();
        }
    }
}
