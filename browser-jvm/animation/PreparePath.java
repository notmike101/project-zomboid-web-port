import java.nio.file.*;import java.util.zip.*;import java.lang.classfile.*;import java.lang.classfile.instruction.*;import java.lang.constant.*;import java.security.*;import java.util.*;
public class PreparePath {
 public static void main(String[] args)throws Exception{
  if(args.length!=3)throw new IllegalArgumentException("Usage: PreparePath INPUT_VIEW OUTPUT_OVERRIDE_JAR OUTPUT_METADATA_JSON");Path source=Path.of(args[0]).toRealPath();Path output=Path.of(args[1]).toAbsolutePath().normalize();Path metadata=Path.of(args[2]).toAbsolutePath().normalize();if((Files.exists(output)&&Files.isSameFile(source,output))||(Files.exists(metadata)&&Files.isSameFile(source,metadata))||output.equals(metadata))throw new IllegalArgumentException("Input/output alias");
  String name="zombie/ZomboidFileSystem.class";byte[] original;try(var zip=new ZipFile(args[0]);var in=zip.getInputStream(zip.getEntry(name))){original=in.readAllBytes();}var changed=new ArrayList<String>();
  byte[] view=ClassFile.of().transformClass(ClassFile.of().parse(original),(builder,element)->{
   if(element instanceof MethodModel method)builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
    if(instruction instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals("java/nio/file/Path")&&invoke.name().equalsString("resolve")&&invoke.type().equalsString("(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;")){
     changed.add(method.methodName().stringValue()+method.methodType().stringValue());code.invokestatic(ClassDesc.of("port.host.PathCompat"),"resolve",MethodTypeDesc.ofDescriptor("(Ljava/nio/file/Path;Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;"));
    }else if(instruction instanceof InvokeInstruction invoke&&invoke.owner().asInternalName().equals("java/util/List")&&invoke.name().equalsString("reversed")&&invoke.type().equalsString("()Ljava/util/List;")){changed.add("IMMUTABLE_STREAM_RESULT:"+method.methodName().stringValue()+method.methodType().stringValue());code.invokestatic(ClassDesc.of("port.host.PathCompat"),"reversedImmutableList",MethodTypeDesc.ofDescriptor("(Ljava/util/List;)Ljava/util/List;"));}else code.with(instruction);
   }));else builder.with(element);
  });if(changed.size()!=5)throw new AssertionError(changed);
  try(var out=new ZipOutputStream(Files.newOutputStream(output))){out.putNextEntry(new ZipEntry(name));out.write(view);out.closeEntry();}
  var md=MessageDigest.getInstance("SHA-256");Files.writeString(metadata,"{\"class\":\""+name+"\",\"beforeSha256\":\""+HexFormat.of().formatHex(md.digest(original))+"\",\"afterSha256\":\""+HexFormat.of().formatHex(md.digest(view))+"\",\"standardLibraryCallsRetargeted\":5,\"method\":\""+String.join(";",changed)+"\",\"gameAlgorithmChanges\":false}\n");
 }
}
