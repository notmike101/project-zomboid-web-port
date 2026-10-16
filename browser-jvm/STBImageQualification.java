import java.nio.*;import java.io.*;import java.util.zip.*;import org.lwjgl.stb.STBImage;
/** Portable browser qualification using an authored 2x2 PNG; no installed assets are embedded. */
public final class STBImageQualification {
 public static native void report(String json);
 static final int[] pixels={255,0,0,255,0,255,0,128,0,0,255,64,255,255,255,0};
 public static void main(String[] args){try{int checks=0;byte[] encoded=png();int[] x={-1},y={-1},c={-1};
  for(boolean flip:new boolean[]{false,true})for(int channels=0;channels<=4;channels++){
   STBImage.stbi_set_flip_vertically_on_load(flip);ByteBuffer source=ByteBuffer.allocateDirect(encoded.length+3);source.position(3);source.put(encoded).flip().position(3);
   ByteBuffer image=STBImage.stbi_load(source,x,y,c,channels);if(image==null)throw new AssertionError(STBImage.stbi_failure_reason());int out=channels==0?4:channels;
   if(x[0]!=2||y[0]!=2||c[0]!=4||image.position()!=0||image.remaining()!=4*out||source.position()!=3)throw new AssertionError("dimensions/positions");
   for(int row=0;row<2;row++)for(int col=0;col<2;col++){int at=((flip?1-row:row)*2+col)*4,dst=(row*2+col)*out;int r=pixels[at],g=pixels[at+1],b=pixels[at+2],a=pixels[at+3];int[] expected=out==1?new int[]{(77*r+150*g+29*b)>>8}:out==2?new int[]{(77*r+150*g+29*b)>>8,a}:out==3?new int[]{r,g,b}:new int[]{r,g,b,a};for(int i=0;i<out;i++)if((image.get(dst+i)&255)!=expected[i])throw new AssertionError("RGBA/channel/flip mismatch");}
   STBImage.stbi_image_free(image);try{STBImage.stbi_image_free(image);throw new AssertionError("doublefree");}catch(IllegalArgumentException expected){}checks++;
  }
  STBImage.stbi_set_flip_vertically_on_load(false);IntBuffer ix=IntBuffer.allocate(2);ix.position(1);ByteBuffer image=STBImage.stbi_load(ByteBuffer.wrap(encoded),ix,(IntBuffer)null,(IntBuffer)null,4);if(ix.position()!=1||ix.get(1)!=2)throw new AssertionError("IntBufferposition");STBImage.stbi_image_free(image);checks++;
  if(STBImage.stbi_load(ByteBuffer.wrap(new byte[]{1,2,3}),x,y,c,4)!=null||STBImage.stbi_failure_reason()==null)throw new AssertionError("invalidPNGfailure");checks++;
  STBImage.stbi_image_free((ByteBuffer)null);report("{\"pass\":true,\"checks\":"+checks+"}");
 }catch(Throwable e){e.printStackTrace();report("{\"pass\":false,\"error\":"+quote(e.toString())+"}");}}
 private static String quote(String value) {
  StringBuilder result = new StringBuilder("\"");
  for (int i = 0; i < value.length(); i++) {
   char ch = value.charAt(i);
   if (ch == '"' || ch == '\\') result.append('\\').append(ch);
   else if (ch < 32) result.append(String.format("\\u%04x", (int) ch));
   else result.append(ch);
  }
  return result.append('"').toString();
 }
 static byte[] png()throws Exception{var bytes=new ByteArrayOutputStream();var out=new DataOutputStream(bytes);out.writeLong(0x89504e470d0a1a0aL);var h=new ByteArrayOutputStream();var hd=new DataOutputStream(h);hd.writeInt(2);hd.writeInt(2);hd.write(new byte[]{8,6,0,0,0});chunk(out,"IHDR",h.toByteArray());var compressed=new ByteArrayOutputStream();try(var z=new DeflaterOutputStream(compressed)){for(int row=0;row<2;row++){z.write(0);for(int i=row*8;i<row*8+8;i++)z.write(pixels[i]);}}chunk(out,"IDAT",compressed.toByteArray());chunk(out,"IEND",new byte[0]);return bytes.toByteArray();}
 static void chunk(DataOutputStream o,String type,byte[] b)throws Exception{byte[] name=type.getBytes("US-ASCII");o.writeInt(b.length);o.write(name);o.write(b);CRC32 crc=new CRC32();crc.update(name);crc.update(b);o.writeInt((int)crc.getValue());}
}
