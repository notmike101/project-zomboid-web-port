import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import jassimp.*;

/** Manifest preparer for source-qualified original importer snapshots. */
public final class PrepareManifestScenes {
    record Input(String key, String relative, String sourceHash, long bytes, String flags, long raw) {}
    static final Set<String> FLAGS = Set.of("FIND_INSTANCES", "MAKE_LEFT_HANDED", "LIMIT_BONE_WEIGHTS", "TRIANGULATE", "OPTIMIZE_MESHES", "REMOVE_REDUNDANT_MATERIALS", "JOIN_IDENTICAL_VERTICES");
    static final Map<String, Long> FLAG_VALUES = Map.of("FIND_INSTANCES",1048576L,"MAKE_LEFT_HANDED",4L,"LIMIT_BONE_WEIGHTS",512L,"TRIANGULATE",8L,"OPTIMIZE_MESHES",2097152L,"REMOVE_REDUNDANT_MATERIALS",4096L,"JOIN_IDENTICAL_VERTICES",2L);
    static String digest(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    static String hash(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = Files.newInputStream(path)) { byte[] block = new byte[65536]; for (int n; (n = stream.read(block)) != -1;) digest.update(block, 0, n); }
        return HexFormat.of().formatHex(digest.digest());
    }
    static String identity(String relative, String flags) throws Exception { return digest((relative.toLowerCase(Locale.ROOT) + "|" + flags).getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    static Path source(Path root, Input input) throws Exception {
        if (!input.relative.startsWith("media/") || input.relative.contains("\\") || input.relative.contains(":") || input.relative.contains("\t") || input.relative.contains("\n")) throw new IOException("Invalid original relative path");
        Path path = root.resolve(input.relative).normalize();
        if (!path.startsWith(root) || !path.equals(path.toRealPath()) || !root.relativize(path).toString().replace('\\','/').equals(input.relative) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Original path alias/escape");
        if (Files.size(path) != input.bytes || !hash(path).equals(input.sourceHash)) throw new IOException("Original input identity changed: " + input.relative);
        return path;
    }
    static List<Input> inputs(Path plan) throws Exception {
        if (Files.size(plan) > 4 * 1024 * 1024) throw new IOException("Plan too large");
        List<Input> result = new ArrayList<>(); Set<String> seen = new HashSet<>();
        for (String line : Files.readAllLines(plan)) {
            String[] fields = line.split("\t", -1);
            if (fields.length != 6 || !fields[0].matches("[a-f0-9]{64}") || !fields[2].matches("[a-f0-9]{64}")) throw new IOException("Invalid manifest record");
            String[] flags = fields[4].split(","); List<String> sorted = new ArrayList<>(List.of(flags)); Collections.sort(sorted);
            if (!String.join(",", sorted).equals(fields[4]) || new HashSet<>(sorted).size() != sorted.size() || !FLAGS.containsAll(sorted)) throw new IOException("Unknown/unsorted flags");
            Input input = new Input(fields[0], fields[1], fields[2], Long.parseLong(fields[3]), fields[4], Long.parseLong(fields[5]));
            if (input.relative.chars().anyMatch(value -> value < 32 || value > 126)) throw new IOException("Unaudited non-ASCII source path");
            if (sorted.stream().mapToLong(FLAG_VALUES::get).sum() != input.raw) throw new IOException("Flag names/raw mismatch");
            if (input.bytes <= 0 || input.bytes > 128L * 1024 * 1024 || !identity(input.relative, input.flags).equals(input.key) || !seen.add(input.key) || !Set.of(4100L,3150348L,3150350L).contains(input.raw)) throw new IOException("Invalid/duplicate identity");
            result.add(input);
        }
        if (result.isEmpty() || result.size() > 4096) throw new IOException("Invalid input count");
        return List.copyOf(result);
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("INSTALLATION PLAN FRESH_STAGING JASSIMP_DLL");
        Path root = Path.of(args[0]).toRealPath(), plan = Path.of(args[1]).toRealPath(), output = Path.of(args[2]).toAbsolutePath().normalize(), dll = Path.of(args[3]).toRealPath();
        Path parent = output.getParent().toRealPath();
        if (!parent.resolve(output.getFileName()).equals(output) || Files.exists(output, LinkOption.NOFOLLOW_LINKS) || output.startsWith(root) || root.startsWith(output) || !dll.getParent().equals(root) || !Files.isRegularFile(dll)) throw new IOException("Fresh canonical staging outside installation required");
        List<Input> records = inputs(plan);
        String planHash = hash(plan), dllHash = hash(dll);
        for (Input input : records) source(root, input);
        Files.createDirectory(output);
        Properties index = new Properties(); index.setProperty("format", "original-jassimp-relative-flags-v1"); index.setProperty("plan.sha256", planHash); index.setProperty("dll.sha256", dllHash);
        try {
            for (Input input : records) {
                Path snapshot = output.resolve(input.key + ".ais"), metadata = output.resolve(input.key + ".properties"), log = output.resolve(input.key + ".log");
                Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(), "-Xmx512m", "-XX:MaxDirectMemorySize=512m", "-cp", System.getProperty("java.class.path"), "ImportManifestRecord", root.toString(), dll.toString(), plan.toString(), input.key, output.toString()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
                try { if (!process.waitFor(120, TimeUnit.SECONDS)) throw new IOException("Original importer child deadline: " + input.key); }
                finally { if (process.isAlive()) { process.destroyForcibly(); process.waitFor(); } }
                if (process.exitValue() != 0) throw new IOException("Original importer child failed: " + input.key + " see " + log);
                if (!Files.isRegularFile(snapshot, LinkOption.NOFOLLOW_LINKS) || !Files.isRegularFile(metadata, LinkOption.NOFOLLOW_LINKS)) throw new IOException("Child output missing");
                Properties proof = new Properties(); try (InputStream stream = Files.newInputStream(metadata)) { proof.load(stream); }
                String snapshotHash = hash(snapshot);
                if (!snapshotHash.equals(proof.getProperty("snapshot.sha256")) || !input.sourceHash.equals(proof.getProperty("source.sha256")) || !input.flags.equals(proof.getProperty("flags"))) throw new IOException("Child proof mismatch");
                source(root, input);
                index.setProperty(input.key + ".path", input.relative); index.setProperty(input.key + ".flags", input.flags); index.setProperty(input.key + ".source", input.sourceHash); index.setProperty(input.key + ".snapshot", snapshotHash);
            }
            for (Input input : records) source(root, input);
            if (!hash(plan).equals(planHash) || !hash(dll).equals(dllHash)) throw new IOException("Original importer/plan changed");
            Path temporary = output.resolve("index.properties.pending");
            List<String> lines = new ArrayList<>();
            for (String name : new TreeSet<>(index.stringPropertyNames())) lines.add(name + "=" + index.getProperty(name).replace("\\", "\\\\"));
            Files.write(temporary, lines, java.nio.charset.StandardCharsets.ISO_8859_1, StandardOpenOption.CREATE_NEW);
            Files.move(temporary, output.resolve("index.properties"), StandardCopyOption.ATOMIC_MOVE);
        } catch (Throwable failure) {
            Files.writeString(output.resolve("FAILED.txt"), failure.toString(), StandardOpenOption.CREATE_NEW);
            throw failure;
        }
    }
}
