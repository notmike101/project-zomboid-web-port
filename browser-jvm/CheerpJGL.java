package probe;
import java.nio.*;
import org.lwjgl.opengl.GL11C;
import org.lwjgl.opengl.GL20C;
import zombie.core.Color;
import org.lwjgl.util.vector.Vector4f;
public class CheerpJGL {
 public static native void report(String json);
 public static native void read(int x,int y,int w,int h,int format,int type,byte[] bytes);
 public static void readBuffer(int x,int y,int w,int h,int format,int type,ByteBuffer buffer) {
  if(buffer==null)throw new NullPointerException("pixels");
  if(!buffer.isDirect())throw new IllegalArgumentException("direct buffer required");
  if(buffer.isReadOnly())throw new ReadOnlyBufferException();
  if(format!=6408||type!=5121)throw new UnsupportedOperationException("Only RGBA UNSIGNED_BYTE qualified");
  int length=Math.multiplyExact(Math.multiplyExact(w,h),4);
  if(buffer.remaining()<length)throw new IllegalArgumentException("pixels too short");
  byte[] bytes=new byte[length];read(x,y,w,h,format,type,bytes);
  int offset=buffer.position();for(int i=0;i<length;i++)buffer.put(offset+i,bytes[i]);
 }
 public static native void shaderText(int shader,String source);
 public static native int locationText(int program,String name);
 public static native void textureBytes(int target,int level,int internal,int w,int h,int border,int format,int type,byte[] bytes);
 public static void shaderSource(int shader,CharSequence source){shaderText(shader,source.toString());}
 public static int uniformLocation(int program,CharSequence name){return locationText(program,name.toString());}
 public static void textureBuffer(int target,int level,int internal,int w,int h,int border,int format,int type,ByteBuffer buffer){
  if(!buffer.isDirect())throw new IllegalArgumentException("direct texture buffer required");
  int count=Math.multiplyExact(Math.multiplyExact(w,h),4);if(buffer.remaining()<count)throw new IllegalArgumentException("texture buffer too short");
  byte[] bytes=new byte[count];for(int i=0;i<count;i++)bytes[i]=buffer.get(buffer.position()+i);textureBytes(target,level,internal,w,h,border,format,type,bytes);
 }
 public static int shader(int type,String source){int s=GL20C.glCreateShader(type);GL20C.glShaderSource(s,source);GL20C.glCompileShader(s);if(GL20C.glGetShaderi(s,35713)!=1)throw new AssertionError(GL20C.glGetShaderInfoLog(s,4096));return s;}
 public static native void resize(int width,int height);
 public static native void validatePng(byte[] pixels,int width,int height);
 public static int pngPixelHash;
 public static void pngTexture() throws Exception {
  int width,height;ByteBuffer data;
  try(java.io.FileInputStream input=new java.io.FileInputStream("/app/menu.png")){
   zombie.core.textures.PNGDecoder decoder=new zombie.core.textures.PNGDecoder(input,false);width=decoder.getWidth();height=decoder.getHeight();
   if(width!=96||height!=96)throw new AssertionError("asset dimensions");data=ByteBuffer.allocateDirect(width*height*4);decoder.decode(data,width*4,height,zombie.core.textures.PNGDecoder.Format.RGBA,zombie.core.textures.PNGDecoder.IDAT);
  }
  if(data.position()!=data.capacity())throw new AssertionError("decode incomplete");data.flip();byte[] decoded=new byte[data.remaining()];for(int i=0;i<decoded.length;i++)decoded[i]=data.get(i);validatePng(decoded,width,height);
  resize(width,height);GL11C.glViewport(0,0,width,height);GL11C.glTexImage2D(3553,0,6408,width,height,0,6408,5121,data);if(data.position()!=0)throw new AssertionError("PNG upload consumed buffer");GL11C.glDrawArrays(4,0,3);
  ByteBuffer readback=ByteBuffer.allocateDirect(decoded.length);GL11C.glReadPixels(0,0,width,height,6408,5121,readback);for(int i=0;i<decoded.length;i++)if(decoded[i]!=readback.get(i))throw new AssertionError("PNG GPU byte "+i);
  if(readback.position()!=0)throw new AssertionError("PNG read position");pngPixelHash=java.util.Arrays.hashCode(decoded);
 }

