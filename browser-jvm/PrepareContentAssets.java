import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Copies vanilla scripts, clothing XML and complete original shared/server Lua. */
public final class PrepareContentAssets {
    private PrepareContentAssets() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException(
                    "Usage: PrepareContentAssets <installed-game-root> <existing-output-dir>");
        }
        Path installation = Path.of(args[0]).toRealPath();
        Path requestedOutput = Path.of(args[1]).toAbsolutePath().normalize();
        Path output = requestedOutput.toRealPath();
        if (!Files.isDirectory(installation.resolve("media/scripts")) || !Files.isDirectory(output)) {
            throw new IOException("Expected installed game and existing output directories");
        }
        if (!requestedOutput.equals(output)) {
            throw new IOException("Output directory uses a symbolic-link or junction alias");
        }
        List<Path> destinations = List.of(output.resolve("content-assets.jar"),
                output.resolve("content-assets.tsv"));
        validateOutputs(List.of(), destinations, installation, output);
        Map<String, Path> files = new TreeMap<>();
        try (var paths = Files.walk(installation.resolve("media/scripts"))) {
            for (Path path : paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".txt")).toList()) {
                files.put(installation.relativize(path).toString().replace('\\', '/'), path);
            }
        }
        try (var paths = Files.walk(installation.resolve("media/clothing"))) {
            for (Path path : paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".xml")).toList()) {
                files.put(installation.relativize(path).toString().replace('\\', '/'), path);
            }
        }
        for (String directory : List.of("shared", "server")) {
            try (var paths = Files.walk(installation.resolve("media/lua/" + directory))) {
                for (Path path : paths.filter(Files::isRegularFile)
                        .filter(path -> path.getFileName().toString().endsWith(".lua")).toList()) {
                    files.put(installation.relativize(path).toString().replace('\\', '/'), path);
                }
            }
        }
        List<Path> inputs = new ArrayList<>();
        Map<String, byte[]> contents = new TreeMap<>();
        long totalBytes = 0;
        for (Map.Entry<String, Path> file : files.entrySet()) {
            Path source = file.getValue().toRealPath();
            if (!source.startsWith(installation) || !Files.isRegularFile(source)) {
                throw new IOException("Asset escapes installation or is not regular: " + file.getKey());
            }
            byte[] bytes = Files.readAllBytes(source);
            totalBytes = Math.addExact(totalBytes, bytes.length);
            if (files.size() > 4000 || totalBytes > 32L * 1024 * 1024) {
                throw new IOException("Content selection exceeds audited preparation bounds");
            }
            inputs.add(source);
            contents.put(file.getKey(), bytes);
        }
        validateOutputs(inputs, destinations, installation, output);
        List<String> manifest = new ArrayList<>();
        ByteArrayOutputStream archive = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(archive)) {
            for (Map.Entry<String, byte[]> file : contents.entrySet()) {
                ZipEntry entry = new ZipEntry(file.getKey());
                entry.setTime(0);
                zip.putNextEntry(entry);
                zip.write(file.getValue());
                zip.closeEntry();
                manifest.add(file.getKey() + "\t" + file.getValue().length + "\t" + hash(file.getValue()));
            }
        }
        verifyInputs(files, contents);
        validateOutputs(inputs, destinations, installation, output);
        Files.write(destinations.get(0), archive.toByteArray());
        Files.write(destinations.get(1), manifest);
        verifyInputs(files, contents);
        System.out.println("Actual installed content assets: " + files.size() + ", bytes: " + totalBytes);
    }

    private static void validateOutputs(List<Path> inputs, List<Path> outputs, Path installation,
            Path directory) throws IOException {
        Set<Path> seen = new HashSet<>();
        for (Path destination : outputs) {
            boolean exists = Files.exists(destination, LinkOption.NOFOLLOW_LINKS);
            Path resolved = exists ? destination.toRealPath() : destination.getParent().toRealPath()
                    .resolve(destination.getFileName()).normalize();
            if (resolved.startsWith(installation)) {
                throw new IOException("Output is inside game installation: " + destination);
            }
            if (!resolved.getParent().equals(directory) || !resolved.equals(destination)) {
                throw new IOException("Output uses an alias or escapes output directory: " + destination);
            }
            if (!seen.add(resolved)) throw new IOException("Duplicate output: " + destination);
            if (exists && (!Files.isRegularFile(destination, LinkOption.NOFOLLOW_LINKS)
                    || Files.isSymbolicLink(destination))) {
                throw new IOException("Output is not a regular unaliased file: " + destination);
            }
            for (Path input : inputs) {
                if (resolved.equals(input) || (exists && Files.isSameFile(destination, input))) {
                    throw new IOException("Output aliases input: " + destination);
                }
            }
            for (Path other : outputs) {
                if (!destination.equals(other) && exists && Files.exists(other)
                        && Files.isSameFile(destination, other)) {
                    throw new IOException("Outputs alias each other: " + destination);
                }
            }
        }
    }

    private static void verifyInputs(Map<String, Path> files, Map<String, byte[]> contents)
            throws Exception {
        for (Map.Entry<String, Path> file : files.entrySet()) {
            if (!hash(contents.get(file.getKey())).equals(hash(Files.readAllBytes(file.getValue())))) {
                throw new IOException("Source changed during preparation: " + file.getValue());
            }
        }
    }

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}

