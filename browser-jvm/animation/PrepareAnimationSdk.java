import java.lang.classfile.*;
import java.lang.classfile.instruction.*;
import java.lang.constant.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Exact SDK21 call adapters; original animation and action-history algorithms remain intact. */
public final class PrepareAnimationSdk {
    private static final String ANIM_LAYER = "zombie/core/skinnedmodel/advancedanimation/AnimLayer.class";
    private static final String ACTION_CONTEXT = "zombie/characters/action/ActionContext.class";
    private static final Map<String, String> EXPECTED = Map.of(
            ANIM_LAYER, "8b59bfb1ec0c8e7e174cd3ba09042ff3bc9fe82bec38745c73d1f410daca0bc5",
            ACTION_CONTEXT, "3948dce849e7c6f4ac9522abc0ce802b948b04e341bb3f05d65c3704544690ac");

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("INPUT_VIEW OUTPUT_OVERLAY_JAR OUTPUT_MANIFEST");
        Path input = Path.of(args[0]).toRealPath();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        Path manifest = Path.of(args[2]).toAbsolutePath().normalize();
        if (output.equals(manifest)
                || (Files.exists(output) && Files.isSameFile(input, output))
                || (Files.exists(manifest) && Files.isSameFile(input, manifest))
                || (Files.exists(output) && Files.exists(manifest) && Files.isSameFile(output, manifest))) {
            throw new IllegalArgumentException("Input/output alias");
        }
        var classes = new LinkedHashMap<String, byte[]>();
        var records = new ArrayList<String>();
        try (var zip = new ZipFile(input.toFile())) {
            var resolver = ClassHierarchyResolver.ofResourceParsing(desc -> {
                String name = desc.descriptorString().substring(1, desc.descriptorString().length() - 1) + ".class";
                var item = zip.getEntry(name);
                try {
                    return item != null ? zip.getInputStream(item) : ClassLoader.getSystemResourceAsStream(name);
                } catch (Exception failure) { throw new IllegalStateException(failure); }
            }).cached();
            var cf = ClassFile.of(ClassFile.ClassHierarchyResolverOption.of(resolver));
            for (String entry : List.of(ANIM_LAYER, ACTION_CONTEXT)) {
                byte[] original;
                var source = zip.getEntry(entry);
                if (source == null) throw new IllegalArgumentException("Missing original class: " + entry);
                try (var stream = zip.getInputStream(source)) { original = stream.readAllBytes(); }
                String before = hash(original);
                if (!before.equals(EXPECTED.get(entry))) {
                    throw new IllegalArgumentException("Unqualified class SHA256: " + entry + " " + before);
                }
                var sites = new ArrayList<String>();
                byte[] adapted = cf.transformClass(cf.parse(original), (builder, element) -> {
                    if (!(element instanceof MethodModel method)) { builder.with(element); return; }
                    int[] bci = {0};
                    builder.transformMethod(method, MethodTransform.transformingCode((code, item) -> {
                        int offset = bci[0];
                        if (item instanceof Instruction instruction) bci[0] += instruction.sizeInBytes();
                        if (!(item instanceof InvokeInstruction call)) { code.with(item); return; }
                        String signature = method.methodName().stringValue() + method.methodType().stringValue();
                        String helper;
                        String methodName;
                        String descriptor;
                        if (entry.equals(ANIM_LAYER) && call.owner().asInternalName().equals("java/util/List")
                                && call.name().equalsString("getFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            boolean qualified = signature.equals("transitionTo(Lzombie/core/skinnedmodel/advancedanimation/AnimState;Z)Z") && offset == 34
                                    || signature.equals("getHighestLiveNode()Lzombie/core/skinnedmodel/advancedanimation/LiveAnimNode;") && offset == 18;
                            if (!qualified) throw new IllegalArgumentException("Unqualified List.getFirst: " + signature + " BCI" + offset);
                            helper = "port.host.ListFirstSupport";
                            methodName = "getFirst";
                            descriptor = "(Ljava/util/List;)Ljava/lang/Object;";
                        } else if (entry.equals(ACTION_CONTEXT) && call.owner().asInternalName().equals("java/util/Stack")
                                && call.name().equalsString("removeFirst") && call.type().equalsString("()Ljava/lang/Object;")) {
                            if (!signature.equals("pushPreviousState(Lzombie/characters/action/ActionState;)V") || offset != 37) {
                                throw new IllegalArgumentException("Unqualified Stack.removeFirst: " + signature + " BCI" + offset);
                            }
                            helper = "port.host.StackFirstSupport";
                            methodName = "removeFirst";
                            descriptor = "(Ljava/util/Stack;)Ljava/lang/Object;";
                        } else { code.with(item); return; }
                        sites.add("{\"method\":\"" + signature + "\",\"originalBCI\":" + offset
                                + ",\"from\":\"" + call.owner().asInternalName() + "." + call.name().stringValue() + call.type().stringValue()
                                + "\",\"to\":\"" + helper + "." + methodName + descriptor + "\"}");
                        code.invokestatic(ClassDesc.of(helper), methodName, MethodTypeDesc.ofDescriptor(descriptor));
                    }));
                });
                int expectedSites = entry.equals(ANIM_LAYER) ? 2 : 1;
                if (sites.size() != expectedSites) throw new IllegalArgumentException("Unexpected SDK site count: " + entry + " " + sites.size());
                classes.put(entry, adapted);
                records.add("{\"entry\":\"" + entry + "\",\"inputClassSha256\":\"" + before
                        + "\",\"outputClassSha256\":\"" + hash(adapted) + "\",\"receiver\":\""
                        + (entry.equals(ANIM_LAYER) ? "exact java.util.ArrayList" : "exact java.util.Stack; inherited List default removeFirst sequence")
                        + "\",\"sites\":[" + String.join(",", sites) + "]}");
            }
        }
        try (var jar = new ZipOutputStream(Files.newOutputStream(output))) {
            for (var entry : classes.entrySet()) {
                var item = new ZipEntry(entry.getKey());
                item.setTime(0);
                jar.putNextEntry(item);
                jar.write(entry.getValue());
                jar.closeEntry();
            }
        }
        Files.writeString(manifest, "{\"formatVersion\":2,\"classes\":[" + String.join(",", records)
                + "],\"gameMethodBodyBytesUnchanged\":false,\"originalAlgorithmPreserved\":true}\n");
    }
}
