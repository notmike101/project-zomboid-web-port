import java.lang.classfile.*;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Parse-only selected vendor graphics facade. Never loads original classes on the desktop JVM. */
public final class PrepareSpriteGraphics {
    private static final ClassDesc HOST=ClassDesc.of("port.host.SpriteGraphics"), CAPS=ClassDesc.of("org.lwjgl.opengl.GLCapabilities");
    private static final Set<String> GL_CLASSES=Set.of("GL11C","GL12C","GL13C","GL14C","GL15C","GL20C","GL30C","ARBVertexBufferObject","ARBMapBufferRange","ARBFramebufferObject");
    private static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static String quote(String text){return "\""+text.replace("\\","\\\\").replace("\"","\\\"")+"\"";}

    /** Parse-only proof that selected static APIs never rewrite vendor instance constructors. */
    private static int verifyConstructors(ClassModel original, byte[] emittedBytes) {
        ClassModel emitted=ClassFile.of().parse(emittedBytes);
        int preserved=0;
        for(var before:original.methods())if(before.methodName().equalsString("<init>")){
            var after=emitted.methods().stream().filter(method->method.methodName().equalsString("<init>")&&method.methodType().equalsString(before.methodType().stringValue())).findFirst().orElseThrow(()->new AssertionError("Vendor constructor removed"));
            var beforeCode=before.findAttribute(Attributes.code());var afterCode=after.findAttribute(Attributes.code());
            if(beforeCode.isPresent()!=afterCode.isPresent()||beforeCode.isPresent()&&!Arrays.equals(beforeCode.get().codeArray(),afterCode.get().codeArray()))throw new AssertionError("Vendor constructor body changed: "+original.thisClass().asInternalName()+before.methodType());
            preserved++;
        }
        for(var method:emitted.methods())if(method.methodName().equalsString("<init>"))for(var element:method.code().orElseThrow()){
            if(element instanceof InvokeInstruction call&&call.opcode()==Opcode.INVOKESTATIC&&call.owner().asInternalName().equals("port/host/SpriteGraphics")&&call.name().equalsString("<init>"))throw new AssertionError("Invalid static host constructor invocation");
        }
        return preserved;
    }

