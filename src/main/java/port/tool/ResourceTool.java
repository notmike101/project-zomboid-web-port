package port.tool;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.jar.JarFile;

/** Host-side archive access only. Never loads or executes an archived class. */
public final class ResourceTool {
    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2) throw new IllegalArgumentException("Expected archive and optional entry");
        try (JarFile archive = new JarFile(args[0])) {
            if (args.length == 1) {
                var entries = archive.entries();
                while (entries.hasMoreElements()) {
                    var entry = entries.nextElement();
                    if (!entry.isDirectory()) System.out.println(Base64.getEncoder().encodeToString(entry.getName().getBytes(StandardCharsets.UTF_8)));
                }
            } else {
                var entry = archive.getJarEntry(args[1]);
                if (entry == null || entry.isDirectory()) throw new IllegalArgumentException("Unknown archive entry");
                if (entry.getSize() < 0 || entry.getSize() > 64L * 1024 * 1024) throw new IllegalArgumentException("Resource exceeds host limit");
                try (var input = archive.getInputStream(entry)) { input.transferTo(System.out); }
            }
        }
    }
}
