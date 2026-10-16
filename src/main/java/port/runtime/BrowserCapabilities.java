package port.runtime;

import org.lwjgl.opengl.GLCapabilities;

/** Metadata for the selected browser wrappers, not a claim of a desktop GL version.
 * Every desktop version/extension flag is false and native entry addresses are zero.
 */
public final class BrowserCapabilities {
    private static GLCapabilities descriptor;
    private BrowserCapabilities() { }

    public static GLCapabilities get() {
        BrowserGraphics.initialize();
        if (descriptor == null) descriptor = createDescriptor();
        return descriptor;
    }

    /** Compiler intrinsic constructs the vendor descriptor with Java's zero defaults. */
    private static native GLCapabilities createDescriptor();
}
