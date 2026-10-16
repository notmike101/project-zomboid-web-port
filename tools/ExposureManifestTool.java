import java.io.InputStream;
import java.lang.classfile.*;
import java.lang.classfile.instruction.ConstantInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.constant.ClassDesc;
import java.lang.reflect.AccessFlag;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipFile;

/** Parse-only original exposure inventory. Inspected classes are never loaded or initialized. */
public final class ExposureManifestTool {
    private static final String EXPOSER = "zombie.Lua.LuaManager$Exposer";
    private final ZipFile jar;
    private final Map<String, ClassModel> models = new HashMap<>();
    private final Map<String, Map<String,Object>> identities = new HashMap<>();
    private final Map<String, Object> classes = new TreeMap<>();
    private final Set<String> seeds = new LinkedHashSet<>();
    private final Set<String> references = new TreeSet<>();
    private final Set<String> missing = new TreeSet<>();
    private long classBytes;
    private long declaredMethods;
    private long declaredFields;

    private ExposureManifestTool(ZipFile jar) { this.jar = jar; }
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: ExposureManifestTool original-game.jar output.json");
        Path jarPath = Path.of(args[0]).toAbsolutePath();
        Path output = Path.of(args[1]).toAbsolutePath().normalize();
        if (!output.startsWith(Path.of("target").toAbsolutePath().normalize()))
            throw new IllegalArgumentException("Manifest output must be under this workspace's ignored target directory");
        try (ZipFile jar = new ZipFile(jarPath.toFile())) {
            ExposureManifestTool tool = new ExposureManifestTool(jar);
            List<Object> sites = tool.extractSeeds();
            for (String seed : tool.seeds) tool.inventoryHierarchy(seed);
            Map<String,Object> manifest = new LinkedHashMap<>();
            manifest.put("schema", 1);
            manifest.put("mode", "parse-only-no-retention-injection");
            manifest.put("jarSha256", sha(Files.readAllBytes(jarPath)));
            manifest.put("jdkRuntime", Runtime.version().toString());
            manifest.put("entry", EXPOSER + ".exposeAll()V");
            manifest.put("setExposedSites", sites);
            manifest.put("seeds", tool.seeds);
            manifest.put("classes", tool.classes);
            manifest.put("signatureReferences", tool.references);
            manifest.put("missingHierarchyClassfiles", tool.missing);
            manifest.put("stats", Map.of("callSites",sites.size(),"uniqueSeeds",tool.seeds.size(),
                    "metadataClasses",tool.classes.size(),"classfileBytes",tool.classBytes,
                    "declaredMethods",tool.declaredMethods,"declaredFields",tool.declaredFields,
                    "signatureReferencedTypes",tool.references.size()));
            manifest.put("limits", List.of(
                    "Reads original class bytes and raw JDK resources; never initializes inspected classes or invokes exposeAll.",
                    "Actual shouldExpose restricts recursive Class discovery to seed membership; references outside seeds are type metadata, not additional exposure roots.",
                    "Hierarchy inventory includes non-seed ancestors so inherited public members can be retained faithfully.",
                    "Public API entries are candidates: original blacklist, HiddenFromLua annotations, class eligibility, overload merging, and initialization effects remain runtime responsibilities.",
                    "Generic bounds are recorded conservatively, including unused declarations; signatureReferences is a metadata inventory, not an exact executed traversal order.",
                    "No method implementations, serialized debug data, original Lua bodies, or assets are copied into this manifest.",
                    "No compiler reflection supplier is modified or installed by this tool."));
            Files.createDirectories(output.getParent());
            StringBuilder json = new StringBuilder(); json(json,manifest);
            Files.writeString(output,json.append('\n'));
            StringBuilder summary = new StringBuilder(); json(summary,manifest.get("stats"));
            System.out.println(summary);
        }
    }

    private List<Object> extractSeeds() throws Exception {
        ClassModel exposer = require(EXPOSER);
        MethodModel method = exposer.methods().stream().filter(m -> m.methodName().equalsString("exposeAll")
                && m.methodType().equalsString("()V")).findFirst().orElseThrow();
        List<Object> sites = new ArrayList<>();
        Instruction previous = null;
        int bci = 0;
        for (CodeElement element : method.code().orElseThrow()) {
            if (!(element instanceof Instruction instruction)) continue;
            if (instruction instanceof InvokeInstruction invoke && invoke.name().equalsString("setExposed")
                    && invoke.type().equalsString("(Ljava/lang/Class;)V")) {
                if (!invoke.owner().asInternalName().equals(EXPOSER.replace('.','/')))
                    throw new IllegalStateException("Unexpected setExposed owner at " + bci);
                if (!(previous instanceof ConstantInstruction constant) || !(constant.constantValue() instanceof ClassDesc type))
                    throw new IllegalStateException("Non-literal setExposed argument at " + bci + "; no guessed seed accepted");
                String name = typeName(type);
                seeds.add(name);
                sites.add(Map.of("bci",bci,"class",name,"descriptor",type.descriptorString()));
            }
            previous = instruction;
            bci += instruction.sizeInBytes();
        }
        if (sites.isEmpty()) throw new IllegalStateException("No original setExposed sites found");
        return sites;
    }

    private ClassModel require(String name) throws Exception {
        ClassModel model = read(name);
        if (model == null) throw new IllegalStateException("Classfile missing: " + name);
        return model;
    }
    private ClassModel read(String name) throws Exception {
        if (models.containsKey(name)) return models.get(name);
        String resource = name.replace('.','/') + ".class";
        byte[] bytes;
        String origin;
        var entry = jar.getEntry(resource);
        if (entry != null) {
            try (InputStream input = jar.getInputStream(entry)) { bytes = input.readAllBytes(); }
            origin = "original-jar";
        } else {
            try (InputStream input = ClassLoader.getSystemResourceAsStream(resource)) {
                if (input == null) { models.put(name,null); missing.add(name); return null; }
                bytes = input.readAllBytes();
            }
            origin = "jdk-resource";
        }
        ClassModel model = ClassFile.of().parse(bytes);
        if (!model.thisClass().asInternalName().equals(name.replace('.','/')))
            throw new IllegalStateException("Classfile identity mismatch: " + name);
        models.put(name,model);
        // Identity provenance is captured here, member metadata is filled by inventoryHierarchy.
        Map<String,Object> info = new LinkedHashMap<>();
        info.put("origin",origin); info.put("classfileBytes",bytes.length); info.put("classfileSha256",sha(bytes));
        identities.put(name,info);
        return model;
    }

    private void inventoryHierarchy(String name) throws Exception {
        if (name.endsWith("[]")) { references.add(name); inventoryHierarchy(name.substring(0,name.length()-2)); return; }
        ClassModel model = read(name);
        if (model == null) return;
        if (classes.containsKey(name)) return;
        Map<String,Object> info = new LinkedHashMap<>(identities.get(name));
        classes.put(name,info);
        classBytes += (Integer)info.get("classfileBytes");
        info.put("seed",seeds.contains(name)); info.put("flags",model.flags().flagsMask());
        String parent = model.superclass().map(c -> c.asInternalName().replace('/','.')).orElse(null);
        List<String> interfaces = model.interfaces().stream().map(c -> c.asInternalName().replace('/','.')).toList();
        info.put("superclass",parent); info.put("interfaces",interfaces);
        if (parent != null) references.add(parent); references.addAll(interfaces);
        String classSignature = signature(model);
        info.put("signature",classSignature); info.put("annotations",annotations(model));
        if (!classSignature.isEmpty()) {
            ClassSignature cs = ClassSignature.parseFrom(classSignature);
            collect(cs.superclassSignature()); cs.superinterfaceSignatures().forEach(this::collect);
            cs.typeParameters().forEach(this::bounds);
        }
        ArrayList<Object> methods = new ArrayList<>(), fields = new ArrayList<>();
        ArrayList<Object> publicMethods = new ArrayList<>(), publicFields = new ArrayList<>();
        for (MethodModel method : model.methods()) {
            String memberName = method.methodName().stringValue();
            if (memberName.equals("<clinit>")) continue;
            String descriptor = method.methodType().stringValue();
            String sig = signature(method);
            Map<String,Object> member = new LinkedHashMap<>();
            member.put("name",memberName); member.put("descriptor",descriptor); member.put("flags",method.flags().flagsMask());
            member.put("signature",sig); member.put("annotations",annotations(method));
            List<List<String>> parameterAnnotations = method.findAttribute(Attributes.runtimeVisibleParameterAnnotations())
                    .map(a -> a.parameterAnnotations().stream().map(list -> list.stream()
                            .map(annotation -> annotation.className().stringValue()).toList()).toList()).orElse(List.of());
            member.put("parameterAnnotations",parameterAnnotations);
            for (var parameter : parameterAnnotations) for (var annotation : parameter) collect(ClassDesc.ofDescriptor(annotation));
            List<String> thrown = method.findAttribute(Attributes.exceptions()).map(a -> a.exceptions().stream()
                    .map(c -> c.asInternalName().replace('/','.')).toList()).orElse(List.of());
            member.put("exceptions",thrown); references.addAll(thrown);
            method.methodTypeSymbol().parameterList().forEach(this::collect); collect(method.methodTypeSymbol().returnType());
            if (!sig.isEmpty()) {
                MethodSignature ms = MethodSignature.parseFrom(sig);
                ms.arguments().forEach(this::collect); collect(ms.result()); ms.throwableSignatures().forEach(this::collect);
                ms.typeParameters().forEach(this::bounds);
            }
            methods.add(member); declaredMethods++;
            if (method.flags().has(AccessFlag.PUBLIC)) publicMethods.add(memberName+descriptor);
        }
        for (FieldModel field : model.fields()) {
            String sig = signature(field);
            fields.add(Map.of("name",field.fieldName().stringValue(),"descriptor",field.fieldType().stringValue(),
                    "flags",field.flags().flagsMask(),"signature",sig,"annotations",annotations(field)));
            collect(field.fieldTypeSymbol()); if (!sig.isEmpty()) collect(Signature.parseFrom(sig));
            declaredFields++;
            if (field.flags().has(AccessFlag.PUBLIC)) publicFields.add(field.fieldName().stringValue()+":"+field.fieldType().stringValue());
        }
        info.put("methods",methods); info.put("fields",fields);
        info.put("declaredPublicMethodCandidates",publicMethods); info.put("declaredPublicFieldCandidates",publicFields);
        if (parent != null) inventoryHierarchy(parent);
        for (String itf : interfaces) inventoryHierarchy(itf);
    }
    private static String signature(AttributedElement element) {
        return element.findAttribute(Attributes.signature()).map(a -> a.signature().stringValue()).orElse("");
    }
    private List<String> annotations(AttributedElement element) {
        List<String> result = element.findAttribute(Attributes.runtimeVisibleAnnotations())
                .map(a -> a.annotations().stream().map(v -> v.className().stringValue()).toList()).orElse(List.of());
        for (String annotation : result) collect(ClassDesc.ofDescriptor(annotation));
        return result;
    }
    private void bounds(Signature.TypeParam param) {
        param.classBound().ifPresent(this::collect); param.interfaceBounds().forEach(this::collect);
    }
    private void collect(Signature sig) {
        if (sig instanceof Signature.ClassTypeSig cls) {
            collect(cls.classDesc()); cls.outerType().ifPresent(this::collect);
            for (var arg : cls.typeArgs()) if (arg instanceof Signature.TypeArg.Bounded bound) collect(bound.boundType());
        } else if (sig instanceof Signature.ArrayTypeSig array) collect(array.componentSignature());
        // Type variables are represented by identifier in the raw signature; declaration bounds above are retained.
    }
    private void collect(ClassDesc type) {
        while (type.isArray()) type=type.componentType();
        if (type.isClassOrInterface()) references.add(typeName(type));
    }
    private static String typeName(ClassDesc type) {
        if (type.isArray()) return typeName(type.componentType())+"[]";
        if (type.isPrimitive()) return type.displayName();
        String desc=type.descriptorString(); return desc.substring(1,desc.length()-1).replace('/','.');
    }
    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static void json(StringBuilder out,Object value) {
        if(value==null)out.append("null");
        else if(value instanceof String string) {
            out.append('"');
            for(int i=0;i<string.length();i++) {
                char ch=string.charAt(i);
                if(ch=='"'||ch=='\\')out.append('\\').append(ch);
                else if(ch<32)out.append(String.format("\\u%04x",(int)ch));
                else out.append(ch);
            }
            out.append('"');
        } else if(value instanceof Map<?,?> map) {
            out.append('{');boolean first=true;
            var entries=new ArrayList<>(map.entrySet());
            entries.sort(Comparator.comparing(entry -> entry.getKey().toString()));
            for(var entry:entries) { if(!first)out.append(',');first=false;json(out,entry.getKey().toString());out.append(':');json(out,entry.getValue()); }
            out.append('}');
        } else if(value instanceof Collection<?> list) {
            out.append('[');boolean first=true;
            for(Object item:list){if(!first)out.append(',');first=false;json(out,item);}out.append(']');
        } else out.append(value);
    }
}