    /** Only the desktop window operations are replaced; public mode-selection branches remain original. */
    private static boolean browserDisplayMethod(ClassBuilder builder, MethodModel method, List<String> changes) {
        String key = method.methodName().stringValue() + method.methodType().stringValue();
        if (!Set.of("create()V", "create(Lorg/lwjglx/opengl/PixelFormat;)V", "destroy()V",
                "setBorderlessWindow(Z)V", "setDisplayModeAndFullscreenInternal(Lorg/lwjglx/opengl/DisplayMode;Z)V").contains(key)) return false;
        ClassDesc display = ClassDesc.of("org.lwjglx.opengl.Display");
        ClassDesc mode = ClassDesc.of("org.lwjglx.opengl.DisplayMode");
        changes.add(key + ":owned-browser-surface+vendor-caches");
        builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask() & ~0x100, code -> {
            switch (key) {
                case "create()V", "create(Lorg/lwjglx/opengl/PixelFormat;)V" -> {
                    if (key.equals("create()V")) code.invokestatic(HOST, "create", MethodTypeDesc.of(ConstantDescs.CD_void));
                    else code.aload(0).invokestatic(HOST, "create", method.methodTypeSymbol());
                    code.invokestatic(HOST, "getDesktopDisplayMode", MethodTypeDesc.of(mode)).dup()
                        .putstatic(display, "desktopDisplayMode", mode).putstatic(display, "gameWindowMode", mode)
                        .iconst_1().putstatic(display, "displayCreated", ConstantDescs.CD_boolean)
                        .lconst_0().getstatic(display, "windowTitle", ConstantDescs.CD_String)
                        .invokestatic(HOST, "setWindowTitle", MethodTypeDesc.of(ConstantDescs.CD_void,
                            ConstantDescs.CD_long, ClassDesc.of("java.lang.CharSequence")));
                    displaySizeCaches(code, display);
                    code.getstatic(display, "vsyncEnabled", ConstantDescs.CD_boolean)
                        .invokestatic(HOST, "setVSyncEnabled", MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_boolean));
                }
                case "destroy()V" -> code.invokestatic(HOST, "destroy", MethodTypeDesc.of(ConstantDescs.CD_void))
                    .iconst_0().putstatic(display, "displayCreated", ConstantDescs.CD_boolean);
                case "setBorderlessWindow(Z)V" -> code.iload(0)
                    .invokestatic(HOST, "requireWindowedBorder", MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_boolean))
                    .iload(0).putstatic(display, "isBorderlessWindow", ConstantDescs.CD_boolean);
                default -> {
                    code.aload(0).iload(1).invokestatic(HOST, "applyDisplayMode", method.methodTypeSymbol())
                        .aload(0).putstatic(display, "gameWindowMode", mode)
                        .iload(1).invokestatic(ClassDesc.of("zombie.core.Core"), "setFullScreen",
                            MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_boolean));
                    displaySizeCaches(code, display);
                }
            }
            code.return_();
        });
        return true;
    }

    private static void displaySizeCaches(CodeBuilder code, ClassDesc display) {
        for (String field : List.of("displayWidth", "latestWidth", "displayFramebufferWidth"))
            code.invokestatic(HOST, "surfaceWidth", MethodTypeDesc.of(ConstantDescs.CD_int)).putstatic(display, field, ConstantDescs.CD_int);
        for (String field : List.of("displayHeight", "latestHeight", "displayFramebufferHeight"))
            code.invokestatic(HOST, "surfaceHeight", MethodTypeDesc.of(ConstantDescs.CD_int)).putstatic(display, field, ConstantDescs.CD_int);
    }

    public static void main(String[] args)throws Exception{
        if(args.length!=3)throw new IllegalArgumentException("runtimeViewJar outputDirectory authoredClasses");
        Path input=Path.of(args[0]).toRealPath(),output=Path.of(args[1]).toAbsolutePath().normalize(),authored=Path.of(args[2]).toRealPath();
        Path target=Path.of("target").toRealPath();
        if(!output.startsWith(target)||output.equals(target)||input.equals(output.resolve("sprite-view.jar")))throw new IllegalArgumentException("Output must be a distinct private workspace target");
        Files.createDirectories(output);
        var cf=ClassFile.of();
        var host=cf.parse(Files.readAllBytes(authored.resolve("port/host/SpriteGraphics.class")));
        var methods=new HashSet<String>();for(var method:host.methods())if((method.flags().flagsMask()&0x8)!=0&&!method.methodName().stringValue().startsWith("<"))methods.add(method.methodName().stringValue()+method.methodType().stringValue());
        var changed=new ArrayList<String>();int[]gameClasses={0};int constructorChecks=0;
        try(var jar=new ZipFile(input.toFile());var result=new ZipOutputStream(Files.newOutputStream(output.resolve("sprite-view.jar")))){
            var entries=jar.entries();
            while(entries.hasMoreElements()){
                var entry=entries.nextElement();byte[]original;try(var stream=jar.getInputStream(entry)){original=stream.readAllBytes();}byte[]bytes=original;
                String name=entry.getName().replaceFirst("\\.class$","");
                if(entry.getName().endsWith(".class")){
                    var model=cf.parse(original);String simple=name.substring(name.lastIndexOf('/')+1);var changes=new ArrayList<String>();
                    boolean gl=name.startsWith("org/lwjgl/opengl/")&&GL_CLASSES.contains(simple);
                    boolean legacyAttributes=name.equals("org/lwjgl/opengl/GL11");
                    boolean memory=name.equals("org/lwjgl/system/MemoryUtil"), api=name.equals("org/lwjgl/opengl/GL"), display=name.equals("org/lwjglx/opengl/Display");
                    if(display&&!hash(original).equals("6a9dc0e2e2b11ce6d952ae1653dc29ef899ccb3403ed85c93a2898580986c89a"))throw new IllegalArgumentException("Unqualified vendor Display input");
                    int[] titleSites={0};
                    if(gl||legacyAttributes||memory||api||display||name.equals("org/lwjgl/opengl/GLCapabilities")){
                        bytes=cf.transformClass(model,(builder,element)->{
                            if(!(element instanceof MethodModel method)){builder.with(element);return;}
                            String methodName=method.methodName().stringValue(),descriptor=method.methodType().stringValue();
                            String helper=methodName.endsWith("ARB")?methodName.substring(0,methodName.length()-3):methodName;
                            if (display && browserDisplayMethod(builder, method, changes)) return;
                            if(display&&methodName.equals("setTitle")&&descriptor.equals("(Ljava/lang/String;)V")){
                                int[] bci={0};
                                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                                    int offset=bci[0];
                                    if(instruction instanceof Instruction operation)bci[0]+=operation.sizeInBytes();
                                    if(instruction instanceof InvokeInstruction call&&call.opcode()==Opcode.INVOKESTATIC&&call.owner().asInternalName().equals("org/lwjgl/glfw/GLFW")&&call.name().equalsString("glfwSetWindowTitle")&&call.type().equalsString("(JLjava/lang/CharSequence;)V")){
                                        if(offset!=16)throw new IllegalArgumentException("Unqualified Display title call site: "+offset);
                                        titleSites[0]++;
                                        code.invokestatic(HOST,"setWindowTitle",call.typeSymbol());
                                    }else code.with(instruction);
                                }));
                                changes.add("setTitle(Ljava/lang/String;)V:GLFW.glfwSetWindowTitle@16->setWindowTitle");return;
                            }
                            if(display&&methodName.equals("<clinit>")){
                                changes.add("<clinit>:preserved+browser-capabilities");
                                builder.transformMethod(method,MethodTransform.transformingCode((code,instruction)->{
                                    if(instruction instanceof ReturnInstruction ret&&ret.typeKind()==TypeKind.VOID)
                                        code.invokestatic(HOST,"getCapabilities",MethodTypeDesc.of(CAPS)).putstatic(ClassDesc.of("org.lwjglx.opengl.Display"),"capabilities",CAPS);
                                    code.with(instruction);
                                }));return;
                            }
                            if(methodName.equals("<clinit>")&&(gl||memory||api)){
                                changes.add("<clinit>:browser-platform");
                                builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask(),code->{
                                    if(api)code.invokestatic(HOST,"initialize",MethodTypeDesc.of(ConstantDescs.CD_void));
                                    if(memory)code.ldc(65536).putstatic(ClassDesc.of("org.lwjgl.system.MemoryUtil"),"PAGE_SIZE",ConstantDescs.CD_int);
                                    code.return_();
                                });return;
                            }
                            boolean selected=(method.flags().flagsMask()&0x8)!=0&&((gl&&methods.contains(helper+descriptor))||(legacyAttributes&&Set.of("glAlphaFunc(IF)V","glPushAttrib(I)V","glPopAttrib()V","glPushClientAttrib(I)V","glPopClientAttrib()V","glPolygonMode(II)V","glTexEnvi(III)V","glDisableClientState(I)V","glEnableClientState(I)V","glLineWidth(F)V","glFrontFace(I)V").contains(methodName+descriptor)&&methods.contains(helper+descriptor))||(memory&&Set.of("memAlloc","memAllocFloat","memAllocInt","memAllocShort","memRealloc","memFree","memSet","memCopy").contains(helper)&&methods.contains(helper+descriptor))
                                    ||(api&&Set.of("initialize","getCapabilities").contains(helper)&&methods.contains(helper+descriptor))
                                    ||(display&&Set.of("swapBuffers","isCreated","makeCurrent","releaseContext","setVSyncEnabled","processMessages","isActive","isVisible","isCloseRequested","wasResized","getWidth","getHeight","getX","getY","getAvailableDisplayModes","isFullscreen","getDesktopDisplayMode","getFramebufferWidth","getFramebufferHeight").contains(helper)&&methods.contains(helper+descriptor)));
                            if(!selected){builder.with(element);return;}
                            changes.add(methodName+descriptor+"->"+helper);
                            builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask()&~0x100,code->{
                                var type=method.methodTypeSymbol();int slot=0;
                                for(ClassDesc parameter:type.parameterList()){
                                    switch(parameter.descriptorString().charAt(0)){
                                        case 'J'->code.lload(slot);case 'D'->code.dload(slot);case 'F'->code.fload(slot);case 'L','['->code.aload(slot);default->code.iload(slot);
                                    }slot+=parameter.equals(ConstantDescs.CD_long)||parameter.equals(ConstantDescs.CD_double)?2:1;
                                }
                                code.invokestatic(HOST,helper,type);
                                switch(type.returnType().descriptorString().charAt(0)){
                                    case 'V'->code.return_();case 'J'->code.lreturn();case 'D'->code.dreturn();case 'F'->code.freturn();case 'L','['->code.areturn();default->code.ireturn();
                                }
                            });
                        });
                        if(name.equals("org/lwjgl/opengl/GLCapabilities")){
                            bytes=cf.transformClass(cf.parse(bytes),(builder,element)->builder.with(element));
                            bytes=cf.transformClass(cf.parse(bytes),new ClassTransform(){
                                public void accept(ClassBuilder builder,ClassElement element){builder.with(element);}
                                public void atEnd(ClassBuilder builder){builder.withMethodBody("<init>",MethodTypeDesc.of(ConstantDescs.CD_void,ConstantDescs.CD_boolean),0x1,code->code.aload(0).invokespecial(ConstantDescs.CD_Object,"<init>",MethodTypeDesc.of(ConstantDescs.CD_void)).aload(0).iload(1).putfield(CAPS,"GL_ARB_vertex_buffer_object",ConstantDescs.CD_boolean).aload(0).invokestatic(HOST,"framebufferSupported",MethodTypeDesc.of(ConstantDescs.CD_boolean)).putfield(CAPS,"GL_ARB_framebuffer_object",ConstantDescs.CD_boolean).return_());}
                            });changes.add("<init>(Z):bounded-ARB-buffer-descriptor");
                        }
                    }
                    if(display&&titleSites[0]!=1)throw new IllegalArgumentException("Expected one vendor title call site");
                    if(gl||legacyAttributes||memory||api||display||name.equals("org/lwjgl/opengl/GLCapabilities"))constructorChecks+=verifyConstructors(model,bytes);
                    if(name.startsWith("zombie/")){gameClasses[0]++;if(!Arrays.equals(original,bytes))throw new AssertionError("Original game class changed: "+name);}
                    if(!Arrays.equals(original,bytes))changed.add("{\"class\":"+quote(name)+",\"inputSha256\":"+quote(hash(original))+",\"outputSha256\":"+quote(hash(bytes))+",\"methods\":["+String.join(",",changes.stream().map(PrepareSpriteGraphics::quote).toList())+"]}");
                }
                var copy=new ZipEntry(entry.getName());if(entry.getTime()>=0)copy.setTime(entry.getTime());result.putNextEntry(copy);result.write(bytes);result.closeEntry();
            }
            try(var paths=Files.walk(authored)){
                for(Path file:paths.filter(path->path.toString().endsWith(".class")).toList()){
                    String entry=authored.relativize(file).toString().replace('\\','/');
                    if(!entry.startsWith("port/host/Sprite")&&!entry.startsWith("probe/CheerpJSprite")&&!entry.startsWith("probe/CheerpJCharacterShader"))continue;
                    if(jar.getEntry(entry)!=null)throw new IllegalArgumentException("Authored class collision: "+entry);
                    byte[]bytes=Files.readAllBytes(file);
                    if(entry.equals("port/host/SpriteGraphics.class"))bytes=cf.transformClass(cf.parse(bytes),(builder,element)->{
                        if(element instanceof MethodModel method&&method.methodName().equalsString("newDescriptor"))builder.withMethodBody(method.methodName(),method.methodType(),method.flags().flagsMask()&~0x100,code->code.new_(CAPS).dup().iconst_1().invokespecial(CAPS,"<init>",MethodTypeDesc.of(ConstantDescs.CD_void,ConstantDescs.CD_boolean)).areturn());else builder.with(element);
                    });
                    result.putNextEntry(new ZipEntry(entry));result.write(bytes);result.closeEntry();
                }
            }
        }
        Files.writeString(output.resolve("sprite-graphics-manifest.json"),"{\"vendorConstructorBodiesPreserved\":"+constructorChecks+",\"forbiddenStaticConstructorCalls\":0,\"gameMethodBodiesUnchanged\":true,\"unchangedGameClasses\":"+gameClasses[0]+",\"nativePointerABI\":false,\"desktopGLVersionsAdvertised\":false,\"boundedArbBufferFacade\":true,\"adaptedVendorClasses\":["+String.join(",",changed)+"]}\n");
        System.out.println("Prepared original sprite graphics view with "+changed.size()+" vendor adapters and "+gameClasses[0]+" unchanged game classes");
    }
}
