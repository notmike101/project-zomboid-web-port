import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Selects genuine menu-only assets into an owned deterministic browser archive. */
public final class PrepareMenuAssets {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("installed-root existing-output");
        Path installed = Path.of(args[0]).toRealPath();
        Path requested = Path.of(args[1]).toAbsolutePath().normalize();
        Path output = requested.toRealPath();
        if (!requested.equals(output) || output.startsWith(installed)) throw new IllegalArgumentException("Output boundary");
        SortedSet<String> names = new TreeSet<>();
        names.add("media/texturepacks/UI2.pack");
        names.add("media/white.png");
        names.add("media/textures/worldMap/Paper.png");
        names.add("media/hairStyles/hairStyles.xml");
        names.add("media/hairStyles/beardStyles.xml");
        SortedSet<String> direct = new TreeSet<>();
        for (String icon : List.of("Apocalypse", "Outbreak", "Rising", "Extinction", "Sandbox", "Challenges"))
            names.add("media/ui/playstyleIcons/" + icon + ".png");
        try (var paths = Files.list(installed.resolve("media/maps"))) {
            for (Path directory : paths.filter(Files::isDirectory).toList()) {
                for (String name : List.of("map.info", "spawnpoints.lua")) {
                    Path file = directory.resolve(name);
                    if (Files.isRegularFile(file)) names.add(installed.relativize(file).toString().replace('\\', '/'));
                }
                String translation = "media/lua/shared/Translate/EN/" + directory.getFileName() + ".json";
                if (Files.isRegularFile(installed.resolve(translation))) names.add(translation);
                for (String name : List.of("worldmap.xml", "worldmap.xml.bin", "worldmap-forest.xml", "worldmap-forest.xml.bin", "pyramid.zip")) {
                    Path file = directory.resolve(name);
                    if (Files.isRegularFile(file)) direct.add(installed.relativize(file).toString().replace('\\', '/'));
                }
            }
        }
        List<String> rows = new ArrayList<>();
        Path archive = output.resolve("menu-assets.jar");
        Path manifest = output.resolve("menu-assets.tsv");
        Path mappings = output.resolve("menu-map-files.tsv");
        for (Path target : List.of(archive, manifest, mappings)) {
            if (Files.isSymbolicLink(target) || (Files.exists(target) && !target.toRealPath().startsWith(output)))
                throw new IllegalArgumentException("Output alias");
        }
        Path temporary = Files.createTempFile(output, "menu-assets-", ".tmp");
        try (var zip = new ZipOutputStream(Files.newOutputStream(temporary))) {
            for (String name : names) {
                Path source = installed.resolve(name).toRealPath();
                if (!source.startsWith(installed)) throw new IllegalArgumentException("Input alias");
                byte[] bytes = Files.readAllBytes(source);
                String before = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                var entry = new ZipEntry(name);
                entry.setTime(0);
                zip.putNextEntry(entry);
                zip.write(bytes);
                zip.closeEntry();
                String after = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(source)));
                if (!before.equals(after)) throw new IllegalStateException("Menu input changed: " + name);
                rows.add(before + "\t" + bytes.length + "\t" + name);
            }
        }
        Files.move(temporary, archive, StandardCopyOption.REPLACE_EXISTING);
        publish(output, manifest, rows);
        List<String> mapRows = new ArrayList<>();
        for (String name : direct) {
            Path file = installed.resolve(name).toRealPath();
            if (!file.startsWith(installed)) throw new IllegalArgumentException("Map input alias");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var stream = Files.newInputStream(file)) {
                byte[] buffer = new byte[65536];
                for (int length; (length = stream.read(buffer)) >= 0;) digest.update(buffer, 0, length);
            }
            mapRows.add(HexFormat.of().formatHex(digest.digest()) + "\t" + Files.size(file) + "\t" + name);
        }
        publish(output, mappings, mapRows);
    }

    private static void publish(Path output, Path destination, List<String> rows) throws Exception {
        Path temporary = Files.createTempFile(output, "menu-manifest-", ".tmp");
        try {
            Files.write(temporary, rows);
            Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
