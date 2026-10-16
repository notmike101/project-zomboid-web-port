import java.nio.file.*;import java.util.zip.*;import java.lang.classfile.*;import java.lang.constant.*;
public class PrepareVendor {
 public static void main(String[] args)throws Exception{
  if(args.length!=2)throw new IllegalArgumentException("Usage: PrepareVendor GAME_JAR OUTPUT_JAR");Path source=Path.of(args[0]).toRealPath();Path destination=Path.of(args[1]).toAbsolutePath().normalize();if(Files.exists(destination)&&Files.isSameFile(source,destination))throw new IllegalArgumentException("Input/output alias");
  byte[] bytes;try(var zip=new ZipFile(args[0]);var in=zip.getInputStream(zip.getEntry("jassimp/Jassimp.class"))){bytes=in.readAllBytes();}int[] changes={0};
  byte[] view=ClassFile.of().transformClass(ClassFile.of().parse(bytes),(builder,element)->{
   if(element instanceof MethodModel method&&method.methodName().equalsString("importFile")&&method.methodType().equalsString("(Ljava/lang/String;Ljava/util/Set;)Ljassimp/AiScene;")){
    changes[0]++;builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.aload(0).aload(1).invokestatic(ClassDesc.of("PreparedSceneLoader"),"importFile",MethodTypeDesc.ofDescriptor("(Ljava/lang/String;Ljava/util/Set;)Ljassimp/AiScene;")).areturn());
   }else builder.with(element);
  });if(changes[0]!=1)throw new AssertionError("Expected one vendor importer adapter");int major=((view[6]&255)<<8)|(view[7]&255);if(major>61){view[6]=0;view[7]=61;}
  try(var out=new ZipOutputStream(Files.newOutputStream(destination))){out.putNextEntry(new ZipEntry("jassimp/Jassimp.class"));out.write(view);out.closeEntry();}
 }
}
