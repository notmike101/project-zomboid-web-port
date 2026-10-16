import java.lang.classfile.*;import java.lang.constant.*;import java.nio.file.*;import java.util.zip.*;
/** Adds only the qualified vendor keyboard query boundary to a private view. */
public class PrepareInput {
 public static void main(String[]args)throws Exception{
  if(args.length!=2)throw new IllegalArgumentException("inputView outputView");Path input=Path.of(args[0]).toRealPath(),output=Path.of(args[1]).toAbsolutePath().normalize();
  if(input.equals(output)||(Files.exists(output)&&Files.isSameFile(input,output)))throw new IllegalArgumentException("Input/output alias");
  int[] changes={0};try(ZipFile zip=new ZipFile(input.toFile());ZipOutputStream target=new ZipOutputStream(Files.newOutputStream(output))){var entries=zip.entries();while(entries.hasMoreElements()){var entry=entries.nextElement();byte[]bytes;try(var stream=zip.getInputStream(entry)){bytes=stream.readAllBytes();}
   if(entry.getName().equals("org/lwjglx/input/Keyboard.class"))bytes=ClassFile.of().transformClass(ClassFile.of().parse(bytes),(builder,element)->{
    if(element instanceof MethodModel method&&method.methodName().equalsString("isKeyDown")&&method.methodType().equalsString("(I)Z")){changes[0]++;builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.iload(0).invokestatic(ClassDesc.of("port.host.BrowserKeyboard"),"isKeyDown",MethodTypeDesc.ofDescriptor("(I)Z")).ireturn());}
    else if(element instanceof MethodModel method&&method.methodName().equalsString("isCreated")&&method.methodType().equalsString("()Z")){changes[0]++;builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.invokestatic(ClassDesc.of("port.host.BrowserKeyboard"),"created",MethodTypeDesc.ofDescriptor("()Z")).ireturn());}
    else builder.with(element);
   });target.putNextEntry(new ZipEntry(entry.getName()));target.write(bytes);target.closeEntry();
  }}if(changes[0]!=2)throw new IllegalStateException("Expected exactly two vendor keyboard queries, found "+changes[0]);
 }
}
