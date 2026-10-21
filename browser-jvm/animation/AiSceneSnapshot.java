import java.io.*;
import java.lang.reflect.*;
import java.nio.*;
import java.nio.file.*;
import java.util.*;
import jassimp.*;

/** Private data-only snapshot of genuine importer output; no zombie classes are initialized. */
public final class AiSceneSnapshot {
 private static final int MAGIC=0x41495331;
 private static final String[] ABI={"NATIVE_AIVEKTORKEY_SIZE","NATIVE_AIQUATKEY_SIZE","NATIVE_AIVEKTOR3D_SIZE","NATIVE_FLOAT_SIZE","NATIVE_INT_SIZE","NATIVE_UINT_SIZE","NATIVE_DOUBLE_SIZE","NATIVE_LONG_SIZE"};
 static Field[] fields(Class<?> type){var fields=new ArrayList<Field>();for(var f:type.getDeclaredFields())if(!Modifier.isStatic(f.getModifiers()))fields.add(f);fields.sort(Comparator.comparing(Field::getName));return fields.toArray(Field[]::new);}
 public static byte[] encode(AiScene scene)throws Exception{
  var bytes=new ByteArrayOutputStream();var out=new DataOutputStream(bytes);out.writeInt(MAGIC);for(String name:ABI)out.writeInt(Jassimp.class.getField(name).getInt(null));new Writer(out).value(scene);out.close();return bytes.toByteArray();
 }
 public static AiScene decode(byte[] bytes)throws Exception{
  var in=new DataInputStream(new ByteArrayInputStream(bytes));if(in.readInt()!=MAGIC)throw new IOException("Unrecognized snapshot");for(String name:ABI)Jassimp.class.getField(name).setInt(null,in.readInt());Object result=new Reader(in).value();if(in.read()!=-1)throw new IOException("Trailing snapshot data");return (AiScene)result;
 }
 static final class Writer {
  final DataOutputStream out;final IdentityHashMap<Object,Integer> seen=new IdentityHashMap<>();Writer(DataOutputStream out){this.out=out;}
  void value(Object value)throws Exception{
   if(value==null){out.writeByte(0);return;}
   if(value instanceof String v){out.writeByte(2);out.writeUTF(v);return;}
   if(value instanceof Integer v){out.writeByte(3);out.writeInt(v);return;}
   if(value instanceof Long v){out.writeByte(4);out.writeLong(v);return;}
   if(value instanceof Float v){out.writeByte(5);out.writeInt(Float.floatToRawIntBits(v));return;}
   if(value instanceof Double v){out.writeByte(6);out.writeLong(Double.doubleToRawLongBits(v));return;}
   if(value instanceof Boolean v){out.writeByte(7);out.writeBoolean(v);return;}
   if(value instanceof Enum<?> v){out.writeByte(8);out.writeUTF(v.getDeclaringClass().getName());out.writeUTF(v.name());return;}
   if(value instanceof Byte v){out.writeByte(16);out.writeByte(v);return;}
   if(value instanceof Short v){out.writeByte(17);out.writeShort(v);return;}
   if(value instanceof Character v){out.writeByte(18);out.writeChar(v);return;}
   Integer previous=seen.get(value);if(previous!=null){out.writeByte(1);out.writeInt(previous);return;}
   int id=seen.size();seen.put(value,id);
   if(value instanceof ByteBuffer buffer){out.writeByte(9);out.writeInt(id);out.writeBoolean(buffer.isDirect());out.writeBoolean(buffer.isReadOnly());out.writeBoolean(buffer.order()==ByteOrder.LITTLE_ENDIAN);out.writeInt(buffer.position());out.writeInt(buffer.limit());out.writeInt(buffer.capacity());var copy=buffer.duplicate();copy.clear();while(copy.hasRemaining())out.writeByte(copy.get());return;}
   if(value.getClass().isArray()){out.writeByte(10);out.writeInt(id);out.writeUTF(value.getClass().getComponentType().getName());int n=Array.getLength(value);out.writeInt(n);for(int i=0;i<n;i++)value(Array.get(value,i));return;}
   if(value instanceof List<?> list){out.writeByte(11);out.writeInt(id);out.writeInt(list.size());for(var v:list)value(v);return;}
   if(value instanceof Map<?,?> map){out.writeByte(12);out.writeInt(id);out.writeInt(map.size());for(var v:map.entrySet()){value(v.getKey());value(v.getValue());}return;}
   if(value instanceof Set<?> set){out.writeByte(13);out.writeInt(id);out.writeInt(set.size());for(var v:set)value(v);return;}
   Class<?> type=value.getClass();if(!type.getName().startsWith("jassimp."))throw new IOException("Unexpected importer object "+type.getName());
   out.writeByte(14);out.writeInt(id);out.writeUTF(type.getName());var fields=fields(type);out.writeInt(fields.length);for(var f:fields){f.setAccessible(true);out.writeUTF(f.getName());value(f.get(value));}
  }
 }
 static final class Reader {
  final DataInputStream in;final Map<Integer,Object> seen=new HashMap<>();Reader(DataInputStream in){this.in=in;}
  Class<?> type(String name)throws Exception{return switch(name){case "int"->int.class;case "byte"->byte.class;case "short"->short.class;case "long"->long.class;case "float"->float.class;case "double"->double.class;case "boolean"->boolean.class;case "char"->char.class;default->{if(!name.startsWith("jassimp.")&&!name.equals("java.lang.String")&&!name.equals("java.nio.ByteBuffer")&&!name.equals("java.lang.Object"))throw new IOException("Unexpected snapshot type "+name);yield Class.forName(name);}};}
  Object construct(Class<?> type)throws Exception{
   // These original wrappers only store their buffer; decoded real fields replace it before return.
   // Original AiLightType.<clinit> assigns DIRECTIONAL raw 1; raw 0 is rejected.
   boolean bufferWrapper=type==AiVector.class||type==AiQuaternion.class||type==AiColor.class;
   var constructors=type.getDeclaredConstructors();Arrays.sort(constructors,Comparator.comparingInt(Constructor::getParameterCount));
   for(var c:constructors){c.setAccessible(true);Object[] args=new Object[c.getParameterCount()];var types=c.getParameterTypes();for(int i=0;i<args.length;i++){var t=types[i];args[i]=type==AiLight.class&&i==1?1:bufferWrapper&&t==ByteBuffer.class?ByteBuffer.allocate(0):t==String.class?"":t==int.class?0:t==long.class?0L:t==float.class?0f:t==double.class?0d:t==boolean.class?false:t.isArray()?Array.newInstance(t.getComponentType(),16):null;}if(type.getName().equals("jassimp.AiMaterial$Property"))args[3]=1;try{return c.newInstance(args);}catch(InvocationTargetException e){}}
   throw new IOException("No usable importer constructor: "+type.getName());
  }
  @SuppressWarnings({"unchecked","rawtypes"}) Object value()throws Exception{
   int tag=in.readUnsignedByte();switch(tag){
    case 0:return null;case 1:{int id=in.readInt();if(!seen.containsKey(id))throw new IOException("Missing reference "+id);return seen.get(id);}case 2:return in.readUTF();case 3:return in.readInt();case 4:return in.readLong();case 5:return Float.intBitsToFloat(in.readInt());case 6:return Double.longBitsToDouble(in.readLong());case 7:return in.readBoolean();case 8:return Enum.valueOf((Class)type(in.readUTF()),in.readUTF());case 16:return in.readByte();case 17:return in.readShort();case 18:return in.readChar();
    case 9:{int id=in.readInt();boolean direct=in.readBoolean(),readOnly=in.readBoolean(),little=in.readBoolean();int position=in.readInt(),limit=in.readInt(),capacity=in.readInt();ByteBuffer b=direct?ByteBuffer.allocateDirect(capacity):ByteBuffer.allocate(capacity);for(int i=0;i<capacity;i++)b.put(i,in.readByte());b.limit(limit).position(position);if(readOnly)b=b.asReadOnlyBuffer();b.order(little?ByteOrder.LITTLE_ENDIAN:ByteOrder.BIG_ENDIAN);seen.put(id,b);return b;}
    case 10:{int id=in.readInt();Class<?> component=type(in.readUTF());int n=in.readInt();Object result=Array.newInstance(component,n);seen.put(id,result);for(int i=0;i<n;i++)Array.set(result,i,value());return result;}
    case 11:{int id=in.readInt(),n=in.readInt();var list=new ArrayList<>();seen.put(id,list);for(int i=0;i<n;i++)list.add(value());return list;}
    case 12:{int id=in.readInt(),n=in.readInt();var map=new LinkedHashMap<>();seen.put(id,map);for(int i=0;i<n;i++)map.put(value(),value());return map;}
    case 13:{int id=in.readInt(),n=in.readInt();var set=new LinkedHashSet<>();seen.put(id,set);for(int i=0;i<n;i++)set.add(value());return set;}
    case 14:{int id=in.readInt();Class<?> type=type(in.readUTF());Object result=construct(type);seen.put(id,result);int n=in.readInt();for(int i=0;i<n;i++){var field=type.getDeclaredField(in.readUTF());field.setAccessible(true);field.set(result,value());}return result;}
    default:throw new IOException("Unexpected snapshot tag "+tag);
   }
  }
 }
}
