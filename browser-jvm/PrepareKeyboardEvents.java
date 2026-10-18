import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.Instruction;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.constant.ConstantDescs;
import java.lang.constant.MethodTypeDesc;
import java.util.Arrays;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Adapts the pinned input startup platform, preserving original keyboard queue and polling code. */
public final class PrepareKeyboardEvents {

    private static final String INPUT_SHA =
        "31cc6df18d521a02a4752eb15169f72b188483cd62c10483a97872d2ddf0b9cd";

    private record DisplayAdapter(byte[] bytes, String manifest) {}

    /** Browser startup belongs to this input overlay: graphics-only profiles retain their original unsupported init. */
    private static DisplayAdapter adaptDisplay(byte[] input) throws Exception {
        String beforeHash = hash(input);
        if (!beforeHash.equals("66a404a9b1ea05a8e06a717d2b61de95a421f44f82299952f5737787ddc6b082"))
            throw new IllegalArgumentException("Unqualified graphics-adapted Display source: " + beforeHash);
        var api = ClassFile.of();
        var original = api.parse(input);
        var display = ClassDesc.of("org.lwjglx.opengl.Display");
        var host = ClassDesc.of("port.host.SpriteGraphics");
        var mode = ClassDesc.of("org.lwjglx.opengl.DisplayMode");
        var failure = ClassDesc.of("java.lang.IllegalStateException");
        int[] sites = {0};
        byte[] output = api.transformClass(original, (builder, element) -> {
            if (!(element instanceof MethodModel method) || !method.methodName().equalsString("init")
                    || !method.methodType().equalsString("()V")) {
                builder.with(element);
                return;
            }
            sites[0]++;
            builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask(), code -> {
                // Retain the original guard/assignment, then initialize the browser platform and original producer.
                code.getstatic(display, "isInitialized", ConstantDescs.CD_boolean)
                    .ifThen(Opcode.IFNE, branch -> branch.new_(failure).dup()
                        .ldc("Display has already been initialized.")
                        .invokespecial(failure, "<init>", MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_String)).athrow())
                    .iconst_1().putstatic(display, "isInitialized", ConstantDescs.CD_boolean)
                    .invokestatic(host, "contextCreated", MethodTypeDesc.of(ConstantDescs.CD_boolean))
                    .ifThen(Opcode.IFEQ, branch -> branch.new_(failure).dup().ldc("Browser graphics context is destroyed")
                        .invokespecial(failure, "<init>", MethodTypeDesc.of(ConstantDescs.CD_void, ConstantDescs.CD_String)).athrow())
                    .invokestatic(host, "getCapabilities", MethodTypeDesc.of(ClassDesc.of("org.lwjgl.opengl.GLCapabilities"))).pop()
                    .invokestatic(ClassDesc.of("org.lwjglx.input.Keyboard"), "create", MethodTypeDesc.of(ConstantDescs.CD_void))
                    .invokestatic(host, "getDesktopDisplayMode", MethodTypeDesc.of(mode))
                    .putstatic(display, "desktopDisplayMode", mode).return_();
            });
        });
        if (sites[0] != 1) throw new IllegalArgumentException("Expected one Display.init selector");
        var emitted = api.parse(output);
        int unchanged = 0;
        for (var before : original.methods()) {
            if (before.methodName().equalsString("init") && before.methodType().equalsString("()V")) continue;
            var after = emitted.methods().stream().filter(method -> method.methodName().equalsString(before.methodName().stringValue())
                && method.methodType().equalsString(before.methodType().stringValue())).findFirst().orElseThrow();
            var beforeCode = before.findAttribute(Attributes.code());
            var afterCode = after.findAttribute(Attributes.code());
            if (beforeCode.isPresent() != afterCode.isPresent() || beforeCode.isPresent()
                    && !Arrays.equals(beforeCode.get().codeArray(), afterCode.orElseThrow().codeArray()))
                throw new AssertionError("Other Display method changed: " + before.methodName());
            unchanged++;
        }
        return new DisplayAdapter(output, "{\"class\":\"org/lwjglx/opengl/Display\",\"method\":\"init()V\",\"inputSha256\":\""
            + beforeHash + "\",\"outputSha256\":\"" + hash(output) + "\",\"unchangedOtherMethods\":" + unchanged
            + ",\"gameClassesChanged\":false,\"monitorHandleManufactured\":false,\"keyboardCreateOriginal\":true}");
    }

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(bytes)
        );
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException(
            "inputJar outputJar manifest"
        );
        Path input = Path.of(args[0]).toRealPath(),
            output = Path.of(args[1]).toAbsolutePath().normalize(),
            manifest = Path.of(args[2]).toAbsolutePath().normalize();
        if (
            input.equals(output) ||
            input.equals(manifest) ||
            output.equals(manifest) ||
            (Files.exists(output) && Files.isSameFile(input, output)) ||
            (Files.exists(manifest) && Files.isSameFile(input, manifest))
        ) throw new IllegalArgumentException("Input/output alias");
        byte[] source;
        DisplayAdapter display;
        try (var zip = new ZipFile(input.toFile())) {
            var entry = zip.getEntry("org/lwjglx/input/Keyboard.class");
            if (entry == null) throw new IllegalArgumentException(
                "Missing vendor Keyboard class"
            );
            try (var stream = zip.getInputStream(entry)) {
                source = stream.readAllBytes();
            }
            var displayEntry = zip.getEntry("org/lwjglx/opengl/Display.class");
            if (displayEntry == null) throw new IllegalArgumentException("Missing graphics-adapted Display class");
            try (var stream = zip.getInputStream(displayEntry)) {
                display = adaptDisplay(stream.readAllBytes());
            }
        }
        String beforeHash = hash(source);
        if (!beforeHash.equals(INPUT_SHA)) throw new IllegalArgumentException(
            "Unqualified vendor Keyboard source: " + beforeHash
        );
        var api = ClassFile.of();
        int[] sites = { 0 };
        byte[] result = api.transformClass(
            api.parse(source),
            (builder, element) -> {
                if (
                    element instanceof MethodModel method &&
                    method.methodName().equalsString("initKeyNames") &&
                    method.methodType().equalsString("()V")
                ) {
                    int[] bci = { 0 };
                    builder.transformMethod(
                        method,
                        MethodTransform.transformingCode(
                            (code, elementCode) -> {
                                int offset = bci[0];
                                if (
                                    elementCode instanceof Instruction operation
                                ) bci[0] += operation.sizeInBytes();
                                if (
                                    elementCode instanceof
                                        InvokeInstruction call &&
                                    call.opcode() == Opcode.INVOKESTATIC &&
                                    call
                                        .owner()
                                        .asInternalName()
                                        .equals("org/lwjgl/glfw/GLFW") &&
                                    call
                                        .name()
                                        .equalsString("glfwGetKeyScancode") &&
                                    call.type().equalsString("(I)I")
                                ) {
                                    if (
                                        offset != 288
                                    ) throw new IllegalArgumentException(
                                        "Unqualified Keyboard BCI: " + offset
                                    );
                                    sites[0]++;
                                    code.invokestatic(
                                        ClassDesc.of("port.host.BrowserKeyboardEvents"),
                                        "unavailableScancode",
                                        call.typeSymbol()
                                    );
                                } else code.with(elementCode);
                            }
                        )
                    );
                } else builder.with(element);
            }
        );
        if (sites[0] != 1) throw new IllegalArgumentException(
            "Expected exactly one vendor key-name scancode query"
        );
        var adapted = api.parse(result);
        for (var method : api.parse(source).methods()) {
            if (method.code().isEmpty()) continue;
            var next = adapted
                .methods()
                .stream()
                .filter(
                    value ->
                        value
                            .methodName()
                            .equalsString(method.methodName().stringValue()) &&
                        value
                            .methodType()
                            .equalsString(method.methodType().stringValue())
                )
                .findFirst()
                .orElseThrow();
            byte[] before = method
                    .findAttribute(Attributes.code())
                    .orElseThrow()
                    .codeArray(),
                after = next
                    .findAttribute(Attributes.code())
                    .orElseThrow()
                    .codeArray();
            if (before.length != after.length) throw new AssertionError(
                "Method length changed"
            );
            for (int i = 0; i < before.length; i++) {
                boolean operand =
                    method.methodName().equalsString("initKeyNames") &&
                    method.methodType().equalsString("()V") &&
                    (i == 289 || i == 290);
                if (!operand && before[i] != after[i]) throw new AssertionError(
                    "Unexpected vendor instruction change: " +
                        method.methodName() +
                        " BCI " +
                        i
                );
            }
        }
        Files.createDirectories(output.getParent());
        try (var zip = new ZipOutputStream(Files.newOutputStream(output))) {
            var entry = new ZipEntry("org/lwjglx/input/Keyboard.class");
            entry.setTime(0);
            zip.putNextEntry(entry);
            zip.write(result);
            zip.closeEntry();
            var displayEntry = new ZipEntry("org/lwjglx/opengl/Display.class");
            displayEntry.setTime(0);
            zip.putNextEntry(displayEntry);
            zip.write(display.bytes());
            zip.closeEntry();
        }
        Files.writeString(
            manifest,
            "{\"class\":\"org/lwjglx/input/Keyboard\",\"inputClassSha256\":\"" +
                beforeHash +
                "\",\"outputClassSha256\":\"" +
                hash(result) +
                "\",\"method\":\"initKeyNames()V\",\"originalBCI\":288,\"redirect\":\"org/lwjgl/glfw/GLFW.glfwGetKeyScancode(I)I -> port.host.BrowserKeyboardEvents.unavailableScancode(I)I\",\"gameClassesChanged\":false,\"allOtherInstructionsUnchanged\":true,\"display\":" + display.manifest() + "}"
        );
    }
}
