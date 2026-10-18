import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.FieldModel;
import java.lang.classfile.MethodModel;
import java.lang.constant.ClassDesc;
import java.lang.constant.MethodTypeDesc;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Exact vendor selectors for the qualified keyboard-only original RenderThread.init component. */
public final class PrepareControllers {
    private static final ClassDesc HOST = ClassDesc.of("port.host.BrowserControllers");
    private static final Map<String, String> PINS = Map.of(
        "org/lwjgl/glfw/GLFW", "39f4a0dd2b90bc9491915a09cf95f1c3a89d291319468250ef76e8208f4c2f65",
        "org/lwjgl/glfw/GLFWJoystickCallbackI", "28c0846548709e8c005e23678c279cfcd9a061a7f3ba6eecd3b71c0e9cfc3a58",
        "org/lwjgl/system/MemoryUtil", "cbd2baf69fea5a108f455716fe1a625ede97a83d16fd8d2c6dcea8e785b220de",
        "org/lwjglx/opengl/Display", "0575d57233374a3e4a4cfa1457c544d4aa919203a65b8f117f1aa6cb0dd9302c"
    );
    private record Adapted(String name, byte[] bytes, String manifest) {}

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    /** Resolves aliases through an existing parent before any output can be written. */
    private static Path output(Path path) throws Exception {
        Path absolute = path.toAbsolutePath().normalize();
        if (Files.exists(absolute)) return absolute.toRealPath();
        return absolute.getParent().toRealPath().resolve(absolute.getFileName());
    }

    private static boolean same(Path a, Path b) throws Exception {
        return a.equals(b) || (Files.exists(a) && Files.exists(b) && Files.isSameFile(a, b));
    }

    private static byte[] read(ZipFile jar, String name) throws Exception {
        var entry = jar.getEntry(name + ".class");
        if (entry == null) throw new IllegalArgumentException("Missing vendor class: " + name);
        try (var stream = jar.getInputStream(entry)) { return stream.readAllBytes(); }
    }

    private static String key(MethodModel method) {
        return method.methodName().stringValue() + method.methodType().stringValue();
    }

    private static String target(String name, String key) {
        if (name.endsWith("GLFW")) {
            return switch (key) {
                case "glfwUpdateGamepadMappings(Ljava/nio/ByteBuffer;)Z" -> "mappings";
                case "glfwSetJoystickCallback(Lorg/lwjgl/glfw/GLFWJoystickCallbackI;)Lorg/lwjgl/glfw/GLFWJoystickCallback;" -> "joystickCallback";
                case "glfwJoystickPresent(I)Z" -> "joystickPresent";
                default -> null;
            };
        }
        if (name.endsWith("MemoryUtil") && key.equals("memUTF8(Ljava/lang/CharSequence;)Ljava/nio/ByteBuffer;")) return "utf8";
        if (name.endsWith("Display") && key.equals("processMessages()V")) return "processMessages";
        return null;
    }

