package probe;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import org.teavm.classlib.impl.nio.Buffers;
import port.runtime.BrowserAssets;
import zombie.asset.AssetPath;
import zombie.core.textures.ImageData;
import zombie.core.textures.MipMapLevel;
import zombie.core.textures.TextureID;
import zombie.core.textures.TextureIDAssetManager;

/** Browser-only original image allocation and TextureID upload; not a full sprite renderer. */
public final class ImageTextureProbe {
    private static final String PATH = "/media/ui/avatarBackgroundWhite.png";

    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        byte[] source;
        try (FileInputStream input = new FileInputStream(PATH)) { source = input.readAllBytes(); }
        int sourceHash = Arrays.hashCode(source);
        if (source.length != 2335 || sourceHash != BrowserAssets.contentHash(PATH))
            throw failure("Original image asset differs");
        try (FileChannel channel = FileChannel.open(Path.of(PATH), StandardOpenOption.READ)) {
            ByteBuffer copy = ByteBuffer.allocate(source.length);
            while (copy.hasRemaining() && channel.read(copy) > 0) { }
            if (channel.size() != source.length || copy.hasRemaining() || !Arrays.equals(source, copy.array())
                    || channel.read(ByteBuffer.allocate(1)) != -1)
                throw failure("Read-only asset channel differs from stream bytes");
        }

        ImageData image;
        try (FileInputStream input = new FileInputStream(PATH)) { image = new ImageData(input, false); }
        int width = image.getWidth(), height = image.getHeight();
        int widthHw = image.getWidthHW(), heightHw = image.getHeightHW();
        if (width != 96 || height != 96 || widthHw != 128 || heightHw != 128)
            throw failure("Original ImageData logical or hardware dimensions differ");
        MipMapLevel level = image.getData();
        ByteBuffer data = level.getBuffer();
        byte[] expected = new byte[widthHw * heightHw * 4];
        if (data.remaining() != expected.length) throw failure("Original padded image buffer differs");
        for (int i = 0; i < expected.length; i++) expected[i] = data.get(data.position() + i);
        int opaque = 0;
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++)
            if ((expected[(y * widthHw + x) * 4 + 3] & 255) == 255) opaque++;
        if (opaque != width * height) throw failure("Original image RGB conversion differs");

        // The actual public params constructor explicitly defaults flags to zero:
        // no compression, mip generation, or maximum-size reduction is requested.
        TextureID texture = new TextureID(new AssetPath(PATH), TextureIDAssetManager.instance,
                new TextureID.TextureIDAssetParams());
        int framebuffer = 0;
        ByteBuffer readback = null;
        try {
            texture.setImageData(image);
            if (texture.getID() <= 0 || texture.getImageData() != null || !level.isDisposed())
                throw failure("Original render-context upload/disposal did not complete");
            framebuffer = GL30.glGenFramebuffers();
            GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, framebuffer);
            GL30.glFramebufferTexture2D(GL30.GL_FRAMEBUFFER, GL30.GL_COLOR_ATTACHMENT0,
                    GL11.GL_TEXTURE_2D, texture.getID(), 0);
            if (GL30.glCheckFramebufferStatus(GL30.GL_FRAMEBUFFER) != GL30.GL_FRAMEBUFFER_COMPLETE)
                throw failure("Original TextureID storage is not framebuffer complete");
            readback = ByteBuffer.allocateDirect(expected.length);
            GL11.glReadPixels(0, 0, widthHw, heightHw, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, readback);
            if (readback.position() != 0 || readback.limit() != expected.length || GL11.glGetError() != 0)
                throw failure("Original texture readback state differs");
            byte[] actual = new byte[expected.length];
            readback.get(actual);
            if (!Arrays.equals(expected, actual)) throw failure("Original TextureID upload changed image bytes");

            StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[{\"id\":\"")
                    .append(PATH).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", source.length); json.append(','); integer(json, "contentHash", sourceHash);
            json.append("}},{\"id\":\"original-image-texture-upload\",\"inputs\":[],\"outputs\":{");
            integer(json, "width", width); json.append(','); integer(json, "height", height); json.append(',');
            integer(json, "widthHw", widthHw); json.append(','); integer(json, "heightHw", heightHw); json.append(',');
            integer(json, "pixelHash", Arrays.hashCode(actual)); json.append(','); integer(json, "state", 7);
            System.out.println(json.append("}}],\"pass\":true}"));
        } finally {
            GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, 0);
            if (framebuffer != 0) GL30.glDeleteFramebuffers(framebuffer);
            if (texture.getID() > 0) GL11.glDeleteTextures(texture.getID());
            if (readback != null) Buffers.free(readback);
            if (!level.isDisposed()) image.dispose();
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
