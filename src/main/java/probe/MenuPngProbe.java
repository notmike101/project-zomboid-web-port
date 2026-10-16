package probe;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import org.teavm.classlib.impl.nio.Buffers;
import port.runtime.BrowserAssets;
import zombie.core.textures.PNGDecoder;

/** Browser-only original menu asset decoding and actual texture/FBO byte round-trip, not a menu renderer. */
public final class MenuPngProbe {
    private static final String PATH = "/media/ui/avatarBackgroundWhite.png";

    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        byte[] fileBytes;
        try (FileInputStream input = new FileInputStream(PATH)) { fileBytes = input.readAllBytes(); }
        int fileHash = Arrays.hashCode(fileBytes);
        if (fileBytes.length != 2335 || fileHash != BrowserAssets.contentHash(PATH))
            throw failure("Mounted original menu PNG differs");
        ByteBuffer pixels = null;
        ByteBuffer readback = null;
        int texture = 0;
        int framebuffer = 0;
        try {
            int width;
            int height;
            try (FileInputStream input = new FileInputStream(PATH)) {
                PNGDecoder decoder = new PNGDecoder(input, false);
                width = decoder.getWidth();
                height = decoder.getHeight();
                if (width != 96 || height != 96 || decoder.isAnimated()) throw failure("Unexpected installed menu PNG dimensions");
                pixels = ByteBuffer.allocateDirect(width * height * 4);
                decoder.decode(pixels, width * 4, height, PNGDecoder.Format.RGBA, PNGDecoder.IDAT);
            }
            if (pixels.position() != pixels.capacity()) throw failure("Original PNG decoder did not fill RGBA rows");
            byte[] decoded = new byte[pixels.capacity()];
            pixels.rewind(); pixels.get(decoded); pixels.rewind();
            int opaque = 0;
            for (int index = 3; index < decoded.length; index += 4) if ((decoded[index] & 255) == 255) opaque++;
            // Installed PNG is RGB; original RGB-to-RGBA conversion must supply opaque alpha.
            if (opaque != width * height) throw failure("Original RGB conversion alpha differs");
            int pixelHash = Arrays.hashCode(decoded);

            if (GL11.glGetError() != 0) throw failure("Graphics backend started with an error");
            texture = GL11.glGenTextures();
            if (texture == 0) throw failure("Texture creation failed");
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, texture);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_NEAREST);
            GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_NEAREST);
            GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, width, height, 0,
                    GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixels);
            if (pixels.position() != 0) throw failure("Texture upload consumed the caller buffer position");
            framebuffer = GL30.glGenFramebuffers();
            if (framebuffer == 0) throw failure("Framebuffer creation failed");
            GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, framebuffer);
            GL30.glFramebufferTexture2D(GL30.GL_FRAMEBUFFER, GL30.GL_COLOR_ATTACHMENT0, GL11.GL_TEXTURE_2D, texture, 0);
            if (GL30.glCheckFramebufferStatus(GL30.GL_FRAMEBUFFER) != GL30.GL_FRAMEBUFFER_COMPLETE)
                throw failure("Uploaded texture framebuffer is incomplete");
            readback = ByteBuffer.allocateDirect(decoded.length);
            GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, readback);
            if (readback.position() != 0) throw failure("Framebuffer read changed caller buffer position");
            byte[] actual = new byte[decoded.length];
            readback.get(actual);
            int error = GL11.glGetError();
            if (error != 0 || !Arrays.equals(decoded, actual)) throw failure("Actual GPU texture bytes differ from original decoded PNG");
            StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-assets\",\"cases\":[{\"id\":\"")
                    .append(PATH).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", fileBytes.length); json.append(','); integer(json, "contentHash", fileHash);
            json.append("}},{\"id\":\"original-png-decoder\",\"inputs\":[],\"outputs\":{");
            integer(json, "width", width); json.append(','); integer(json, "height", height); json.append(',');
            integer(json, "pixelHash", pixelHash); json.append(','); integer(json, "opaquePixels", opaque);
            json.append("}},{\"id\":\"actual-texture-upload-readback\",\"inputs\":[],\"outputs\":{");
            integer(json, "pixelHash", Arrays.hashCode(actual)); json.append(','); integer(json, "error", error);
            System.out.println(json.append("}}],\"pass\":true}"));
        } catch (Exception failure) {
            System.out.println("Menu PNG failure: " + failure + "; cause=" + failure.getCause());
            throw failure;
        } finally {
            try {
                try {
                    if (framebuffer != 0) {
                        try { GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, 0); }
                        finally { GL30.glDeleteFramebuffers(framebuffer); }
                    }
                } finally {
                    if (texture != 0) {
                        try { GL11.glBindTexture(GL11.GL_TEXTURE_2D, 0); }
                        finally { GL11.glDeleteTextures(texture); }
                    }
                }
            } finally {
                try { if (readback != null) Buffers.free(readback); }
                finally { if (pixels != null) Buffers.free(pixels); }
            }
        }
    }
    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
