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

/** Redirects one pinned vendor button query, preserving original queue and polling code. */
public final class PrepareMouse {

    private static final String INPUT_SHA =
        "222c9f1d55624bb6749b1888437ad32f6b7c74b09a812c616b4b4c76a437df24";

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
            var entry = zip.getEntry("org/lwjglx/input/Mouse.class");
            if (entry == null) throw new IllegalArgumentException(
                "Missing vendor Mouse class"
            );
            try (var stream = zip.getInputStream(entry)) {
                source = stream.readAllBytes();
            }
        }
        String beforeHash = hash(source);
        if (!beforeHash.equals(INPUT_SHA)) throw new IllegalArgumentException(
            "Unqualified vendor Mouse source: " + beforeHash
        );
        var api = ClassFile.of();
        int[] sites = { 0 };
        byte[] result = api.transformClass(
            api.parse(source),
            (builder, element) -> {
                if (
                    element instanceof MethodModel method &&
                    method.methodName().equalsString("isButtonDown") &&
                    method.methodType().equalsString("(I)Z")
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
                                        .equalsString("glfwGetMouseButton") &&
                                    call.type().equalsString("(JI)I")
                                ) {
                                    if (
                                        offset != 4
                                    ) throw new IllegalArgumentException(
                                        "Unqualified Mouse BCI: " + offset
                                    );
                                    sites[0]++;
                                    code.invokestatic(
                                        ClassDesc.of("port.host.BrowserMouse"),
                                        "button",
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
            "Expected exactly one vendor button query"
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
                    method.methodName().equalsString("isButtonDown") &&
                    method.methodType().equalsString("(I)Z") &&
                    (i == 5 || i == 6);
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
            var entry = new ZipEntry("org/lwjglx/input/Mouse.class");
            entry.setTime(0);
            zip.putNextEntry(entry);
            zip.write(result);
            zip.closeEntry();
        }
        Files.writeString(
            manifest,
            "{\"class\":\"org/lwjglx/input/Mouse\",\"inputClassSha256\":\"" +
                beforeHash +
                "\",\"outputClassSha256\":\"" +
                hash(result) +
                "\",\"method\":\"isButtonDown(I)Z\",\"originalBCI\":4,\"redirect\":\"org/lwjgl/glfw/GLFW.glfwGetMouseButton(JI)I -> port/host/BrowserMouse.button(JI)I\",\"gameClassesChanged\":false,\"allOtherInstructionsUnchanged\":true}"
        );
    }
}
