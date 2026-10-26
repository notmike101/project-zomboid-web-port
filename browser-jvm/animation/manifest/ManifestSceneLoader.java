import java.io.*;
import java.nio.file.*;
import java.util.*;
import jassimp.*;

/** Manifest-backed original importer with source and snapshot identity checks. */
public final class ManifestSceneLoader {
    private static Properties cachedIndex;

    private static synchronized Properties index(Path path) throws IOException {
        if (cachedIndex == null) {
            Properties loaded = new Properties();
            try (InputStream stream = Files.newInputStream(path)) { loaded.load(stream); }
            if (!"original-jassimp-relative-flags-v1".equals(loaded.getProperty("format")))
                throw new IOException("Unexpected original importer index format");
            // The owning server pins this immutable index before VM launch; source and snapshot hashes remain per call.
            cachedIndex = loaded;
        }
        return cachedIndex;
    }

    public static AiScene importFile(String file, Set<AiPostProcessSteps> flags) throws IOException {
        try {
            String normalized = file.replace('\\', '/');
            String prefix = "/app/";
            if (!normalized.startsWith(prefix)) throw new IOException("Unexpected original source root");
            String relative = normalized.substring(prefix.length());
            if (!relative.startsWith("media/") || relative.contains("..") || relative.contains(":")) throw new IOException("Noncanonical original source");
            List<String> names = new ArrayList<>(); for (AiPostProcessSteps flag : flags) names.add(flag.name()); Collections.sort(names);
            String exactFlags = String.join(",", names);
            String key = PrepareManifestScenes.identity(relative, exactFlags);
            Properties index = index(Path.of("/app/prepared/index.properties"));
            String expectedPath = index.getProperty(key + ".path");
            if (expectedPath == null || !relative.toLowerCase(Locale.ROOT).equals(expectedPath.toLowerCase(Locale.ROOT)) || !exactFlags.equals(index.getProperty(key + ".flags"))) throw new IOException("Unexpected original importer path/flags");
            Path source = Path.of(file);
            if (!PrepareManifestScenes.hash(source).equals(index.getProperty(key + ".source"))) throw new IOException("Original source changed");
            byte[] snapshot = Files.readAllBytes(Path.of("/app/prepared", key + ".ais"));
            if (!PrepareManifestScenes.digest(snapshot).equals(index.getProperty(key + ".snapshot"))) throw new IOException("Snapshot identity changed");
            return AiSceneSnapshot.decode(snapshot);
        } catch (IOException failure) { throw failure; }
        catch (Exception failure) { throw new IOException("Original prepared importer unavailable", failure); }
    }
}
