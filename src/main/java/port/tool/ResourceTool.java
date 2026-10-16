package port.tool;

import java.nio.charset.StandardCharsets;
import java.io.File;
import java.util.Base64;
import java.util.jar.Attributes;
import java.util.jar.JarFile;

/** Host-side archive access only. Never loads or executes an archived class. */
public final class ResourceTool {
    public static void main(String[] args) throws Exception {
        if (args.length < 2 || args.length > 3) throw new IllegalArgumentException("Expected archive, mode, and optional entry");
        try (JarFile archive = new JarFile(new File(args[0]), true, JarFile.OPEN_READ, Runtime.version())) {
            if (args[1].equals("list") && args.length == 2) {
                var entries = archive.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    if (!entry.isDirectory()) System.out.println(Base64.getEncoder().encodeToString(entry.getName().getBytes(StandardCharsets.UTF_8)));
                }
                try (var entriesForVersion = archive.versionedStream()) {
                    entriesForVersion.filter(entry -> !entry.isDirectory()).forEach(entry ->
                            System.out.println(Base64.getEncoder().encodeToString(entry.getName().getBytes(StandardCharsets.UTF_8))));
                }
            } else if (args[1].equals("packages") && args.length == 2) {
                var manifest = archive.getManifest();
                if (manifest != null) {
                    metadata("", manifest.getMainAttributes());
                    for (var entry : manifest.getEntries().entrySet()) {
                        String name = entry.getKey();
                        if (name.endsWith("/")) metadata(name.substring(0, name.length() - 1).replace('/', '.'), entry.getValue());
                    }
                }
            } else if (args[1].equals("read") && args.length == 3) {
                var entry = archive.getJarEntry(args[2]);
                if (entry == null || entry.isDirectory()) throw new IllegalArgumentException("Unknown archive entry");
                if (entry.getSize() < 0 || entry.getSize() > 64L * 1024 * 1024) throw new IllegalArgumentException("Resource exceeds host limit");
                try (var input = archive.getInputStream(entry)) { input.transferTo(System.out); }
            } else throw new IllegalArgumentException("Invalid resource mode");
        }
    }
    private static void metadata(String name, Attributes attributes) {
        metadata(name, attributes.getValue(Attributes.Name.SPECIFICATION_VERSION));
        metadata("Implementation-Version:" + name, attributes.getValue(Attributes.Name.IMPLEMENTATION_VERSION));
    }
    private static void metadata(String name, String version) {
        if (version != null) System.out.println(Base64.getEncoder().encodeToString(name.getBytes(StandardCharsets.UTF_8))
                + "\t" + Base64.getEncoder().encodeToString(version.getBytes(StandardCharsets.UTF_8)));
    }
}
