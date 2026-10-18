import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.MethodModel;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Pinned vendor clipboard boundary; original game Clipboard is never emitted or modified. */
public final class PrepareClipboard {
    static String sha(byte[] value)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));}
    private static void distinct(Path first, Path second) throws IOException {
        if (first.equals(second) || Files.exists(first) && Files.exists(second) && Files.isSameFile(first, second)) {
            throw new IllegalArgumentException("Clipboard input, output and manifest must be distinct files");
        }
    }
    public static void main(String[]args)throws Exception{
        if (args.length != 3) throw new IllegalArgumentException("input SDK JAR, output overlay JAR, manifest path required");
        Path inputPath = Path.of(args[0]).toAbsolutePath().normalize();
        Path outputPath = Path.of(args[1]).toAbsolutePath().normalize();
        Path manifestPath = Path.of(args[2]).toAbsolutePath().normalize();
        distinct(inputPath, outputPath);
        distinct(inputPath, manifestPath);
        distinct(outputPath, manifestPath);
        byte[] input;try(var jar=new ZipFile(inputPath.toFile());var stream=jar.getInputStream(jar.getEntry("org/lwjgl/glfw/GLFW.class"))){input=stream.readAllBytes();}
        byte[] gameClipboard;
        try (var jar = new ZipFile(inputPath.toFile()); var stream = jar.getInputStream(jar.getEntry("zombie/core/Clipboard.class"))) {
            gameClipboard = stream.readAllBytes();
        }
        if (!sha(gameClipboard).equals("c8e8c4256508643540e53456cb43dcc5f3f2f6f7935009889cc2e1648196915d")) {
            throw new IllegalArgumentException("Unqualified prepared original game Clipboard source");
        }
        if(!sha(input).equals("f32400d666ab0de59cdabb5d87f8ecf58773afca6e75fa40211e83ef5b84ea77"))throw new IllegalArgumentException("Unqualified original GLFW source");
        var api=ClassFile.of();var original=api.parse(input);var host=ClassDesc.of("port.host.BrowserClipboard");var type=ClassDesc.of("org.lwjgl.glfw.GLFW");var library=ClassDesc.of("org.lwjgl.system.SharedLibrary");var selected=new ArrayList<String>();
        byte[] output=api.transformClass(original,(builder,element)->{
            if(!(element instanceof MethodModel method)){builder.with(element);return;}
            String key=method.methodName().stringValue()+method.methodType().stringValue();
            if(!Set.of("<clinit>()V","glfwSetErrorCallback(Lorg/lwjgl/glfw/GLFWErrorCallbackI;)Lorg/lwjgl/glfw/GLFWErrorCallback;","glfwGetClipboardString(J)Ljava/lang/String;","glfwSetClipboardString(JLjava/lang/CharSequence;)V").contains(key)){builder.with(element);return;}
            selected.add(key);
            builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask()&~0x100,code->{
                switch(method.methodName().stringValue()){
                    case "<clinit>"->code.invokestatic(host,"library",MethodTypeDesc.of(library)).putstatic(type,"GLFW",library).return_();
                    case "glfwSetErrorCallback"->code.aload(0).invokestatic(host,"errorCallback",method.methodTypeSymbol()).areturn();
                    case "glfwGetClipboardString"->code.lload(0).invokestatic(host,"read",method.methodTypeSymbol()).areturn();
                    default->code.lload(0).aload(2).invokestatic(host,"write",method.methodTypeSymbol()).return_();
                }
            });
        });
        if(selected.size()!=4)throw new AssertionError("Exactly four clipboard selectors required");
        var emitted=api.parse(output);int unchanged=0;
        for(var before:original.methods()){
            if(selected.contains(before.methodName().stringValue()+before.methodType().stringValue()))continue;
            var after=emitted.methods().stream().filter(m->m.methodName().equalsString(before.methodName().stringValue())&&m.methodType().equalsString(before.methodType().stringValue())).findFirst().orElseThrow();
            var a=before.findAttribute(Attributes.code());var b=after.findAttribute(Attributes.code());
            if(a.isPresent()!=b.isPresent()||a.isPresent()&&!Arrays.equals(a.get().codeArray(),b.orElseThrow().codeArray()))throw new AssertionError("Unselected vendor body changed");unchanged++;
        }
        try(var jar=new ZipOutputStream(Files.newOutputStream(outputPath))){jar.putNextEntry(new ZipEntry("org/lwjgl/glfw/GLFW.class"));jar.write(output);jar.closeEntry();}
        Files.writeString(manifestPath,"{\"vendorClass\":\"org/lwjgl/glfw/GLFW\",\"inputSha256\":\""+sha(input)+"\",\"outputSha256\":\""+sha(output)+"\",\"preparedOriginalClipboardSha256\":\""+sha(gameClipboard)+"\",\"selected\":["+String.join(",",selected.stream().map(x->"\""+x+"\"").toList())+"],\"unchangedOtherMethods\":"+unchanged+",\"gameClassesEmitted\":0}");
    }
}
