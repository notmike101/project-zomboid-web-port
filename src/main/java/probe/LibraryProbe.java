package probe;

import java.io.File;

/** Requests only deliberately nonexistent native names. No installed DLL is loaded. */
public final class LibraryProbe {
    public static void main(String[] args) {
        String missing = "codex_missing_6f029ebe_8ae4_493c_ba01_4feaf36b5675";
        String[] names = {"missing-name", "missing-absolute", "relative-path", "null-load", "null-load-library",
                "map-name", "map-empty", "null-map"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            int category;
            int flags;
            try {
                switch (i) {
                    case 0: System.loadLibrary(missing); break;
                    case 1: System.load(new File(System.getProperty("java.io.tmpdir"), missing + ".missing").getAbsolutePath()); break;
                    case 2: System.load(missing + ".missing"); break;
                    case 3: System.load(null); break;
                    case 4: System.loadLibrary(null); break;
                    case 7: System.mapLibraryName(null); break;
                    default:
                        String name = i == 5 ? missing : "";
                        String mapped = System.mapLibraryName(name);
                        flags = (mapped != null && !mapped.isEmpty() ? 1 : 0) | (mapped != null && mapped.contains(name) ? 2 : 0);
                        if (flags != 3) throw new AssertionError("Invalid library filename mapping");
                        category = 0;
                        if (i != 0) json.append(',');
                        appendCase(json, names[i], category, flags);
                        continue;
                }
                throw new AssertionError("Unavailable native library operation succeeded");
            } catch (UnsatisfiedLinkError failure) {
                if (i > 2) throw failure;
                category = 1;
                flags = failure.getMessage() != null && !failure.getMessage().isEmpty() ? 1 : 0;
                if (flags != 1) throw new AssertionError("Missing linkage diagnostic");
            } catch (NullPointerException failure) {
                if (i != 3 && i != 4 && i != 7) throw failure;
                category = 2;
                flags = 1;
            }
            if (i != 0) json.append(',');
            appendCase(json, names[i], category, flags);
        }
        System.out.println(json.append("]}"));
    }

    private static void appendCase(StringBuilder json, String name, int category, int flags) {
        json.append("{\"id\":\"").append(name).append("\",\"inputs\":[],\"outputs\":{\"category\":");
        append(json, category);
        json.append(",\"flags\":");
        append(json, flags);
        json.append("}}");
    }
    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
