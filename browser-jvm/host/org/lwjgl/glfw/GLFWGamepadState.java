package org.lwjgl.glfw;
import java.nio.*;
/** Browser host value storage; intentionally does not claim native Struct/pointer ABI. */
public final class GLFWGamepadState implements AutoCloseable {
 public static final int SIZEOF=40,ALIGNOF=4,BUTTONS=0,AXES=16;
 private ByteBuffer storage=ByteBuffer.allocateDirect(SIZEOF).order(ByteOrder.nativeOrder());
 private ByteBuffer live(){if(storage==null)throw new IllegalStateException("Gamepad state freed");return storage;}
 public static GLFWGamepadState malloc(){return new GLFWGamepadState();}
 public static GLFWGamepadState calloc(){return malloc();}
 public byte buttons(int index){if(index<0||index>=15)throw new IndexOutOfBoundsException();return live().get(BUTTONS+index);}
 public GLFWGamepadState buttons(int index,byte value){if(index<0||index>=15)throw new IndexOutOfBoundsException();live().put(BUTTONS+index,value);return this;}
 public float axes(int index){if(index<0||index>=6)throw new IndexOutOfBoundsException();return live().getFloat(AXES+index*4);}
 public GLFWGamepadState axes(int index,float value){if(index<0||index>=6)throw new IndexOutOfBoundsException();live().putFloat(AXES+index*4,value);return this;}
 public GLFWGamepadState set(GLFWGamepadState other){ByteBuffer source=other.live().duplicate();source.clear();ByteBuffer dest=live().duplicate();dest.clear();dest.put(source);return this;}
 public void clear(){ByteBuffer b=live();for(int i=0;i<SIZEOF;i++)b.put(i,(byte)0);}
 public void free(){live();storage=null;}
 public void close(){free();}
}