 public static void shaderTexture() throws Exception {
  int vs=0,fs=0,bad=0,badProgram=0,program=0,texture=0;
  try{
   vs=shader(35633,"#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}");
   fs=shader(35632,"#version 300 es\nprecision highp float;uniform vec4 color;uniform sampler2D image;out vec4 pixel;void main(){pixel=texelFetch(image,ivec2(gl_FragCoord.xy),0)*color;}");
   program=GL20C.glCreateProgram();GL20C.glAttachShader(program,vs);GL20C.glAttachShader(program,fs);GL20C.glLinkProgram(program);if(GL20C.glGetProgrami(program,35714)!=1)throw new AssertionError(GL20C.glGetProgramInfoLog(program,4096));GL20C.glUseProgram(program);
   Color color=new Color(1f,1f,1f,1f);color.scale(1);Vector4f vector=new Vector4f(color.r,color.g,color.b,color.a);GL20C.glUniform4f(GL20C.glGetUniformLocation(program,"color"),vector.x,vector.y,vector.z,vector.w);
   texture=GL11C.glGenTextures();GL11C.glBindTexture(3553,texture);GL11C.glTexParameteri(3553,10241,9728);GL11C.glTexParameteri(3553,10240,9728);
   ByteBuffer input=ByteBuffer.allocateDirect(24);input.position(4);input.limit(20);for(int i=0;i<4;i++){input.put(4+i*4,(byte)((i&1)==0?255:0));input.put(5+i*4,(byte)((i&2)==0?255:0));input.put(6+i*4,(byte)255);input.put(7+i*4,(byte)255);}
   GL11C.glTexImage2D(3553,0,6408,2,2,0,6408,5121,input);if(input.position()!=4||input.limit()!=20)throw new AssertionError("texture buffer state");
   GL11C.glClearColor(0,0,0,0);GL11C.glClear(16384);GL11C.glDrawArrays(4,0,3);
   ByteBuffer output=ByteBuffer.allocateDirect(16);GL11C.glReadPixels(0,0,2,2,6408,5121,output);for(int i=0;i<16;i++)if(output.get(i)!=input.get(i+4))throw new AssertionError("shader texture pixel "+i+" "+(output.get(i)&255));
   badProgram=GL20C.glCreateProgram();GL20C.glLinkProgram(badProgram);if(GL20C.glGetProgrami(badProgram,35714)!=0||GL20C.glGetProgramInfoLog(badProgram,4096).isEmpty())throw new AssertionError("link failure missing");
   pngTexture();
   bad=GL20C.glCreateShader(35632);GL20C.glShaderSource(bad,"#version 300 es\nthis is invalid");GL20C.glCompileShader(bad);if(GL20C.glGetShaderi(bad,35713)!=0||GL20C.glGetShaderInfoLog(bad,4096).isEmpty())throw new AssertionError("shader failure missing");
  }finally{GL20C.glUseProgram(0);if(texture!=0)GL11C.glDeleteTextures(texture);if(bad!=0)GL20C.glDeleteShader(bad);if(vs!=0)GL20C.glDeleteShader(vs);if(fs!=0)GL20C.glDeleteShader(fs);if(program!=0)GL20C.glDeleteProgram(program);if(badProgram!=0)GL20C.glDeleteProgram(badProgram);}
 }

 public static void main(String[] args) {
  try {
   ByteBuffer pixels=ByteBuffer.allocateDirect(24);for(int i=0;i<24;i++)pixels.put(i,(byte)77);pixels.position(4);pixels.limit(20);
   GL11C.glClearColor(1,0,1,1);GL11C.glClear(16384);
   GL11C.glReadPixels(0,0,2,2,6408,5121,pixels);
   for(int i=0;i<4;i++){int p=4+i*4;if((pixels.get(p)&255)!=255||(pixels.get(p+1)&255)!=0||(pixels.get(p+2)&255)!=255||(pixels.get(p+3)&255)!=255)throw new AssertionError("pixel "+i+" "+(pixels.get(p)&255)+","+(pixels.get(p+1)&255)+","+(pixels.get(p+2)&255)+","+(pixels.get(p+3)&255));}
   if(pixels.position()!=4||pixels.limit()!=20||pixels.get(0)!=77||pixels.get(3)!=77)throw new AssertionError("buffer state");
   pixels.limit(24);if(pixels.get(20)!=77||pixels.get(23)!=77)throw new AssertionError("tail sentinel");
   boolean shortRejected=false;try{GL11C.glReadPixels(0,0,2,2,6408,5121,ByteBuffer.allocateDirect(3));}catch(IllegalArgumentException e){shortRejected=true;}
   if(!shortRejected)throw new AssertionError("short buffer accepted");
   boolean unsupportedRejected=false;try{GL11C.glFinish();}catch(UnsatisfiedLinkError e){unsupportedRejected=true;}
   if(!unsupportedRejected)throw new AssertionError("unimplemented native silently succeeded");
   shaderTexture();
   report("{\"pass\":true,\"originalPngGpuBytes\":36864,\"independentBrowserDecode\":true,\"shaderTexturePixels\":4,\"originalColorVector4\":true,\"shaderFailureReported\":true,\"linkFailureReported\":true,\"pixels\":4,\"rgba\":[255,0,255,255],\"bufferStateAndSentinels\":true,\"shortBufferRejected\":true,\"unimplementedNativeRejected\":true}");
  }catch(Throwable t){t.printStackTrace();report("{\"pass\":false,\"error\":\""+t.toString().replace("\\","\\\\").replace("\"","\\\"")+"\"}");}
 }
}









