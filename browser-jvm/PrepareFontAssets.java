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

/** Copies the qualified original English font definitions, texture pages and UI shaders. */
public final class PrepareFontAssets {
    private PrepareFontAssets() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException(
                    "Usage: PrepareFontAssets <installed-game-root> <existing-output-dir>");
        }
        Path installation = Path.of(args[0]).toRealPath();
        Path requestedOutput = Path.of(args[1]).toAbsolutePath().normalize();
        Path output = requestedOutput.toRealPath();
        if (!Files.isDirectory(installation.resolve("media/fonts")) || !Files.isDirectory(output)) {
            throw new IOException("Expected installed game and existing output directories");
        }
        if (!requestedOutput.equals(output)) {
            throw new IOException("Output directory uses a symbolic-link or junction alias");
        }
        List<Path> destinations = List.of(output.resolve("font-assets.jar"),
                output.resolve("font-assets.tsv"));
        validateOutputs(List.of(), destinations, installation, output);
        Map<String, Path> files = new TreeMap<>();
        Path fonts = installation.resolve("media/fonts");
        try (var paths = Files.list(fonts)) {
            for (Path file : paths.filter(Files::isRegularFile).filter(path -> isFontAsset(path, false)).toList())
                add(files, installation, installation.relativize(file).toString().replace('\\', '/'));
        }
        try (var paths = Files.walk(fonts.resolve("EN"))) {
            for (Path file : paths.filter(Files::isRegularFile).filter(path -> isFontAsset(path, true)).toList())
                add(files, installation, installation.relativize(file).toString().replace('\\', '/'));
        }
        // Original getFontFilePath also falls back to files directly under media.
        String definitions = Files.readString(fonts.resolve("EN/fonts.txt"));
        var references = java.util.regex.Pattern.compile("(?m)^\\s*(?:fnt|img)\\s*=\\s*([^,\\r\\n]+),\\s*$").matcher(definitions);
        while (references.find()) {
            String name = references.group(1).trim();
            if (!name.matches("[A-Za-z0-9_.-]+") || name.equals(".") || name.equals(".."))
                throw new IOException("Noncanonical original font reference: " + name);
            if (Files.isRegularFile(installation.resolve("media").resolve(name)))
                add(files, installation, "media/" + name);
        }
        for (String name : List.of("default.vert", "default.frag", "sdf.vert", "sdf.frag"))
            add(files, installation, "media/shaders/" + name);
        // The original main-menu font images are subtextures, not loose PNG files.
        add(files, installation, "media/texturepacks/UI.pack");
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
            if (files.size() > 400 || totalBytes > 64L * 1024 * 1024) {
                throw new IOException("Font selection exceeds audited preparation bounds");
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
        System.out.println("Actual installed font assets: " + files.size() + ", bytes: " + totalBytes);
    }

    private static boolean isFontAsset(Path path, boolean configuration) {
        String name = path.getFileName().toString();
        return name.endsWith(".fnt") || name.endsWith(".png") || (configuration && name.endsWith(".txt"));
    }

    private static void add(Map<String, Path> files, Path installation, String relative) {
        files.put(relative, installation.resolve(relative));
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

