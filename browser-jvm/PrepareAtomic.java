import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.Instruction;
import java.lang.classfile.MethodModel;
import java.lang.classfile.MethodTransform;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Qualified LazyValue compatibility and two exact vendor clock call adaptations. */
public final class PrepareAtomic {

    private static final String LAZY_SHA =
        "9bb28825fe39df5aef074d6d5fa593d4b9545db151fc5d675a668f620b097290";
    private static final String SYS_SHA =
        "451f856cf21998df2b57862357922ac0801680fc29aa26a7574a55e744fa5d17";
    private static final Set<String> CLOCK_METHODS = Set.of(
        "getTime",
        "getNanoTime"
    );

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(bytes)
        );
    }

    private static byte[] read(ZipFile zip, String name) throws Exception {
        var entry = zip.getEntry(name);
        if (entry == null) throw new IllegalArgumentException(
            "Missing qualified class: " + name
        );
        try (var stream = zip.getInputStream(entry)) {
            return stream.readAllBytes();
        }
    }

    private static byte[] clock(byte[] source) throws Exception {
        if (!hash(source).equals(SYS_SHA)) throw new IllegalArgumentException(
            "Unqualified vendor Sys clock source: " + hash(source)
        );
        var api = ClassFile.of();
        var original = api.parse(source);
        int[] sites = { 0 };
        byte[] result = api.transformClass(original, (builder, element) -> {
            if (
                element instanceof MethodModel method &&
                CLOCK_METHODS.contains(method.methodName().stringValue()) &&
                method.methodType().equalsString("()J")
            ) {
                int[] bci = { 0 };
                int[] methodSites = { 0 };
                builder.transformMethod(
                    method,
                    MethodTransform.transformingCode((code, instruction) -> {
                        int offset = bci[0];
                        if (
                            instruction instanceof Instruction operation
                        ) bci[0] += operation.sizeInBytes();
                        if (
                            instruction instanceof InvokeInstruction call &&
                            call.opcode() == Opcode.INVOKESTATIC &&
                            call
                                .owner()
                                .asInternalName()
                                .equals("org/lwjgl/glfw/GLFW") &&
                            call.name().equalsString("glfwGetTime") &&
                            call.type().equalsString("()D")
                        ) {
                            if (offset != 0) throw new IllegalArgumentException(
                                "Unqualified clock BCI: " + offset
                            );
                            code.invokestatic(
                                ClassDesc.of("port.host.BrowserClock"),
                                "seconds",
                                call.typeSymbol()
                            );
                            methodSites[0]++;
                            sites[0]++;
                        } else code.with(instruction);
                    })
                );
                if (methodSites[0] != 1) throw new IllegalArgumentException(
                    "Expected exactly one clock call in " + method.methodName()
                );
            } else builder.with(element);
        });
        if (sites[0] != 2) throw new IllegalArgumentException(
            "Expected exactly two vendor clock sites: " + sites[0]
        );
        var adapted = api.parse(result);
        for (var method : original.methods()) {
            var next = adapted
                .methods()
                .stream()
                .filter(
                    candidate ->
                        candidate
                            .methodName()
                            .equalsString(method.methodName().stringValue()) &&
                        candidate
                            .methodType()
                            .equalsString(method.methodType().stringValue())
                )
                .findFirst()
                .orElseThrow();
            byte[] before = method
                .findAttribute(Attributes.code())
                .orElseThrow()
                .codeArray();
            byte[] after = next
                .findAttribute(Attributes.code())
                .orElseThrow()
                .codeArray();
            int prefix = CLOCK_METHODS.contains(
                method.methodName().stringValue()
            )
                ? 3
                : 0;
            if (
                !Arrays.equals(
                    Arrays.copyOfRange(before, prefix, before.length),
                    Arrays.copyOfRange(after, prefix, after.length)
                )
            ) {
                throw new IllegalArgumentException(
                    "Unqualified extra vendor Sys instruction change: " +
                        method.methodName()
                );
            }
        }
        return result;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException(
            "inputView outputView manifest"
        );
        Path input = Path.of(args[0]).toRealPath();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        if (
            input.equals(output) ||
            (Files.exists(output) && Files.isSameFile(input, output))
        ) throw new IllegalArgumentException("Input/output alias");
        int[] count = { 0 };
        String before;
        String after;
        String clockBefore;
        String clockAfter;
        try (var zip = new ZipFile(input.toFile())) {
            byte[] lazy = read(zip, "zombie/util/LazyValue.class");
            before = hash(lazy);
            if (!before.equals(LAZY_SHA)) throw new IllegalArgumentException(
                "Unqualified LazyValue atomic boundary: " + before
            );
            byte[] sys = read(zip, "org/lwjglx/Sys.class");
            clockBefore = hash(sys);
            byte[] adaptedSys = clock(sys);
            clockAfter = hash(adaptedSys);
            var cf = ClassFile.of();
            byte[] adaptedLazy = cf.transformClass(
                cf.parse(lazy),
                (builder, element) -> {
                    if (
                        element instanceof MethodModel method &&
                        method.methodName().equalsString("get") &&
                        method.methodType().equalsString("()Ljava/lang/Object;")
                    ) {
                        builder.transformMethod(
                            method,
                            MethodTransform.transformingCode(
                                (code, instruction) -> {
                                    if (
                                        instruction instanceof
                                            InvokeInstruction call &&
                                        call
                                            .owner()
                                            .asInternalName()
                                            .equals(
                                                "java/lang/invoke/VarHandle"
                                            ) &&
                                        call
                                            .name()
                                            .equalsString(
                                                "compareAndExchange"
                                            ) &&
                                        call
                                            .type()
                                            .equalsString(
                                                "(Lzombie/util/LazyValue;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;"
                                            )
                                    ) {
                                        count[0]++;
                                        code.invokestatic(
                                            ClassDesc.of(
                                                "port.host.ReferenceExchange"
                                            ),
                                            "compareAndExchange",
                                            MethodTypeDesc.ofDescriptor(
                                                "(Ljava/lang/invoke/VarHandle;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;"
                                            )
                                        );
                                    } else code.with(instruction);
                                }
                            )
                        );
                    } else builder.with(element);
                }
            );
            after = hash(adaptedLazy);
            if (count[0] != 1) throw new IllegalArgumentException(
                "Expected one LazyValue reference compareAndExchange: " +
                    count[0]
            );
            try (
                var target = new ZipOutputStream(Files.newOutputStream(output))
            ) {
                var entries = zip.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    byte[] bytes = read(zip, entry.getName());
                    if (
                        entry.getName().equals("zombie/util/LazyValue.class")
                    ) bytes = adaptedLazy;
                    if (entry.getName().equals("org/lwjglx/Sys.class")) bytes =
                        adaptedSys;
                    var copy = new ZipEntry(entry.getName());
                    if (entry.getTime() >= 0) copy.setTime(entry.getTime());
                    if (entry.getComment() != null) copy.setComment(
                        entry.getComment()
                    );
                    if (entry.getExtra() != null) copy.setExtra(
                        entry.getExtra()
                    );
                    target.putNextEntry(copy);
                    target.write(bytes);
                    target.closeEntry();
                }
            }
        }
        Files.writeString(
            Path.of(args[2]),
            "{\"entry\":\"zombie/util/LazyValue.class\",\"method\":\"get()Ljava/lang/Object;\",\"originalBCI\":35,\"sites\":1,\"from\":\"VarHandle.compareAndExchange(Lzombie/util/LazyValue;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;\",\"to\":\"port.host.ReferenceExchange.compareAndExchange(VarHandle,Object,Object,Object)\",\"inputViewSha256\":\"" +
                before +
                "\",\"outputViewSha256\":\"" +
                after +
                "\",\"gameMethodBodyBytesUnchanged\":false,\"originalAlgorithmPreserved\":true,\"vendorClock\":{\"entry\":\"org/lwjglx/Sys.class\",\"inputClassSha256\":\"" +
                clockBefore +
                "\",\"outputClassSha256\":\"" +
                clockAfter +
                "\",\"from\":\"org.lwjgl.glfw.GLFW.glfwGetTime()D\",\"to\":\"port.host.BrowserClock.seconds()D\",\"sites\":[{\"method\":\"getTime()J\",\"originalBCI\":0},{\"method\":\"getNanoTime()J\",\"originalBCI\":0}],\"otherVendorInstructionsUnchanged\":true,\"additionalGameChanges\":false}}\n"
        );
    }
}
