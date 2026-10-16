import java.io.InputStream;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.zip.ZipFile;

/** Reads class-file metadata only. It never loads or initializes the inspected classes. */
public final class GenericMetadataTool {
    public static void main(String[] args) throws Exception {
        if (args.length < 4) throw new IllegalArgumentException("game.jar adapter-classes output.json class-name...");
        Map<String, String> metadata = new TreeMap<>();
        try (ZipFile jar = new ZipFile(args[0])) {
            for (int i = 3; i < args.length; i++) {
                String name = args[i];
                String resource = name.replace('.', '/') + ".class";
                Path adapter = Path.of(args[1]).resolve(resource);
                byte[] bytes;
                if (Files.isRegularFile(adapter)) bytes = Files.readAllBytes(adapter);
                else if (jar.getEntry(resource) != null) {
                    try (InputStream input = jar.getInputStream(jar.getEntry(resource))) { bytes = input.readAllBytes(); }
                } else {
                    try (InputStream input = ClassLoader.getSystemResourceAsStream(resource)) {
                        if (input == null) throw new IllegalArgumentException("Class metadata not found: " + name);
                        bytes = input.readAllBytes();
                    }
                }
                var cls = ClassFile.of().parse(bytes);
                var classSignature = cls.findAttribute(Attributes.signature());
                if (classSignature.isPresent()) classSignature.get().asClassSignature();
                metadata.put("C|" + name, classSignature.map(signature -> signature.signature().stringValue()).orElse(""));
                for (var method : cls.methods()) {
                    String key = name + "#" + method.methodName().stringValue() + method.methodType().stringValue();
                    var signature = method.findAttribute(Attributes.signature());
                    if (signature.isPresent()) signature.get().asMethodSignature();
                    metadata.put("M|" + key, signature.map(attribute -> attribute.signature().stringValue()).orElse(""));
                    StringBuilder exceptions = new StringBuilder();
                    method.findAttribute(Attributes.exceptions()).ifPresent(attribute -> {
                        for (var exception : attribute.exceptions()) exceptions.append('L').append(exception.name().stringValue()).append(';');
                    });
                    metadata.put("E|" + key, exceptions.toString());
                }
            }
        }
        StringBuilder json = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> entry : metadata.entrySet()) {
            if (!first) json.append(',');
            first = false;
            quote(json, entry.getKey()); json.append(':'); quote(json, entry.getValue());
        }
        Files.writeString(Path.of(args[2]), json.append('}').toString());
    }
    private static void quote(StringBuilder json, String value) {
        json.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') json.append('\\').append(c);
            else if (c < 32) {
                json.append("\\u");
                String hex = Integer.toHexString(c);
                for (int pad = hex.length(); pad < 4; pad++) json.append('0');
                json.append(hex);
            } else json.append(c);
        }
        json.append('"');
    }
}
