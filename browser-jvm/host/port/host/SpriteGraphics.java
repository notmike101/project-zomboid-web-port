package port.host;

import java.nio.*;
import java.util.*;
import org.lwjgl.opengl.GLCapabilities;

/** Selected LWJGL facade for actual browser graphics. No native pointer ABI. */
public final class SpriteGraphics {
    private static final IdentityHashMap<Buffer,ByteBuffer> allocations = new IdentityHashMap<>();
    private static final sun.misc.Unsafe memory = memory();
    // The qualified Java 17 runtime supports immediate direct-buffer release; fail initialization if unavailable.
    private static sun.misc.Unsafe memory() {
        try {
            var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
            field.setAccessible(true);
            return (sun.misc.Unsafe) field.get(null);
        } catch (ReflectiveOperationException failure) {
            throw new ExceptionInInitializerError(failure);
        }
    }
    private static GLCapabilities capabilities;
    private static Thread contextOwner;
    private static boolean requestedVsync;
    private SpriteGraphics() { }
    public static native void initialize();
    public static native boolean contextCreated();
    public static native boolean framebufferSupported();
    public static native void processMessages();
    public static native boolean isActive();
    public static native boolean isVisible();
    public static native boolean isCloseRequested();
    public static native boolean wasResized();
    public static int getWidth(){return surfaceWidth();}
    public static int getHeight(){return surfaceHeight();}
    public static native int getX();
    public static native int getY();
    public static native void report(String json);
    public static native void resize(int width,int height);
    public static native int surfaceWidth();
    public static native int surfaceHeight();
    public static GLCapabilities getCapabilities() {
        initialize();
        if(capabilities==null)capabilities=newDescriptor();
        return capabilities;
    }
    /** Authored intrinsic emits the vendor descriptor constructor; no desktop discovery. */
    private static native GLCapabilities newDescriptor();
    public static boolean isCreated(){return contextCreated();}
    public static void makeCurrent(){initialize();Thread thread=Thread.currentThread();if(contextOwner!=null&&contextOwner!=thread)throw new IllegalStateException("Browser graphics context is owned by another Java thread");contextOwner=thread;}
    public static void releaseContext(){if(contextOwner!=Thread.currentThread())throw new IllegalStateException("Browser graphics context is not owned by this Java thread");contextOwner=null;}
    public static void setVSyncEnabled(boolean enabled){initialize();requestedVsync=enabled;}
    public static boolean requestedVsync(){return requestedVsync;}
    public static native void present(boolean vsync);

