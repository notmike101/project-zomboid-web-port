import java.lang.classfile.*;
import java.lang.classfile.instruction.LabelTarget;
import java.lang.classfile.instruction.LocalVariable;
import java.lang.classfile.instruction.LocalVariableType;
import java.lang.constant.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Private pinned vendor Cursor image boundary; original game classes are never emitted. */
public final class PrepareCustomCursor {
    private static final ClassDesc HOST = ClassDesc.of("port.host.BrowserCustomCursor");
    private static final ClassDesc CURSOR = ClassDesc.of("org.lwjglx.input.Cursor");
    private static String sha(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
    private static byte[] read(Path path,String name) throws Exception {
        try (ZipFile zip=new ZipFile(path.toFile()); var stream=zip.getInputStream(zip.getEntry(name))) { return stream.readAllBytes(); }
    }
    private static void distinct(Path a,Path b) throws Exception {
        if(a.equals(b)||Files.exists(a)&&Files.exists(b)&&Files.isSameFile(a,b)) throw new IllegalArgumentException("Aliased cursor paths");
    }
    public static void main(String[] args) throws Exception {
        if(args.length!=4) throw new IllegalArgumentException("atomic mouse output manifest");
        Path[] paths=Arrays.stream(args).map(x->Path.of(x).toAbsolutePath().normalize()).toArray(Path[]::new);
        for(int i=0;i<paths.length;i++)for(int j=i+1;j<paths.length;j++)distinct(paths[i],paths[j]);
        byte[] input=read(paths[0],"org/lwjglx/input/Cursor.class");
        byte[] mouse=read(paths[1],"org/lwjglx/input/Mouse.class");
        if(!sha(input).equals("eec7e9d510727d0d9a27856e245d1ab7ae2a6c9b1e50bba3d51dc785b02be4f4")
            ||!sha(mouse).equals("451c26de4a35de29686f38718feec768efd47c40714fe9b2217bc7c0a2d70f71")) throw new IllegalArgumentException("Cursor source pin");
        var api=ClassFile.of(); var before=api.parse(input); int[] tail={0};
        byte[] result=api.transformClass(before,(builder,element)->{
            if(!(element instanceof MethodModel method)){builder.with(element);return;}
            String name=method.methodName().stringValue();
            if(name.equals("<init>")) {
                int[] bci={0};
                builder.transformMethod(method,MethodTransform.transformingCode((code,item)->{
                    if(item instanceof LocalVariable || item instanceof LocalVariableType) return;
                    int offset=bci[0];
                    if(item instanceof Instruction instruction) {
                        bci[0]+=instruction.sizeInBytes();
                        if(offset==49) {
                            tail[0]++;
                            code.aload(0).iload(1).iload(2).iload(3).iload(4).aload(9)
                                .invokestatic(HOST,"create",MethodTypeDesc.of(ConstantDescs.CD_void,CURSOR,ConstantDescs.CD_int,ConstantDescs.CD_int,ConstantDescs.CD_int,ConstantDescs.CD_int,ClassDesc.of("java.nio.ByteBuffer"))).return_();
                        }
                    }
                    if(offset<49 || item instanceof LabelTarget)code.with(item);
                }));
            } else if(name.equals("destroy")) builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.aload(0).invokestatic(HOST,"destroy",MethodTypeDesc.of(ConstantDescs.CD_void,CURSOR)).return_());
            else if(name.equals("getHandle")) builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.aload(0).invokestatic(HOST,"handle",MethodTypeDesc.of(ConstantDescs.CD_long,CURSOR)).lreturn());
            else builder.with(element);
        });
        if(tail[0]!=1)throw new AssertionError("Exactly one cursor constructor tail");
        var after=api.parse(result); int unchanged=0;
        for(var method:before.methods()) {
            String name=method.methodName().stringValue();
            var next=after.methods().stream().filter(x->x.methodName().equalsString(name)&&x.methodType().equalsString(method.methodType().stringValue())).findFirst().orElseThrow();
            if(name.equals("<init>")) {
                if(!Arrays.equals(Arrays.copyOf(method.findAttribute(Attributes.code()).orElseThrow().codeArray(),49),Arrays.copyOf(next.findAttribute(Attributes.code()).orElseThrow().codeArray(),49)))throw new AssertionError("Original conversion prefix changed");
            }else if(!Set.of("destroy","getHandle").contains(name)) {
                if(!Arrays.equals(method.findAttribute(Attributes.code()).orElseThrow().codeArray(),next.findAttribute(Attributes.code()).orElseThrow().codeArray()))throw new AssertionError("Unselected Cursor body changed"); unchanged++;
            }
        }
        var mouseBefore=api.parse(mouse);
        byte[] mouseResult=api.transformClass(mouseBefore,(builder,element)->{
            if(element instanceof MethodModel method&&method.methodName().equalsString("setNativeCursor"))builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->code.aload(0).invokestatic(HOST,"select",MethodTypeDesc.of(CURSOR,CURSOR)).areturn());
            else builder.with(element);
        });
        int mouseUnchanged=0;
        for(var method:mouseBefore.methods())if(!method.methodName().equalsString("setNativeCursor")) {
            var next=api.parse(mouseResult).methods().stream().filter(x->x.methodName().equalsString(method.methodName().stringValue())&&x.methodType().equalsString(method.methodType().stringValue())).findFirst().orElseThrow();
            if(!Arrays.equals(method.findAttribute(Attributes.code()).orElseThrow().codeArray(),next.findAttribute(Attributes.code()).orElseThrow().codeArray()))throw new AssertionError("Other prepared Mouse changed");mouseUnchanged++;
        }
        if(!api.verify(result).isEmpty()||!api.verify(mouseResult).isEmpty())throw new AssertionError("Emitted class verification: " + api.verify(result) + " / " + api.verify(mouseResult));
        try(ZipOutputStream zip=new ZipOutputStream(Files.newOutputStream(paths[2]))) {
            zip.putNextEntry(new ZipEntry("org/lwjglx/input/Cursor.class"));zip.write(result);zip.closeEntry();
            zip.putNextEntry(new ZipEntry("org/lwjglx/input/Mouse.class"));zip.write(mouseResult);zip.closeEntry();
        }
        Files.writeString(paths[3],"{\"cursorInput\":\""+sha(input)+"\",\"cursorOutput\":\""+sha(result)+"\",\"mouseInput\":\""+sha(mouse)+"\",\"mouseOutput\":\""+sha(mouseResult)+"\",\"cursorUnchanged\":"+unchanged+",\"mouseUnchanged\":"+mouseUnchanged+",\"originalConstructorPrefixBytes\":49,\"gameClassesEmitted\":0,\"verified\":true}");
    }
}

