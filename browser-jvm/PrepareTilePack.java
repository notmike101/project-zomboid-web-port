import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.CRC32;

/** Copies complete original PZPK1 pages; does not decode, repack or execute game assets. */
public final class PrepareTilePack {
    private static final int MAX_BYTES = 64 * 1024 * 1024;
    private record Rect(int x, int y, int w, int h) {}
    private record Page(String name, int start, int end, List<String> sprites) {}
    private record Pack(Path path, byte[] bytes, List<Page> pages) {}

    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException(
                "Usage: PrepareTilePack <Tiles1x.pack> <Tiles1x.floor.pack> <sprite-names.txt> <output-directory>");
        Path source = Path.of(args[0]).toRealPath(), floor = Path.of(args[1]).toRealPath();
        Path names = Path.of(args[2]).toRealPath();
        if (!source.getFileName().toString().equals("Tiles1x.pack")
                || !floor.getFileName().toString().equals("Tiles1x.floor.pack")
                || !source.getParent().equals(floor.getParent())
                || !source.getParent().getFileName().toString().equals("texturepacks")
                || !source.getParent().getParent().getFileName().toString().equals("media"))
            throw new IOException("Expected installed sibling media/texturepacks/Tiles1x packs");
        Path installation = source.getParent().getParent().getParent();
        Path output = canonical(Path.of(args[3]));
        List<Path> inputs = List.of(source, floor, names);
        List<Path> destinations = List.of(output.resolve("Challenge1Tiles.pack"),
                output.resolve("Tiles1x.floor.pack"), output.resolve("manifest.json"));
        validateOutputs(inputs, destinations, installation);
        if (Files.size(names) > 1024 * 1024) throw new IOException("Sprite list exceeds 1 MiB");
        byte[] namesBytes = Files.readAllBytes(names);
        SortedSet<String> requested = new TreeSet<>();
        for (String line : decode(namesBytes).split("\\R")) {
            if (line.isBlank()) continue;
            if (!line.matches("[A-Za-z0-9_]+")) throw new IOException("Invalid sprite name: " + line);
            if (!requested.add(line)) throw new IOException("Duplicate requested sprite: " + line);
        }
        if (requested.isEmpty()) throw new IOException("Empty sprite list");
        Pack original = parse(source), floors = parse(floor);
        Set<String> found = new TreeSet<>();
        for (Page page : floors.pages) for (String sprite : page.sprites)
            if (requested.contains(sprite)) found.add(sprite);
        List<Page> selected = new ArrayList<>();
        for (Page page : original.pages) {
            boolean needed = page.sprites.stream().anyMatch(s -> requested.contains(s) && !found.contains(s));
            if (needed) {
                selected.add(page);
                for (String sprite : page.sprites) if (requested.contains(sprite)) found.add(sprite);
            }
        }
        SortedSet<String> missing = new TreeSet<>(requested);
        missing.removeAll(found);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        bytes.write(original.bytes, 0, 8);
        bytes.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(selected.size()).array());
        for (Page page : selected) bytes.write(original.bytes, page.start, page.end - page.start);
        byte[] prepared = bytes.toByteArray();
        Pack checked = parseBytes(destinations.get(0), prepared);
        if (checked.pages.size() != selected.size()) throw new AssertionError("Prepared pack page mismatch");
        StringBuilder manifest = new StringBuilder("{\n  \"format\":\"PZPK1 whole original pages\",\n");
        manifest.append("  \"source\":").append(fileRecord(source, original.bytes)).append(",\n");
        manifest.append("  \"floorSource\":").append(fileRecord(floor, floors.bytes)).append(",\n");
        manifest.append("  \"spriteList\":").append(fileRecord(names, namesBytes)).append(",\n");
        manifest.append("  \"output\":").append(fileRecord(destinations.get(0), prepared)).append(",\n");
        manifest.append("  \"floorOutput\":").append(fileRecord(destinations.get(1), floors.bytes)).append(",\n");
        manifest.append("  \"requested\":").append(requested.size()).append(",\"found\":").append(found.size());
        manifest.append(",\"pageCount\":").append(selected.size()).append(",\n  \"pages\":[");
        for (int i = 0; i < selected.size(); i++) {
            Page page = selected.get(i);
            if (i != 0) manifest.append(',');
            byte[] pageBytes = Arrays.copyOfRange(original.bytes, page.start, page.end);
            manifest.append("\n    {\"name\":").append(quote(page.name)).append(",\"sourceOffset\":")
                    .append(page.start).append(",\"bytes\":").append(pageBytes.length)
                    .append(",\"sha256\":").append(quote(hash(pageBytes))).append('}');
        }
        manifest.append("\n  ],\n  \"missing\":[");
        int n = 0;
        for (String name : missing) { if (n++ != 0) manifest.append(','); manifest.append(quote(name)); }
        manifest.append("],\n  \"missingPolicy\":\"Reported, not fabricated or rejected; original loader behavior retained\"\n}\n");
        // All parsing and all destination/input checks complete before the first directory or file write.
        verifyInput(source, original.bytes); verifyInput(floor, floors.bytes); verifyInput(names, namesBytes);
        validateOutputs(inputs, destinations, installation);
        Files.createDirectories(output);
        Files.write(destinations.get(0), prepared);
        Files.write(destinations.get(1), floors.bytes);
        Files.writeString(destinations.get(2), manifest, StandardCharsets.UTF_8);
        verifyInput(source, original.bytes); verifyInput(floor, floors.bytes); verifyInput(names, namesBytes);
        System.out.println("Prepared " + selected.size() + " unchanged pages; " + found.size() + "/"
                + requested.size() + " sprites found; " + missing.size() + " missing; " + prepared.length + " bytes");
    }

    private static Pack parse(Path path) throws Exception {
        if (!Files.isRegularFile(path) || Files.size(path) > MAX_BYTES) throw new IOException("Pack exceeds 64 MiB or is not regular: " + path);
        return parseBytes(path, Files.readAllBytes(path));
    }

    private static Pack parseBytes(Path path, byte[] data) throws Exception {
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        try {
            if (b.getInt() != 0x4b505a50 || b.getInt() != 1) throw new IOException("Expected PZPK version 1: " + path);
            int count = bounded(b.getInt(), 0, 65536, "page count");
            List<Page> pages = new ArrayList<>(); Set<String> pageNames = new HashSet<>();
            for (int p = 0; p < count; p++) {
                int start = b.position(); String name = string(b);
                if (!pageNames.add(name)) throw new IOException("Duplicate page name: " + name);
                int subCount = bounded(b.getInt(), 0, 1000000, "sprite count");
                bounded(b.getInt(), 0, 1, "alpha flag");
                List<String> sprites = new ArrayList<>(); List<Rect> rects = new ArrayList<>();
                for (int s = 0; s < subCount; s++) {
                    sprites.add(string(b));
                    int x = b.getInt(), y = b.getInt(), w = b.getInt(), h = b.getInt();
                    b.getInt(); b.getInt(); // Original trim offsets can be negative.
                    bounded(b.getInt(), 0, 65536, "original width"); bounded(b.getInt(), 0, 65536, "original height");
                    rects.add(new Rect(x, y, w, h));
                }
                int length = bounded(b.getInt(), 1, b.remaining(), "PNG byte length");
                int image = b.position(); int[] size = png(data, image, length);
                for (Rect r : rects) if (r.x < 0 || r.y < 0 || r.w < 0 || r.h < 0
                        || (long) r.x + r.w > size[0] || (long) r.y + r.h > size[1])
                    throw new IOException("Sprite rectangle outside PNG: " + name);
                b.position(image + length);
                pages.add(new Page(name, start, b.position(), List.copyOf(sprites)));
            }
            if (b.hasRemaining()) throw new IOException("Trailing pack bytes: " + path);
            return new Pack(path, data, List.copyOf(pages));
        } catch (BufferUnderflowException | IllegalArgumentException e) {
            throw new IOException("Truncated or invalid pack: " + path, e);
        }
    }

    private static int[] png(byte[] bytes, int start, int length) throws IOException {
        byte[] signature = {(byte)137,80,78,71,13,10,26,10};
        if (length < 33 || !Arrays.equals(signature, Arrays.copyOfRange(bytes, start, start + 8)))
            throw new IOException("Invalid PNG signature");
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN); b.position(start + 8);
        int end = start + length, width = 0, height = 0; boolean first = true, ended = false;
        while (b.position() < end) {
            if (end - b.position() < 12) throw new IOException("Truncated PNG chunk");
            int len = b.getInt(), type = b.getInt(), chunkStart = b.position() - 4;
            if (len < 0 || len > end - b.position() - 4) throw new IOException("Invalid PNG chunk length");
            if (first) {
                if (type != 0x49484452 || len != 13) throw new IOException("Missing PNG IHDR");
                width = bounded(b.getInt(b.position()), 1, 65536, "PNG width");
                height = bounded(b.getInt(b.position() + 4), 1, 65536, "PNG height"); first = false;
            }
            CRC32 crc = new CRC32(); crc.update(bytes, chunkStart, len + 4);
            b.position(b.position() + len);
            if ((int)crc.getValue() != b.getInt()) throw new IOException("PNG CRC mismatch");
            if (type == 0x49454e44) { if (len != 0 || b.position() != end) throw new IOException("Invalid PNG IEND"); ended = true; break; }
        }
        if (!ended) throw new IOException("Missing PNG IEND");
        return new int[]{width, height};
    }

    private static String string(ByteBuffer b) throws IOException {
        int length = bounded(b.getInt(), 1, Math.min(65536, b.remaining()), "string length");
        byte[] bytes = new byte[length]; b.get(bytes); return decode(bytes);
    }
    private static String decode(byte[] bytes) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
    private static int bounded(int v, int min, int max, String field) throws IOException {
        if (v < min || v > max) throw new IOException("Invalid " + field + ": " + v); return v;
    }
    private static Path canonical(Path path) throws IOException {
        path = path.toAbsolutePath().normalize();
        if (Files.exists(path)) return path.toRealPath();
        Path parent = path.getParent();
        if (parent == null) throw new IOException("No existing output ancestor");
        return canonical(parent).resolve(path.getFileName()).normalize();
    }
    private static void validateOutputs(List<Path> inputs, List<Path> outputs, Path installation) throws IOException {
        Set<Path> seen = new HashSet<>();
        for (Path out : outputs) {
            Path resolved = canonical(out);
            if (resolved.startsWith(installation)) throw new IOException("Output is inside game installation: " + out);
            if (!seen.add(resolved)) throw new IOException("Duplicate output: " + out);
            for (Path input : inputs) if (resolved.equals(input) || (Files.exists(out) && Files.isSameFile(out, input)))
                throw new IOException("Output aliases input: " + out);
            for (Path other : outputs) if (!out.equals(other) && Files.exists(out) && Files.exists(other) && Files.isSameFile(out, other))
                throw new IOException("Outputs alias each other: " + out);
            if (Files.exists(out) && !Files.isRegularFile(out)) throw new IOException("Output is not a regular file: " + out);
        }
    }
    private static String hash(byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static void verifyInput(Path path, byte[] expected) throws Exception {
        if (!hash(expected).equals(hash(Files.readAllBytes(path)))) throw new IOException("Input changed: " + path);
    }
    private static String fileRecord(Path path, byte[] bytes) throws Exception {
        return "{\"path\":" + quote(path.toString()) + ",\"bytes\":" + bytes.length + ",\"sha256\":" + quote(hash(bytes)) + "}";
    }
    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
}
