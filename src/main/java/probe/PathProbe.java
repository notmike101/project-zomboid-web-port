package probe;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;

/** Standard-library path checks. No filesystem access or game code. */
public final class PathProbe {
    public static void main(String[] args) {
        String[] names = {"relative-file", "empty-file", "empty-varargs", "multiple-varargs",
                "normalize-parent", "normalize-dot", "normalize-empty", "normalize-cancel",
                "leading-parent", "repeated-parent", "root-parent", "nested-parent",
                "resolve-empty-base", "resolve-root-base", "resolve-empty-other", "resolve-rooted-other",
                "null-first", "null-part", "null-array"};
        String[] expected = {"climate/colors.bin", "", "climate/colors",
                "climate/colors/interior/rgba.bin", "climate/final.bin", "climate/colors", "", "",
                "../colors", "../../colors", "/colors", "../colors", "colors", "/colors", "climate", "/colors"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            long measure;
            int hash;
            try {
                Path result = switch (i) {
                    case 0 -> new File("climate/colors.bin").toPath();
                    case 1 -> new File("").toPath();
                    case 2 -> Paths.get("climate").resolve("colors", new String[0]);
                    case 3 -> Paths.get("climate").resolve("colors", "interior", "rgba.bin");
                    case 4 -> Paths.get("climate/cache").resolve("..", "colors", "..", "final.bin").normalize();
                    case 5 -> Paths.get("./climate/./colors/.").normalize();
                    case 6 -> new File("").toPath().normalize();
                    case 7 -> Paths.get("climate/..").normalize();
                    case 8 -> Paths.get("../colors").normalize();
                    case 9 -> Paths.get("../../colors").normalize();
                    case 10 -> Paths.get(File.separator).resolve("..", "climate", "..", "colors").normalize();
                    case 11 -> Paths.get("../climate/../colors").normalize();
                    case 12 -> Paths.get("").resolve(Paths.get("colors"));
                    case 13 -> Paths.get(File.separator).resolve(Paths.get("colors"));
                    case 14 -> Paths.get("climate").resolve(Paths.get(""));
                    case 15 -> Paths.get("climate").resolve(Paths.get(File.separator + "colors"));
                    case 16 -> Paths.get("climate").resolve(null, new String[0]);
                    case 17 -> Paths.get("climate").resolve("colors", new String[]{"interior", null});
                    case 18 -> Paths.get("climate").resolve("colors", (String[]) null);
                    default -> throw new AssertionError("Unknown path case");
                };
                if (i >= expected.length) throw new AssertionError("Null path input accepted");
                // Compare logical relative paths across Windows and browser separators before hashing.
                String text = result.toString().replace('\\', '/');
                if (!text.equals(expected[i])) throw new AssertionError("Unexpected path: " + text);
                if (!result.normalize().normalize().equals(result.normalize())) throw new AssertionError("Normalization is not idempotent");
                measure = text.length();
                hash = text.hashCode();
            } catch (NullPointerException caught) {
                if (i < expected.length) throw caught;
                measure = 1;
                hash = "NullPointerException".hashCode();
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, Long.toString(measure), Long.toHexString(measure), 16);
            json.append(",\"contentHash\":");
            append(json, Integer.toString(hash), Integer.toHexString(hash), 8);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, String value, String bits, int width) {
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < width; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
