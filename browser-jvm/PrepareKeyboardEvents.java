import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.Instruction;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Redirects one pinned vendor key-name scancode query, preserving original queue and polling code. */
public final class PrepareKeyboardEvents {

    private static final String INPUT_SHA =
        "31cc6df18d521a02a4752eb15169f72b188483cd62c10483a97872d2ddf0b9cd";

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
        try (var zip = new ZipFile(input.toFile())) {
            var entry = zip.getEntry("org/lwjglx/input/Keyboard.class");
            if (entry == null) throw new IllegalArgumentException(
                "Missing vendor Keyboard class"
            );
            try (var stream = zip.getInputStream(entry)) {
                source = stream.readAllBytes();
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
        }
        Files.writeString(
            manifest,
            "{\"class\":\"org/lwjglx/input/Keyboard\",\"inputClassSha256\":\"" +
                beforeHash +
                "\",\"outputClassSha256\":\"" +
                hash(result) +
                "\",\"method\":\"initKeyNames()V\",\"originalBCI\":288,\"redirect\":\"org/lwjgl/glfw/GLFW.glfwGetKeyScancode(I)I -> port.host.BrowserKeyboardEvents.unavailableScancode(I)I\",\"gameClassesChanged\":false,\"allOtherInstructionsUnchanged\":true}"
        );
    }
}
