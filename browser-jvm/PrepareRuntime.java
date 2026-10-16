import java.lang.classfile.*;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.*;
import java.lang.reflect.AccessFlag;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
/** Parse-only host-boundary preparation. Never loads installed classes into the host JVM. */
public class PrepareRuntime{
 record Member(String owner,String name,String descriptor){String key(){return owner.replace('/','.')+"#"+name;}}
 static final ClassDesc GETTERS=ClassDesc.of("port.host.FloatGetters"),BRIDGE=ClassDesc.of("port.host.GeneratedFloatBridge"),OBJECT=ClassDesc.of("java.lang.Object"),FLOAT=ClassDesc.of("java.lang.Float");
 static void collect(byte[]bytes,List<Member>members){var c=ClassFile.of().parse(bytes);if(!c.flags().has(AccessFlag.PUBLIC))return;
  for(var f:c.fields())if(f.flags().has(AccessFlag.PUBLIC)&&f.flags().has(AccessFlag.STATIC)&&Set.of("F","C","Z","S","B").contains(f.fieldType().stringValue()))members.add(new Member(c.thisClass().asInternalName(),f.fieldName().stringValue(),f.fieldType().stringValue()));}
 public static void main(String[]args)throws Exception{
  if(args.length!=2)throw new IllegalArgumentException("outputDirectory fullEntryClasses"); Path root=Path.of(args[0]),classes=root.resolve("bridge-classes");Files.createDirectories(classes.resolve("port/host"));var members=new ArrayList<Member>();
  try(var jar=new ZipFile(root.resolve("view.jar").toFile())){
   var entries=jar.entries();while(entries.hasMoreElements()){var e=entries.nextElement();if(e.getName().endsWith(".class"))try(var stream=jar.getInputStream(e)){collect(stream.readAllBytes(),members);}}
  }
  collect(Files.readAllBytes(Path.of(args[1]).resolve("probe/CheerpJFull.class")),members);
  Path modules=FileSystems.getFileSystem(java.net.URI.create("jrt:/")).getPath("/modules");
  try(var paths=Files.walk(modules)){
   for(Path path:paths.filter(p->p.toString().endsWith(".class")).toList()){
    Path relative=modules.relativize(path);if(relative.getNameCount()<3)continue;
    var module=ModuleLayer.boot().findModule(relative.getName(0).toString());
    String className=relative.subpath(1,relative.getNameCount()).toString();int slash=className.lastIndexOf('/');
    if(slash<0||module.isEmpty()||!module.get().isExported(className.substring(0,slash).replace('/','.')))continue;
    collect(Files.readAllBytes(path),members);
   }
  }
  members.sort(Comparator.comparing(Member::key));var cf=ClassFile.of();
  byte[]getters=cf.build(GETTERS,b->{b.withVersion(61,0).withFlags(0x31);
   for(int i=0;i<members.size();i++){var f=members.get(i);String name="g"+i;
    ClassDesc type=ClassDesc.ofDescriptor(f.descriptor),box=switch(f.descriptor){case "F"->FLOAT;case "C"->ClassDesc.of("java.lang.Character");case "Z"->ClassDesc.of("java.lang.Boolean");case "S"->ClassDesc.of("java.lang.Short");case "B"->ClassDesc.of("java.lang.Byte");default->throw new AssertionError();};
    b.withMethodBody(name,MethodTypeDesc.of(OBJECT),0x9,code->code.getstatic(ClassDesc.ofInternalName(f.owner),f.name,type)
      .invokestatic(box,"valueOf",MethodTypeDesc.of(box,type)).areturn());}
  });
  Files.write(classes.resolve("port/host/FloatGetters.class"),getters);
  int chunks=(members.size()+63)/64;
  var source=new StringBuilder("package port.host; public final class GeneratedFloatBridge { public static int reads; private static final java.util.Map<String,Integer> indexes=new java.util.HashMap<>();static{");
  for(int chunk=0;chunk<chunks;chunk++)source.append("init").append(chunk).append("();");source.append("}\n");
  for(int chunk=0;chunk<chunks;chunk++){source.append("private static void init").append(chunk).append("(){\n");
   for(int i=chunk*64;i<Math.min(members.size(),chunk*64+64);i++)source.append("indexes.put(\"").append(members.get(i).key()).append("\",").append(i).append(");\n");source.append("}\n");}
  source.append("public static Object get(java.lang.reflect.Field field,Object receiver)throws IllegalAccessException {Integer index=indexes.get(field.getDeclaringClass().getName()+\"#\"+field.getName());if(index!=null){reads++;switch(index>>>6){\n");
  for(int chunk=0;chunk<chunks;chunk++)source.append("case ").append(chunk).append(":return read").append(chunk).append("(index);\n");
  source.append("default:throw new AssertionError();}}if((field.getType()==float.class||field.getType()==char.class||field.getType()==boolean.class||field.getType()==short.class||field.getType()==byte.class)&&java.lang.reflect.Modifier.isPublic(field.getModifiers())&&java.lang.reflect.Modifier.isStatic(field.getModifiers()))throw new UnsupportedOperationException(\"Unmapped public static field: \"+field.toString());return field.get(receiver);}\n");
  for(int chunk=0;chunk<chunks;chunk++){source.append("private static Object read").append(chunk).append("(int index){switch(index){\n");
   for(int i=chunk*64;i<Math.min(members.size(),chunk*64+64);i++)source.append("case ").append(i).append(":return FloatGetters.g").append(i).append("();\n");source.append("default:throw new AssertionError();}}\n");}
  source.append("}\n");Files.writeString(root.resolve("GeneratedFloatBridge.java"),source);
  Files.write(root.resolve("generated-float-members.tsv"),members.stream().map(Member::key).toList());
  String vendor="se/krka/kahlua/integration/expose/LuaJavaClassExposer.class";int[]changes={0},allocations={0};
  try(var input=new ZipFile(root.resolve("view.jar").toFile());var output=new ZipOutputStream(Files.newOutputStream(root.resolve("runtime-view.jar")))){
   var entries=input.entries();while(entries.hasMoreElements()){var e=entries.nextElement();byte[]bytes;try(var s=input.getInputStream(e)){bytes=s.readAllBytes();}
    if(e.getName().equals(vendor)){
     var resolver=ClassHierarchyResolver.ofResourceParsing(desc->{var item=input.getEntry(desc.descriptorString().substring(1,desc.descriptorString().length()-1)+".class");try{return item!=null?input.getInputStream(item):ClassLoader.getSystemResourceAsStream(desc.descriptorString().substring(1,desc.descriptorString().length()-1)+".class");}catch(Exception failure){throw new IllegalStateException(failure);}}).cached();
     var transform=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(resolver));
     bytes=transform.transformClass(transform.parse(bytes),(b,element)->{
      if(element instanceof MethodModel method&&method.methodName().equalsString("exposeStatics"))b.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
       if(instruction instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals("java/lang/reflect/Field")&&invoke.name().equalsString("get")&&invoke.type().stringValue().equals("(Ljava/lang/Object;)Ljava/lang/Object;")){
        changes[0]++;code.invokestatic(BRIDGE,"get",MethodTypeDesc.of(OBJECT,ClassDesc.of("java.lang.reflect.Field"),OBJECT));
       }else code.with(instruction);
      }));else b.with(element);
     });
     if(changes[0]!=1)throw new AssertionError("Expected exactly one vendor Field.get boundary, got "+changes[0]);
    }
    if(e.getName().equals("org/lwjgl/glfw/GLFWGamepadState.class")){
     String actual=HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
     if(!actual.equals("02071dccec7c6283404e8516abb8cdf2a3935cac304e58ace526f766fcd18050"))throw new IllegalArgumentException("Unqualified gamepad struct layout: "+actual);
     bytes=Files.readAllBytes(root.resolve("host-classes/org/lwjgl/glfw/GLFWGamepadState.class"));
    }
    if(e.getName().equals("org/lwjglx/input/GamepadState.class")){var adapter=ClassFile.of();bytes=adapter.transformClass(adapter.parse(bytes),ClassTransform.transformingMethodBodies((b,x)->{if(x instanceof InvokeInstruction i&&i.owner().asInternalName().equals("org/lwjgl/system/MemoryUtil")&&(i.name().equalsString("memAlloc")||i.name().equalsString("memFree"))){allocations[0]++;b.invokestatic(ClassDesc.of("port.host.BrowserBuffers"),i.name().stringValue(),i.typeSymbol());}else b.with(x);}));}
    var copy=new ZipEntry(e.getName());if(e.getTime()>=0)copy.setTime(e.getTime());if(e.getComment()!=null)copy.setComment(e.getComment());if(e.getExtra()!=null)copy.setExtra(e.getExtra());
    output.putNextEntry(copy);output.write(bytes);output.closeEntry();
   }
  }
  if(allocations[0]!=2)throw new AssertionError("Expected2 GamepadState allocation sites: "+allocations[0]);
  if(changes[0]!=1)throw new AssertionError("Vendor boundary absent");
  Files.writeString(root.resolve("float-bridge-summary.json"),"{\"generatedPublicStaticPrimitiveGetters\":"+members.size()+",\"types\":\"float,char,boolean,short,byte\",\"vendorFieldGetSites\":1,\"gamepadAllocatorSites\":2,\"gamepadStorageBytes\":40,\"gamepadAxesOffset\":16,\"nativePointerABI\":false,\"gameClassesChanged\":false,\"allGettersLiteralGetstatic\":true,\"dispatchChunkSize\":64}\n");
  System.out.println(Files.readString(root.resolve("float-bridge-summary.json")));
 }
}
