import java.nio.ByteBuffer;
import port.host.SpriteGraphics;

/** Portable authored-pixel qualification for a fresh owned browser WebGL context. */
public final class RedTextureQualification {
    private RedTextureQualification() { }

    public static native void report(String json);

    public static void main(String[] args) {
        try {
            qualify();
            report("{\"pass\":true,\"checks\":10,\"rgbaBytes\":24}");
        } catch (Throwable failure) {
            failure.printStackTrace();
            report("{\"pass\":false,\"error\":" + quote(failure.toString()) + "}");
        }
    }

    private static void qualify() {
        int depthFunction = SpriteGraphics.glGetInteger(0x0B74);
        boolean depthWrites = SpriteGraphics.glGetInteger(0x0B72) != 0;
        int texture = 0;
        int framebuffer = 0;
        try {
            SpriteGraphics.glDepthFunc(0x0206);
            require(SpriteGraphics.glGetInteger(0x0B74) == 0x0206, "Actual GEQUAL depth comparison");
            SpriteGraphics.glDepthMask(false);
            require(SpriteGraphics.glGetInteger(0x0B72) == 0, "Actual disabled depth writes");
            SpriteGraphics.glDepthMask(true);
            require(SpriteGraphics.glGetInteger(0x0B72) == 1, "Actual enabled depth writes");
            require(SpriteGraphics.glGetInteger(0x0CF5) == 4
                    && SpriteGraphics.glGetInteger(0x0CF2) == 0
                    && SpriteGraphics.glGetInteger(0x0CF3) == 0
                    && SpriteGraphics.glGetInteger(0x0CF4) == 0, "Fresh default unpack state");

            texture = SpriteGraphics.glGenTextures();
            framebuffer = SpriteGraphics.glGenFramebuffers();
            SpriteGraphics.glBindTexture(3553, texture);
            SpriteGraphics.glTexParameteri(3553, 10241, 9728);
            // Three RED pixels per row: one padding byte between rows, none after the final row.
            ByteBuffer source = ByteBuffer.allocateDirect(12);
            source.position(2);
            source.limit(9);
            int[] pixels = {10, 20, 30, 99, 40, 50, 60};
            for (int i = 0; i < pixels.length; i++) source.put(2 + i, (byte) pixels[i]);
            SpriteGraphics.glTexImage2D(3553, 0, 6403, 3, 2, 0, 6403, 5121, source);
            require(source.position() == 2 && source.limit() == 9, "Upload position and limit");
            source.limit(8);
            boolean rejected = false;
            try {
                SpriteGraphics.glTexImage2D(3553, 0, 6403, 3, 2, 0, 6403, 5121, source);
            } catch (IllegalArgumentException expected) {
                rejected = true;
            }
            require(rejected, "Short padded source must fail before upload");

            SpriteGraphics.glBindFramebuffer(36160, framebuffer);
            SpriteGraphics.glFramebufferTexture2D(36160, 36064, 3553, texture, 0);
            require(SpriteGraphics.glCheckFramebufferStatus(36160) == 36053, "Actual R8 framebuffer completeness");
            ByteBuffer output = ByteBuffer.allocateDirect(28);
            output.position(2);
            output.limit(26);
            SpriteGraphics.glReadPixels(0, 0, 3, 2, 6408, 5121, output);
            int[] red = {10, 20, 30, 40, 50, 60};
            for (int i = 0; i < red.length; i++) {
                for (int channel = 0; channel < 4; channel++) {
                    int expected = channel == 0 ? red[i] : channel == 3 ? 255 : 0;
                    require((output.get(2 + i * 4 + channel) & 255) == expected, "Actual RED framebuffer pixel");
                }
            }
            require(output.position() == 2 && output.limit() == 26, "Readback position and limit");
            require(SpriteGraphics.glGetError() == 0, "No OpenGL errors");
        } finally {
            SpriteGraphics.glBindFramebuffer(36160, 0);
            if (framebuffer != 0) SpriteGraphics.glDeleteFramebuffers(framebuffer);
            if (texture != 0) SpriteGraphics.glDeleteTextures(texture);
            SpriteGraphics.glDepthFunc(depthFunction);
            SpriteGraphics.glDepthMask(depthWrites);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '"' || ch == '\\') result.append('\\').append(ch);
            else if (ch < 32) result.append(String.format("\\u%04x", (int) ch));
            else result.append(ch);
        }
        return result.append('"').toString();
    }
}
