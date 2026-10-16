package port.runtime;

import java.util.Objects;

/** Reports unavailable desktop native loading without claiming a module was loaded. */
public final class BrowserLibrary {
    public static void load(String path) {
        Objects.requireNonNull(path);
        throw new UnsatisfiedLinkError("Browser runtime cannot load desktop native libraries: " + path);
    }
    public static void loadLibrary(String name) {
        Objects.requireNonNull(name);
        throw new UnsatisfiedLinkError("Browser runtime cannot load desktop native libraries: " + name);
    }
    public static String mapLibraryName(String name) {
        // Filename convention only. Dynamic Wasm native-module loading is not implemented.
        return Objects.requireNonNull(name) + ".wasm";
    }
}