    private static Adapted adapt(String name, byte[] input) throws Exception {
        if (!sha(input).equals(PINS.get(name))) throw new IllegalArgumentException("Unqualified vendor source: " + name);
        var cf = ClassFile.of();
        var original = cf.parse(input);
        var selected = new ArrayList<String>();
        byte[] bytes = cf.transformClass(original, (builder, element) -> {
            if (name.endsWith("GLFWJoystickCallbackI") && element instanceof FieldModel field && field.fieldName().equalsString("DESCRIPTOR")) {
                selected.add("DESCRIPTOR field removed: native CIF unavailable");
                return;
            }
            if (!(element instanceof MethodModel method)) {
                builder.with(element);
                return;
            }
            String methodKey = key(method);
            if (name.endsWith("GLFWJoystickCallbackI") && !methodKey.equals("invoke(II)V")) {
                selected.add(methodKey);
                if (methodKey.equals("<clinit>()V")) return;
                builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask() & ~0x100, code ->
                    code.new_(ClassDesc.of("java.lang.UnsupportedOperationException")).dup()
                        .ldc("Native callback descriptor and pointer operations are unsupported")
                        .invokespecial(ClassDesc.of("java.lang.UnsupportedOperationException"), "<init>", MethodTypeDesc.ofDescriptor("(Ljava/lang/String;)V")).athrow());
                return;
            }
            String call = target(name, methodKey);
            if (call == null) {
                builder.with(element);
                return;
            }
            selected.add(methodKey);
            builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask() & ~0x100, code -> {
                if (call.equals("joystickPresent")) code.iload(0);
                else if (!call.equals("processMessages")) code.aload(0);
                code.invokestatic(HOST, call, method.methodTypeSymbol());
                if (call.equals("processMessages")) code.return_();
                else if (call.equals("utf8") || call.equals("joystickCallback")) code.areturn();
                else code.ireturn();
            });
        });
        int expected = name.endsWith("GLFW") ? 3 : name.endsWith("GLFWJoystickCallbackI") ? 4 : 1;
        if (selected.size() != expected) throw new AssertionError("Unexpected selected method/field count");
        var emitted = cf.parse(bytes);
        int unchanged = 0;
        for (var before : original.methods()) {
            if (selected.contains(key(before))) continue;
            var after = emitted.methods().stream().filter(method -> key(method).equals(key(before))).findFirst().orElseThrow();
            var a = before.findAttribute(Attributes.code());
            var b = after.findAttribute(Attributes.code());
            if (a.isPresent() != b.isPresent() || (a.isPresent() && !Arrays.equals(a.get().codeArray(), b.orElseThrow().codeArray()))) {
                throw new AssertionError("Unselected vendor body changed: " + key(before));
            }
            unchanged++;
        }
        String selectors = String.join(",", selected.stream().map(value -> "\"" + value + "\"").toList());
        String manifest = "{\"class\":\"" + name + "\",\"before\":\"" + sha(input) + "\",\"after\":\"" + sha(bytes)
            + "\",\"selected\":[" + selectors + "],\"unchangedMethods\":" + unchanged + "}";
        return new Adapted(name, bytes, manifest);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 5) throw new IllegalArgumentException("SDK, output JAR, manifest, clipboard overlay, startup-input overlay required");
        var inputs = List.of(Path.of(args[0]).toRealPath(), Path.of(args[3]).toRealPath(), Path.of(args[4]).toRealPath());
        Path archive = output(Path.of(args[1]));
        Path manifest = output(Path.of(args[2]));
        if (same(archive, manifest)) {
            throw new IllegalArgumentException("Output/input path aliases are forbidden");
        }
        for (Path input : inputs) {
            if (same(archive, input) || same(manifest, input)) {
                throw new IllegalArgumentException("Output/input path aliases are forbidden");
            }
        }
        var adapted = new ArrayList<Adapted>();
        String gameIdentities;
        try (var sdk = new ZipFile(inputs.get(0).toFile()); var clipboard = new ZipFile(inputs.get(1).toFile()); var startup = new ZipFile(inputs.get(2).toFile())) {
            for (String name : List.of("org/lwjgl/glfw/GLFW", "org/lwjgl/glfw/GLFWJoystickCallbackI", "org/lwjgl/system/MemoryUtil", "org/lwjglx/opengl/Display")) {
                ZipFile source = name.endsWith("GLFW") ? clipboard : name.endsWith("Display") ? startup : sdk;
                adapted.add(adapt(name, read(source, name)));
            }
            gameIdentities = "\"preparedControllersSha256\":\"" + sha(read(sdk, "org/lwjglx/input/Controllers"))
                + "\",\"preparedRenderThreadSha256\":\"" + sha(read(sdk, "zombie/core/opengl/RenderThread")) + "\"";
        }
        // Every path, pin and body-preservation check above precedes both output writes.
        try (var jar = new ZipOutputStream(Files.newOutputStream(archive))) {
            for (var item : adapted) {
                jar.putNextEntry(new ZipEntry(item.name() + ".class"));
                jar.write(item.bytes());
                jar.closeEntry();
            }
        }
        Files.writeString(manifest, "{\"gameClassesEmitted\":0," + gameIdentities + ",\"adaptations\":["
            + String.join(",", adapted.stream().map(Adapted::manifest).toList()) + "]}");
    }
}