    public static ByteBuffer memAlloc(int bytes) {
        if (bytes < 0) throw new IllegalArgumentException("Negative capacity");
        ByteBuffer owner = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder());
        synchronized (allocations) {
            allocations.put(owner, owner);
        }
        return owner;
    }

    public static FloatBuffer memAllocFloat(int count) {
        ByteBuffer owner = memAlloc(Math.multiplyExact(count, 4));
        FloatBuffer view = owner.asFloatBuffer();
        synchronized (allocations) {
            allocations.remove(owner);
            allocations.put(view, owner);
        }
        return view;
    }

    public static IntBuffer memAllocInt(int count) {
        ByteBuffer owner = memAlloc(Math.multiplyExact(count, 4));
        IntBuffer view = owner.asIntBuffer();
        synchronized (allocations) {
            allocations.remove(owner);
            allocations.put(view, owner);
        }
        return view;
    }
    public static void memFree(ByteBuffer value){free(value);}
    public static void memFree(FloatBuffer value){free(value);}
    public static void memFree(IntBuffer value){free(value);}
    private static void free(Buffer value) {
        if (value == null) return;
        synchronized (allocations) {
            ByteBuffer owner = allocations.get(value);
            if (owner == null) throw new IllegalArgumentException("Foreign or released browser allocation");
            memory.invokeCleaner(owner);
            allocations.remove(value);
        }
    }
    public static void memSet(ByteBuffer value,int fill){if(!value.isDirect())throw new IllegalArgumentException("Direct buffer required");if(value.isReadOnly())throw new ReadOnlyBufferException();for(int i=value.position();i<value.limit();i++)value.put(i,(byte)fill);}

    public static native int bufferCreate();
    public static native void bufferBind(int target,int id);
    public static native void bufferDelete(int id);
    public static native boolean bufferIs(int id);
    public static native void bufferDataSize(int target,int size,int usage);
    public static native void bufferDataBytes(int target,byte[] data,int usage);
    public static native void bufferUpload(int target,int offset,byte[] data);
    public static native void bufferRead(int target,int offset,byte[] data);
    public static native int bufferParameter(int target,int name);
    public static int glGenBuffers(){return SpriteBuffers.generate();}
    public static void glBindBuffer(int target,int id){SpriteBuffers.bind(target,id);}
    public static void glDeleteBuffers(int id){SpriteBuffers.delete(id);}
    public static boolean glIsBuffer(int id){return SpriteBuffers.isBuffer(id);}
    public static void glBufferData(int target,long size,int usage){SpriteBuffers.data(target,size,usage);}
    public static void glBufferData(int target,ByteBuffer data,int usage){SpriteBuffers.data(target,data,usage);}
    public static void glBufferSubData(int target,long offset,ByteBuffer data){SpriteBuffers.subData(target,offset,data);}
    public static void glGetBufferSubData(int target,long offset,ByteBuffer data){SpriteBuffers.getData(target,offset,data);}
    public static ByteBuffer glMapBuffer(int target,int access,long length,ByteBuffer previous){return SpriteBuffers.map(target,access,length,previous);}
    public static ByteBuffer glMapBuffer(int target,int access,ByteBuffer previous){return glMapBuffer(target,access,glGetBufferParameteri(target,0x8764),previous);}
    public static ByteBuffer glMapBuffer(int target,int access){return glMapBuffer(target,access,null);}
    public static ByteBuffer glMapBufferRange(int target,long offset,long length,int flags,ByteBuffer previous){return SpriteBuffers.mapRange(target,offset,length,flags,previous);}
    public static boolean glUnmapBuffer(int target){return SpriteBuffers.unmap(target);}
    public static int glGetBufferParameteri(int target,int name){return SpriteBuffers.getParameter(target,name);}
    public static void glGetBufferParameteriv(int target,int name,IntBuffer output){SpriteBuffers.getParameter(target,name,output);}
    public static native int rawError();
    public static int glGetError(){int error=SpriteBuffers.error();return error!=0?error:rawError();}
    public static native int integerState(int name);
    public static int glGetInteger(int name){if(name==0x8894)return SpriteBuffers.binding(0x8892);if(name==0x8895)return SpriteBuffers.binding(0x8893);return integerState(name);}
    private static int offset(long value){if(value<0||value>Integer.MAX_VALUE)throw new UnsupportedOperationException("Buffer offset outside browser range");return(int)value;}
    public static void glVertexAttribPointer(int index,int size,int type,boolean normalized,int stride,long address){vertexPointer(index,size,type,normalized,stride,offset(address));}
    private static native void vertexPointer(int index,int size,int type,boolean normalized,int stride,int offset);
    public static void glDrawRangeElements(int mode,int first,int last,int count,int type,long address){drawRange(mode,first,last,count,type,offset(address));}
    private static native void drawRange(int mode,int first,int last,int count,int type,int offset);
    public static void glDrawElements(int mode,int count,int type,long address){drawElements(mode,count,type,offset(address));}
    private static native void drawElements(int mode,int count,int type,int offset);
    public static native void glEnableVertexAttribArray(int index);
    public static native void glDisableVertexAttribArray(int index);
    public static native void glActiveTexture(int texture);
    public static native void glEnable(int capability);
    public static native void glDisable(int capability);
    public static native boolean glIsEnabled(int capability);
    public static native void glBlendFunc(int source,int destination);
    public static native void glBlendFuncSeparate(int srcRgb,int dstRgb,int srcAlpha,int dstAlpha);
    public static native void glBlendEquation(int mode);
    public static native void glViewport(int x,int y,int width,int height);
    public static native void glClearColor(float red,float green,float blue,float alpha);
    public static native void glClear(int mask);
    public static native void glStencilMask(int mask);
    public static native void glAlphaFunc(int function,float reference);
    public static native void glStencilFunc(int function,int reference,int mask);
    public static native void glStencilOp(int fail,int depthFail,int depthPass);
    public static native void glColorMask(boolean red,boolean green,boolean blue,boolean alpha);
    public static native void glClearDepth(double depth);
    public static native void glScissor(int x,int y,int width,int height);
    public static native void glDepthFunc(int function);
    public static native void glDepthMask(boolean enabled);
    public static native void glDrawArrays(int mode,int first,int count);

    public static native int glCreateShader(int type);
    public static void glShaderSource(int id,CharSequence source){shaderText(id,source.toString());}
    private static native void shaderText(int id,String source);
    public static native void glCompileShader(int id);
    public static native int glGetShaderi(int id,int name);
    public static native String glGetShaderInfoLog(int id,int maxLength);
    public static native void glDeleteShader(int id);
    public static native int glCreateProgram();
    public static native void glAttachShader(int program,int shader);
    public static native void glDetachShader(int program,int shader);
    public static void glBindAttribLocation(int id,int index,CharSequence name){bindAttribute(id,index,name.toString());}
    private static native void bindAttribute(int id,int index,String name);
    public static int glGetAttribLocation(int id,CharSequence name){return attributeLocation(id,name.toString());}
    private static native int attributeLocation(int id,String name);
    public static native void glLinkProgram(int id);
    public static native void glValidateProgram(int id);
    public static native int glGetProgrami(int id,int name);
    public static native String glGetProgramInfoLog(int id,int maxLength);
    public static native void glUseProgram(int id);
    public static native void glDeleteProgram(int id);
    public static int glGetUniformLocation(int id,CharSequence name){return uniformLocation(id,name.toString());}
    private static native int uniformLocation(int id,String name);
    public static native float uniformComponent(int program,int location,int component);
    private static native String activeUniformName(int id,int index);
    private static native int activeUniformProperty(int id,int index,boolean type);
    public static String glGetActiveUniform(int id,int index,int length,IntBuffer size,IntBuffer type){if(length<0)throw new IllegalArgumentException("Negative name length");String name=activeUniformName(id,index);if(size!=null)size.put(size.position(),activeUniformProperty(id,index,false));if(type!=null)type.put(type.position(),activeUniformProperty(id,index,true));return name.substring(0,Math.min(name.length(),Math.max(0,length-1)));}
    public static native void glUniform1i(int location,int value);
    public static native void glUniform1f(int location,float value);
    public static native void glUniform2f(int location,float x,float y);
    public static native void glUniform3f(int location,float x,float y,float z);
    public static native void glUniform4f(int location,float x,float y,float z,float w);
    public static void glUniformMatrix4fv(int location,boolean transpose,FloatBuffer data){matrix4(location,matrix(data,transpose,4));}
    public static void glUniformMatrix3fv(int location,boolean transpose,FloatBuffer data){matrix3(location,matrix(data,transpose,3));}
    private static native void matrix4(int location,float[] data);
    private static native void matrix3(int location,float[] data);
    private static float[] matrix(FloatBuffer data,boolean transpose,int width){int size=width*width;float[] result=new float[data.remaining()/size*size];for(int i=0;i<result.length;i++)result[i]=data.get(data.position()+i);if(transpose)for(int start=0;start<result.length;start+=size)for(int y=0;y<width;y++)for(int x=y+1;x<width;x++){int a=start+y*width+x,b=start+x*width+y;float swap=result[a];result[a]=result[b];result[b]=swap;}return result;}

    public static native int glGenTextures();
    public static native void glBindTexture(int target,int id);
    public static native void glDeleteTextures(int id);
    public static native void glTexParameteri(int target,int name,int value);
    public static void glTexImage2D(int target,int level,int internal,int width,int height,int border,int format,int type,ByteBuffer data){int count=data==null?0:textureByteCount(width,height,format,type);byte[] bytes=null;if(data!=null){if(data.remaining()<count)throw new IllegalArgumentException("Texture buffer too short");bytes=new byte[count];data.duplicate().get(bytes);}textureBytes(target,level,internal,width,height,border,format,type,bytes);}
    /** The original FBO allocation uses this typed-null overload; client IntBuffer pixels remain unsupported. */
    public static void glTexImage2D(int target,int level,int internal,int width,int height,int border,int format,int type,IntBuffer data){if(data!=null)throw new UnsupportedOperationException("IntBuffer texture uploads are outside the bounded browser backend");textureBytes(target,level,internal,width,height,border,format,type,null);}
    private static native int textureByteCount(int width,int height,int format,int type);
    private static native void textureBytes(int target,int level,int internal,int width,int height,int border,int format,int type,byte[] data);
    public static void glReadPixels(int x,int y,int width,int height,int format,int type,ByteBuffer data){int count=pixelCount(width,height,format,type);if(data.isReadOnly())throw new ReadOnlyBufferException();if(data.remaining()<count)throw new IllegalArgumentException("Readback buffer too short");byte[] bytes=new byte[count];for(int i=0;i<count;i++)bytes[i]=data.get(data.position()+i);readPixels(x,y,width,height,format,type,bytes);for(int i=0;i<count;i++)data.put(data.position()+i,bytes[i]);}
    private static native void readPixels(int x,int y,int width,int height,int format,int type,byte[] data);
    private static int pixelCount(int width,int height,int format,int type){if(format!=6408||type!=5121)throw new UnsupportedOperationException("Only RGBA UNSIGNED_BYTE qualified");if(width<0||height<0)throw new IllegalArgumentException("Negative image dimensions");return Math.multiplyExact(Math.multiplyExact(width,height),4);}
    public static native int glGenRenderbuffers();
    public static native void glBindRenderbuffer(int target,int id);
    public static native void glDeleteRenderbuffers(int id);
    public static native void glRenderbufferStorage(int target,int format,int width,int height);
    public static native void glRenderbufferStorageMultisample(int target,int samples,int format,int width,int height);
    public static native void glFramebufferRenderbuffer(int target,int attachment,int renderTarget,int id);
    public static native void glBlitFramebuffer(int sx0,int sy0,int sx1,int sy1,int dx0,int dy0,int dx1,int dy1,int mask,int filter);
    public static native int glGenFramebuffers();
    public static native void glBindFramebuffer(int target,int id);
    public static native void glDeleteFramebuffers(int id);
    public static native int glCheckFramebufferStatus(int target);
    public static native void glFramebufferTexture2D(int target,int attachment,int textureTarget,int texture,int level);
}
