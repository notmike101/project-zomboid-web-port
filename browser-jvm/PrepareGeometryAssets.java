import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
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
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Copies installed Challenge1 geometry without loading game classes or altering source assets. */
public final class PrepareGeometryAssets {
    private PrepareGeometryAssets() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            throw new IllegalArgumentException(
                    "Usage: PrepareGeometryAssets <installed-game-root> <existing-output-dir>");
        }
        Path installation = Path.of(args[0]).toRealPath();
        Path requestedOutput = Path.of(args[1]).toAbsolutePath().normalize();
        Path output = requestedOutput.toRealPath();
        if (!Files.isDirectory(output) || !Files.isDirectory(installation.resolve("media"))) {
            throw new IOException("Expected installed game and existing output directories");
        }
        if (!requestedOutput.equals(output)) {
            throw new IOException("Output directory uses a symbolic-link or junction alias");
        }
        List<Path> destinations = List.of(output.resolve("geometry-assets.jar"),
                output.resolve("geometry-assets.tsv"), output.resolve("sprite-names.txt"));
        validateOutputs(List.of(), destinations, installation, output);

        Map<String, Path> files = new TreeMap<>();
        for (String name : List.of("newtiledefinitions.tiles", "tiledefinitions_erosion.tiles",
                "tiledefinitions_overlays.tiles", "tiledefinitions_b42chunkcaching.tiles",
                "tiledefinitions_noiseworks.patch.tiles", "jumbo_trees_big.tiles", "jumbo_trees.tiles")) {
            files.put("media/" + name, installation.resolve("media/" + name));
        }
        addDirectory(files, installation, "media/maps/challengemaps/Challenge1");
        addDirectory(files, installation, "media/lua/server/WorldGen");
        for (String name : List.of("metazones/BiomeMapConfig.lua", "metazones/AnimalsPathConfig.lua",
                "Zombies/VoronoiNoise.lua")) {
            files.put("media/lua/server/" + name, installation.resolve("media/lua/server/" + name));
        }
        List<Path> inputs = new ArrayList<>();
        Map<String, byte[]> contents = new TreeMap<>();
        for (Map.Entry<String, Path> file : files.entrySet()) {
            Path source = file.getValue().toRealPath();
            if (!source.startsWith(installation) || !Files.isRegularFile(source)) {
                throw new IOException("Asset escapes installation or is not regular: " + file.getValue());
            }
            inputs.add(source);
            contents.put(file.getKey(), Files.readAllBytes(source));
        }
        validateOutputs(inputs, destinations, installation, output);

        String spriteNames = extractSpriteNames(contents);
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
        // Complete parsing, alias checks and source verification before the first write.
        verifyInputs(files, contents);
        validateOutputs(inputs, destinations, installation, output);
        Files.write(destinations.get(0), archive.toByteArray());
        Files.write(destinations.get(1), manifest);
        Files.writeString(destinations.get(2), spriteNames, StandardCharsets.UTF_8);
        verifyInputs(files, contents);
        System.out.println("Actual installed geometry assets: " + files.size());
    }

    private static String extractSpriteNames(Map<String, byte[]> contents) throws IOException {
        Set<String> names = new TreeSet<>();
        for (String header : List.of("0_0", "0_1", "1_0", "1_1")) {
            byte[] data = contents.get("media/maps/challengemaps/Challenge1/" + header + ".lotheader");
            if (data == null || data.length < 20 || data[0] != 'L' || data[1] != 'O'
                    || data[2] != 'T' || data[3] != 'H') {
                throw new IOException("Missing or invalid LOTH header: " + header);
            }
            ByteBuffer buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
            if (buffer.getInt(4) != 1) throw new IOException("Unsupported lotheader version");
            int count = buffer.getInt(8);
            if (count < 0 || count > 100000) throw new IOException("Invalid tile count");
            int position = 12;
            for (int i = 0; i < count; i++) {
                int end = position;
                while (end < data.length && data[end] != '\n') end++;
                if (end == data.length) throw new IOException("Truncated tile name");
                String name = new String(data, position, end - position, StandardCharsets.UTF_8).trim();
                if (!name.matches("[A-Za-z0-9_]+")) throw new IOException("Invalid tile name");
                names.add(name);
                position = end + 1;
            }
            if (data.length - position < 8 || buffer.getInt(position) != 8
                    || buffer.getInt(position + 4) != 8) {
                throw new IOException("Expected original eight-tile chunk header");
            }
        }
        if (names.isEmpty()) throw new IOException("No original map tile names");
        return String.join("\n", names) + "\n";
    }

    private static void addDirectory(Map<String, Path> files, Path installation, String relative)
            throws IOException {
        try (var paths = Files.walk(installation.resolve(relative))) {
            for (Path path : paths.filter(Files::isRegularFile).toList()) {
                files.put(installation.relativize(path).toString().replace('\\', '/'), path);
            }
        }
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
