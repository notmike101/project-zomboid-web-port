import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassTransform;
import java.lang.classfile.CodeBuilder;
import java.lang.classfile.Instruction;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.ConstantDescs;
import java.lang.constant.MethodTypeDesc;
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

/** Restores pinned original vendor event code around real browser boundaries; no game body changes. */
public final class PrepareDisplayEvents {
    private static final ClassDesc DISPLAY = ClassDesc.of("org.lwjglx.opengl.Display");
    private static final ClassDesc CALLBACKS = ClassDesc.of("org.lwjglx.opengl.Display$Callbacks");
    private static final ClassDesc HOST = ClassDesc.of("port.host.BrowserDisplayEvents");
    private static final Set<String> GETTERS = Set.of("isActive", "isVisible", "wasResized", "getWidth", "getHeight",
        "getFramebufferWidth", "getFramebufferHeight", "getX", "getY");
    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static byte[] read(String jar, String name) throws Exception {
        try (var zip = new ZipFile(jar); var in = zip.getInputStream(zip.getEntry(name))) {
            return in.readAllBytes();
        }
    }
    private static void distinct(Path first, Path second) throws Exception {
        if (first.equals(second) || Files.exists(first) && Files.exists(second) && Files.isSameFile(first, second)) {
            throw new IllegalArgumentException("Display donor, input, output and manifest must be distinct files");
        }
    }
    /** Call the original pair callback only when its actual cached pair changes. */
    private static void changedPair(CodeBuilder code, int first, int second, String fieldA, String fieldB, String callback) {
        code.iload(first).getstatic(DISPLAY, fieldA, ConstantDescs.CD_int)
            .ifThenElse(Opcode.IF_ICMPEQ,
                equal -> equal.iload(second).getstatic(DISPLAY, fieldB, ConstantDescs.CD_int)
                    .ifThen(Opcode.IF_ICMPNE, changed -> changed.lconst_0().iload(first).iload(second)
                        .invokestatic(CALLBACKS, callback, MethodTypeDesc.ofDescriptor("(JII)V"))),
                changed -> changed.lconst_0().iload(first).iload(second)
                    .invokestatic(CALLBACKS, callback, MethodTypeDesc.ofDescriptor("(JII)V")));
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("donor runtime, prepared input overlay, output, manifest");
        var paths = Arrays.stream(args).map(value -> Path.of(value).toAbsolutePath().normalize()).toList();
        for (int first = 0; first < paths.size(); first++) {
            for (int second = first + 1; second < paths.size(); second++) distinct(paths.get(first), paths.get(second));
        }
        // Reject aliases before opening any input or output stream.
        args = paths.stream().map(Path::toString).toArray(String[]::new);
        byte[] donorBytes = read(args[0], "org/lwjglx/opengl/Display.class");
        byte[] input = read(args[1], "org/lwjglx/opengl/Display.class");
        if (!hash(read(args[0], "org/lwjglx/opengl/Display$Callbacks.class"))
                .equals("9374647c62240122fc7c6324804c04d15be4918c89dbe57c0584dedf9020f818")) {
            throw new IllegalArgumentException("Unqualified original callback nestmate");
        }
        if (!hash(donorBytes).equals("6a9dc0e2e2b11ce6d952ae1653dc29ef899ccb3403ed85c93a2898580986c89a")
                || !hash(input).equals("0575d57233374a3e4a4cfa1457c544d4aa919203a65b8f117f1aa6cb0dd9302c")) {
            throw new IllegalArgumentException("Unqualified exact Display donor/input composition");
        }
        var api = ClassFile.of();
        var donor = api.parse(donorBytes);
        var source = api.parse(input);
        var changes = new ArrayList<String>();
        int[] redirects = {0};
        byte[] output = api.transformClass(source, (builder, element) -> {
            if (!(element instanceof MethodModel method)) { builder.with(element); return; }
            String name = method.methodName().stringValue();
            if (name.equals("browserPublishEvents")) throw new IllegalArgumentException("Bridge collision");
            var original = donor.methods().stream().filter(m -> m.methodName().equalsString(name)
                && m.methodType().equalsString(method.methodType().stringValue())).findFirst().orElseThrow();
            if (GETTERS.contains(name)) {
                builder.with(original);
                changes.add(name + ":original-cache-getter");
                return;
            }
            if (name.equals("processMessages")) {
                int[] bci = {0};
                builder.transformMethod(original, MethodTransform.transformingCode((code, instruction) -> {
                    int offset = bci[0];
                    if (instruction instanceof Instruction operation) bci[0] += operation.sizeInBytes();
                    if (instruction instanceof InvokeInstruction call && Set.of(0, 3, 6, 107).contains(offset)) {
                        String target = switch (offset) { case 0 -> "pollEvents"; case 3, 6 -> "poll"; default -> "windowAttrib"; };
                        ClassDesc owner = offset == 3 ? ClassDesc.of("port.host.BrowserKeyboardEvents")
                            : offset == 6 ? ClassDesc.of("port.host.BrowserMouse")
                            : offset == 0 ? ClassDesc.of("port.host.BrowserControllers") : HOST;
                        String expected = switch (offset) { case 0 -> "glfwPollEvents"; case 3, 6 -> "poll"; default -> "glfwGetWindowAttrib"; };
                        if (call.opcode() != Opcode.INVOKESTATIC || !call.name().equalsString(expected))
                            throw new IllegalArgumentException("Unexpected original processMessages callsite");
                        code.invokestatic(owner, target, call.typeSymbol());
                        redirects[0]++;
                        changes.add("processMessages@" + offset + "->" + owner.displayName() + "." + target);
                    } else code.with(instruction);
                }));
                return;
            }
            if (name.equals("updateMouseCursor")) {
                boolean[] first = {true}; int[] bci = {0};
                builder.transformMethod(original, MethodTransform.transformingCode((code, instruction) -> {
                    int offset = bci[0];
                    if (instruction instanceof Instruction operation) {
                        bci[0] += operation.sizeInBytes();
                        if (first[0]) {
                            code.getstatic(DISPLAY, "mouseCursorState", ConstantDescs.CD_int)
                                .invokestatic(HOST, "checkCursorState", MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_int));
                            first[0] = false;
                        }
                    }
                    if (instruction instanceof InvokeInstruction call && offset == 80) {
                        if (!call.name().equalsString("glfwSetInputMode")) throw new IllegalArgumentException("Cursor callsite changed");
                        code.invokestatic(HOST, "setInputMode", call.typeSymbol());
                        redirects[0]++;
                    } else code.with(instruction);
                }));
                changes.add("updateMouseCursor:preflight-before-cache+setInputMode@80");
                return;
            }
            builder.with(element);
        }).clone();
        if (redirects[0] != 5 || changes.size() != 14) throw new IllegalArgumentException("Exact restoration selectors missing");
        final byte[] restored = output;
        // Append the nestmate producer while preserving all existing metadata/methods.
        byte[] withBridge = api.transformClass(api.parse(restored), ClassTransform.endHandler(builder -> {
            builder.withMethodBody("browserPublishEvents", MethodTypeDesc.ofDescriptor("(IIIIIIII)V"), 0x0009, code -> {
                // Original callback bodies retain their own guards/logs and exact field semantics.
                changedPair(code, 0, 1, "latestWidth", "latestHeight", "lambda$initCallbacks$3");
                changedPair(code, 2, 3, "displayFramebufferWidth", "displayFramebufferHeight", "lambda$initCallbacks$7");
                changedPair(code, 4, 5, "displayX", "displayY", "lambda$initCallbacks$5");
                code.iload(6).getstatic(DISPLAY, "displayVisible", ConstantDescs.CD_boolean)
                    .ifThen(Opcode.IF_ICMPNE, changed -> changed.lconst_0().iload(6).iconst_1().ixor()
                        .invokestatic(CALLBACKS, "lambda$initCallbacks$2", MethodTypeDesc.ofDescriptor("(JZ)V")))
                    .iload(7).ifThen(Opcode.IFNE, dirty -> dirty.lconst_0()
                        .invokestatic(CALLBACKS, "lambda$initCallbacks$6", MethodTypeDesc.ofDescriptor("(J)V"))).return_();
            });
        }));
        int unchanged = 0;
        var emitted = api.parse(withBridge);
        for (var before : source.methods()) {
            String name = before.methodName().stringValue();
            if (GETTERS.contains(name) || name.equals("processMessages") || name.equals("updateMouseCursor")) continue;
            var after = emitted.methods().stream().filter(m -> m.methodName().equalsString(name)
                && m.methodType().equalsString(before.methodType().stringValue())).findFirst().orElseThrow();
            var a = before.findAttribute(java.lang.classfile.Attributes.code());
            var b = after.findAttribute(java.lang.classfile.Attributes.code());
            if (a.isPresent() != b.isPresent() || a.isPresent() && !Arrays.equals(a.get().codeArray(), b.orElseThrow().codeArray()))
                throw new AssertionError("Unselected original/prepared method code changed: " + name);
            unchanged++;
        }
        if (!api.verify(withBridge).isEmpty()) throw new AssertionError(api.verify(withBridge).toString());
        try (var zip = new ZipOutputStream(Files.newOutputStream(Path.of(args[2])))) {
            zip.putNextEntry(new ZipEntry("org/lwjglx/opengl/Display.class")); zip.write(withBridge); zip.closeEntry();
        }
        Files.writeString(Path.of(args[3]), "{\"class\":\"org/lwjglx/opengl/Display\",\"donorSha256\":\"" + hash(donorBytes)
            + "\",\"inputSha256\":\"" + hash(input) + "\",\"outputSha256\":\"" + hash(withBridge)
            + "\",\"callbackSha256\":\"9374647c62240122fc7c6324804c04d15be4918c89dbe57c0584dedf9020f818\""
            + ",\"redirects\":" + redirects[0] + ",\"unchangedOtherMethods\":" + unchanged
            + ",\"verifiedClassFile\":true,\"gameClassesEmitted\":0,\"changes\":["
            + String.join(",", changes.stream().map(value -> "\"" + value + "\"").toList()) + "]}");
    }
}
