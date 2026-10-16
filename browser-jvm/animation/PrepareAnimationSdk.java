import java.lang.classfile.*;
import java.lang.classfile.instruction.*;
import java.lang.constant.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;
/** Exact SDK21 call adapter; original AnimLayer game algorithms remain otherwise untouched. */
public final class PrepareAnimationSdk {
 private static final String ENTRY="zombie/core/skinnedmodel/advancedanimation/AnimLayer.class";
 private static final String EXPECTED="8b59bfb1ec0c8e7e174cd3ba09042ff3bc9fe82bec38745c73d1f410daca0bc5";
 static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
 public static void main(String[] args)throws Exception {
  if(args.length!=3)throw new IllegalArgumentException("INPUT_VIEW OUTPUT_OVERLAY_JAR OUTPUT_MANIFEST");
  Path input=Path.of(args[0]).toRealPath(),output=Path.of(args[1]).toAbsolutePath().normalize(),manifest=Path.of(args[2]).toAbsolutePath().normalize();
  if(output.equals(manifest)||(Files.exists(output)&&Files.isSameFile(input,output))||(Files.exists(manifest)&&Files.isSameFile(input,manifest))||(Files.exists(output)&&Files.exists(manifest)&&Files.isSameFile(output,manifest)))throw new IllegalArgumentException("Input/output alias");
  try(var zip=new ZipFile(input.toFile())){
   byte[] original;try(var in=zip.getInputStream(zip.getEntry(ENTRY))){original=in.readAllBytes();}String before=hash(original);if(!before.equals(EXPECTED))throw new IllegalArgumentException("Unqualified AnimLayer class SHA256: "+before);
   var resolver=ClassHierarchyResolver.ofResourceParsing(desc->{String name=desc.descriptorString().substring(1,desc.descriptorString().length()-1)+".class";var item=zip.getEntry(name);try{return item!=null?zip.getInputStream(item):ClassLoader.getSystemResourceAsStream(name);}catch(Exception failure){throw new IllegalStateException(failure);}}).cached();
   var cf=ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(resolver));var sites=new ArrayList<String>();
   byte[] adapted=cf.transformClass(cf.parse(original),(builder,element)->{
    if(!(element instanceof MethodModel method)){builder.with(element);return;}int[] bci={0};
    builder.transformMethod(method,MethodTransform.transformingCode((code,item)->{
     int offset=bci[0];if(item instanceof Instruction instruction)bci[0]+=instruction.sizeInBytes();
     if(item instanceof InvokeInstruction call&&call.owner().asInternalName().equals("java/util/List")&&call.name().equalsString("getFirst")&&call.type().equalsString("()Ljava/lang/Object;")){
      String signature=method.methodName().stringValue()+method.methodType().stringValue();boolean qualified=signature.equals("transitionTo(Lzombie/core/skinnedmodel/advancedanimation/AnimState;Z)Z")&&offset==34||signature.equals("getHighestLiveNode()Lzombie/core/skinnedmodel/advancedanimation/LiveAnimNode;")&&offset==18;
      if(!qualified)throw new IllegalArgumentException("Unqualified getFirst call: "+signature+" BCI"+offset);
      sites.add("{\"method\":\""+signature+"\",\"originalBCI\":"+offset+"}");code.invokestatic(ClassDesc.of("port.host.ListFirstSupport"),"getFirst",MethodTypeDesc.ofDescriptor("(Ljava/util/List;)Ljava/lang/Object;"));
     }else code.with(item);
    }));
   });if(sites.size()!=2)throw new IllegalArgumentException("Expected exactly two AnimLayer List.getFirst calls: "+sites.size());
   try(var jar=new ZipOutputStream(Files.newOutputStream(output))){jar.putNextEntry(new ZipEntry(ENTRY));jar.write(adapted);jar.closeEntry();}
   Files.writeString(manifest,"{\"entry\":\""+ENTRY+"\",\"inputClassSha256\":\""+before+"\",\"outputClassSha256\":\""+hash(adapted)+"\",\"sites\":["+String.join(",",sites)+"],\"receiver\":\"exact java.util.ArrayList only\",\"from\":\"java.util.List.getFirst()Ljava/lang/Object;\",\"to\":\"port.host.ListFirstSupport.getFirst(Ljava/util/List;)Ljava/lang/Object;\",\"gameMethodBodyBytesUnchanged\":false,\"originalAlgorithmPreserved\":true}\n");
  }
 }
}
