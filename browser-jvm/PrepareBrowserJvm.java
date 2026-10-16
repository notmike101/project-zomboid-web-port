import java.nio.file.*;
import java.util.zip.*;
import java.lang.classfile.*;
import java.lang.constant.*;
import java.security.*;
import java.util.*;

/** Builds a private browser load-view. Never initializes or executes installed game classes. */
public class PrepareBrowserJvm {
    private static final Map<String,Map<String,String>> ADAPTERS = new LinkedHashMap<>();
    static {
        for (String name : List.of("GL12C", "GL13C", "GL14C", "GL15C"))
            ADAPTERS.put("org/lwjgl/opengl/" + name, Map.of());
        ADAPTERS.put("org/lwjgl/opengl/GL11C", Map.of(
                "glReadPixels(IIIIIILjava/nio/ByteBuffer;)V", "readBuffer",
                "glGenTextures()I", "native", "glDeleteTextures(I)V", "native",
                "glTexImage2D(IIIIIIIILjava/nio/ByteBuffer;)V", "textureBuffer"));
        var shaders = new LinkedHashMap<String,String>();
        for (String signature : List.of("glGetShaderi(II)I", "glGetProgrami(II)I",
                "glGetShaderInfoLog(II)Ljava/lang/String;", "glGetProgramInfoLog(II)Ljava/lang/String;"))
            shaders.put(signature, "native");
        shaders.put("glShaderSource(ILjava/lang/CharSequence;)V", "shaderSource");
        shaders.put("glGetUniformLocation(ILjava/lang/CharSequence;)I", "uniformLocation");
        ADAPTERS.put("org/lwjgl/opengl/GL20C", shaders);
    }
    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static String json(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
    private static Path canonical(Path path) throws Exception {
        path = path.toAbsolutePath().normalize();
        if (Files.exists(path)) return path.toRealPath();
        return canonical(path.getParent()).resolve(path.getFileName());
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("gameJar outputDirectory probeClasses");
        Path output = Path.of(args[1]);
        Path workspace = Path.of("").toRealPath();
        Path target = canonical(workspace.resolve("target"));
        Path actualOutput = canonical(output);
        Path input = Path.of(args[0]).toRealPath();
        Path viewPath = output.resolve("view.jar");
        if (!target.startsWith(workspace) || target.equals(workspace)
                || !actualOutput.startsWith(target) || actualOutput.equals(target))
            throw new IllegalArgumentException("Output must remain inside workspace target; escaping junctions are rejected");
        if (input.startsWith(actualOutput) || canonical(viewPath).equals(input)
                || (Files.exists(viewPath) && Files.isSameFile(input, viewPath)))
            throw new IllegalArgumentException("Input archive aliases generated output");
        if (!canonical(viewPath).startsWith(actualOutput)
                || !canonical(output.resolve("class-manifest.json")).startsWith(actualOutput))
            throw new IllegalArgumentException("Generated file escapes output");
        ClassFile classFile = ClassFile.of();
        var metadata = new ArrayList<String>();
        var foundAdapters = new HashSet<String>();
        int classes = 0, lowered = 0, resources = 0;
        try (var zip = new ZipFile(args[0]);
             var view = new ZipOutputStream(Files.newOutputStream(output.resolve("view.jar")))) {
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (entry.getName().equals("probe/CheerpJGL.class"))
                    throw new IllegalArgumentException("Installed archive collides with authored probe");
                byte[] original;
                try (var stream = zip.getInputStream(entry)) { original = stream.readAllBytes(); }
                byte[] bytes = original;
                if (entry.getName().endsWith(".class")) {
                    classes++;
                    int major = ((original[6] & 255) << 8) | (original[7] & 255);
                    String name = entry.getName().substring(0, entry.getName().length() - 6);
                    var changes = new TreeSet<String>();
                    var adapters = ADAPTERS.get(name);
                    if (adapters != null) {
                        foundAdapters.add(name);
                        bytes = classFile.transformClass(classFile.parse(original), (builder, element) -> {
                            if (!(element instanceof MethodModel method)) { builder.with(element); return; }
                            String key = method.methodName().stringValue() + method.methodType().stringValue();
                            String adapter = adapters.get(key);
                            if (method.methodName().equalsString("<clinit>")) {
                                changes.add("<clinit>");
                                builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask(),
                                        code -> code.return_());
                            } else if (adapter != null) {
                                changes.add(key);
                                if (adapter.equals("native")) {
                                    builder.withMethod(method.methodName(), method.methodType(), method.flags().flagsMask() | 0x100,
                                            mb -> {
                                                for (var attribute : method)
                                                    if (!(attribute instanceof CodeModel)) mb.with(attribute);
                                                mb.withFlags(method.flags().flagsMask() | 0x100);
                                            });
                                } else {
                                    builder.withMethodBody(method.methodName(), method.methodType(), method.flags().flagsMask(), code -> {
                                        var type = MethodTypeDesc.ofDescriptor(method.methodType().stringValue());
                                        int slot = 0;
                                        for (var parameter : type.parameterList()) {
                                            if (parameter.isPrimitive()) code.iload(slot); else code.aload(slot);
                                            slot++;
                                        }
                                        code.invokestatic(ClassDesc.of("probe.CheerpJGL"), adapter, type);
                                        if (type.returnType().equals(ConstantDescs.CD_void)) code.return_(); else code.ireturn();
                                    });
                                }
                            } else builder.with(element);
                        });
                        if (changes.size() != adapters.size() + 1)
                            throw new IllegalStateException("Vendor declarations changed: " + name + " " + changes);
                    }
                    if (major > 61) {
                        if (bytes == original) bytes = original.clone();
                        bytes[6] = 0; bytes[7] = 61; lowered++;
                    }
                    // Every non-adapted class must differ solely in its version header, if at all.
                    if (adapters == null) {
                        if (bytes.length != original.length) throw new AssertionError(name);
                        for (int i = 0; i < bytes.length; i++)
                            if (i != 6 && i != 7 && bytes[i] != original[i]) throw new AssertionError(name + " byte " + i);
                    }
                    metadata.add("{\"entry\":" + json(entry.getName()) + ",\"originalMajor\":" + major
                            + ",\"viewMajor\":" + Math.min(major, 61) + ",\"originalSha256\":" + json(hash(original))
                            + ",\"viewSha256\":" + json(hash(bytes)) + ",\"vendorAdaptations\":["
                            + String.join(",", changes.stream().map(PrepareBrowserJvm::json).toList()) + "]}");
                } else resources++;
                var copy = new ZipEntry(entry.getName());
                if (entry.getTime() >= 0) copy.setTime(entry.getTime());
                view.putNextEntry(copy); view.write(bytes); view.closeEntry();
            }
            if (!foundAdapters.equals(ADAPTERS.keySet()))
                throw new IllegalArgumentException("Required vendor classes absent: " + foundAdapters);
            view.putNextEntry(new ZipEntry("probe/CheerpJGL.class"));
            view.write(Files.readAllBytes(Path.of(args[2]).resolve("probe/CheerpJGL.class")));
            view.closeEntry();
        }
        Files.writeString(output.resolve("class-manifest.json"), "{\"classes\":" + classes
                + ",\"headerLoweredClasses\":" + lowered + ",\"resources\":" + resources
                + ",\"adaptedVendorClasses\":" + foundAdapters.size()
                + ",\"gameMethodBodiesUnchanged\":true,\"entries\":[" + String.join(",", metadata) + "]}\n");
        System.out.println("Prepared " + classes + " original classes; " + foundAdapters.size() + " vendor backend adapters");
    }
}
