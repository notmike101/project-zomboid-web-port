package org.lwjgl.stb;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Objects;
import port.host.SpriteGraphics;
import zombie.GameWindow;
import zombie.core.opengl.RenderThread;
import zombie.core.textures.PNGDecoder;
import zombie.gameStates.GameLoadingState;

/** Real PNG subset of STBImage for the browser JVM. Other image encodings fail explicitly. */
public final class STBImage {
    private static volatile boolean flip;
    private static final ThreadLocal<Boolean> threadFlip = new ThreadLocal<>();
    private static final ThreadLocal<String> failure = new ThreadLocal<>();
    private static final Map<ByteBuffer, Boolean> images = new IdentityHashMap<>();
    private STBImage() { }

    public static void stbi_set_flip_vertically_on_load(boolean value) { flip = value; }
    public static void stbi_set_flip_vertically_on_load_thread(boolean value) { threadFlip.set(value); }
    public static String stbi_failure_reason() { return failure.get(); }

    public static ByteBuffer stbi_load(CharSequence filename, int[] x, int[] y, int[] channels, int desired) {
        Objects.requireNonNull(filename, "filename");
        check(x); check(y); check(channels); checkDesired(desired);
        try (InputStream stream = Files.newInputStream(Path.of(filename.toString()))) {
            ByteBuffer image = decode(stream, x, y, channels, desired);
            if (filename.toString().replace('\\', '/').startsWith("/app/media/depthmaps/DEPTH_")) {
                synchronized (images) { images.put(image, Boolean.TRUE); }
            }
            return image;
        } catch (IOException | RuntimeException exception) {
            failure.set(exception.toString());
            return null;
        }
    }

    /** Decodes the encoded bytes remaining in the supplied buffer without moving its position. */
    public static ByteBuffer stbi_load(ByteBuffer encoded, int[] x, int[] y, int[] channels, int desired) {
        Objects.requireNonNull(encoded, "encoded");
        check(x); check(y); check(channels); checkDesired(desired);
        byte[] data = new byte[encoded.remaining()];
        encoded.duplicate().get(data);
        try (InputStream stream = new ByteArrayInputStream(data)) {
            return decode(stream, x, y, channels, desired);
        } catch (IOException | RuntimeException exception) {
            failure.set(exception.toString());
            return null;
        }
    }

    public static ByteBuffer stbi_load(CharSequence filename, IntBuffer x, IntBuffer y, IntBuffer channels, int desired) {
        check(x); check(y); check(channels);
        int[] width = new int[1], height = new int[1], count = new int[1];
        ByteBuffer result = stbi_load(filename, width, height, count, desired);
        if (result != null) { put(x, width[0]); put(y, height[0]); put(channels, count[0]); }
        return result;
    }

    public static ByteBuffer stbi_load(ByteBuffer encoded, IntBuffer x, IntBuffer y, IntBuffer channels, int desired) {
        check(x); check(y); check(channels);
        int[] width = new int[1], height = new int[1], count = new int[1];
        ByteBuffer result = stbi_load(encoded, width, height, count, desired);
        if (result != null) { put(x, width[0]); put(y, height[0]); put(channels, count[0]); }
        return result;
    }

    public static void stbi_image_free(ByteBuffer image) {
        if (image == null) return;
        Boolean depthMap;
        synchronized (images) {
            depthMap = images.remove(image);
            if (depthMap == null) throw new IllegalArgumentException("Foreign or released STB image");
        }
        SpriteGraphics.memFree(image);
        if (depthMap) {
            long queuedBytes = SpriteGraphics.allocationSnapshot()[1];
            if (queuedBytes > 64L * 1024 * 1024 && RenderThread.isRunning()
                    && GameWindow.states.current instanceof GameLoadingState) {
                // Drain queued tile uploads between decoded PNGs, outside the direct-buffer allocator lock.
                RenderThread.invokeOnRenderContext(() -> {});
                System.out.println("PORT-TILE-DEPTH-UPLOAD-DRAIN " + queuedBytes + " " + SpriteGraphics.allocationSnapshot()[1]);
            }
        }
    }

    private static ByteBuffer decode(InputStream stream, int[] x, int[] y, int[] channels, int desired) throws IOException {
        PNGDecoder decoder = new PNGDecoder(stream, false);
        if (decoder.isAnimated()) throw new IOException("Browser STB PNG subset does not support animated PNG");
        int width = decoder.getWidth(), height = decoder.getHeight();
        int natural = (decoder.isRGB() ? 3 : 1) + (decoder.hasAlpha() ? 1 : 0);
        int count = desired == 0 ? natural : desired;
        PNGDecoder.Format format = decoder.decideTextureFormat(PNGDecoder.Format.RGBA);
        int sourceChannels = format.getNumComponents();
        Boolean localFlip = threadFlip.get();
        boolean flipped = localFlip == null ? flip : localFlip;
        boolean copyRGBA = format == PNGDecoder.Format.RGBA && count == 4 && !flipped;
        boolean directRGBA = copyRGBA && decoder.isRGB() && decoder.hasAlphaChannel();
        int resultBytes = Math.multiplyExact(Math.multiplyExact(width, height), count);
        ByteBuffer result = SpriteGraphics.memAlloc(resultBytes);
        try {
            if (directRGBA) {
                // Original PNGDecoder accepts direct output; avoid a second full RGBA image.
                decoder.decode(result, Math.multiplyExact(width, sourceChannels), height, format, PNGDecoder.IDAT);
            } else {
                ByteBuffer source = ByteBuffer.allocate(Math.multiplyExact(Math.multiplyExact(width, height), sourceChannels));
                decoder.decode(source, Math.multiplyExact(width, sourceChannels), height, format, PNGDecoder.IDAT);
                byte[] sourcePixels = source.array();
                byte[] pixels = copyRGBA ? sourcePixels : new byte[Math.multiplyExact(width, count)];
                if (!copyRGBA) {
                    for (int row = 0; row < height; row++) {
                        int destination = 0;
                        int sourceRow = flipped ? height - row - 1 : row;
                        for (int column = 0; column < width; column++) {
                            int at = (sourceRow * width + column) * sourceChannels;
                            int r, g, b, a = 255;
                            if (format == PNGDecoder.Format.LUMINANCE || format == PNGDecoder.Format.LUMINANCE_ALPHA) {
                                r = g = b = sourcePixels[at] & 255;
                                if (sourceChannels == 2) a = sourcePixels[at + 1] & 255;
                            } else if (format == PNGDecoder.Format.RGB || format == PNGDecoder.Format.RGBA) {
                                r = sourcePixels[at] & 255; g = sourcePixels[at + 1] & 255; b = sourcePixels[at + 2] & 255;
                                if (sourceChannels == 4) a = sourcePixels[at + 3] & 255;
                            } else throw new IOException("Unsupported original PNG decoder output: " + format);
                            if (count <= 2) {
                                pixels[destination++] = (byte) ((77 * r + 150 * g + 29 * b) >> 8);
                                if (count == 2) pixels[destination++] = (byte) a;
                            } else {
                                pixels[destination++] = (byte) r;
                                pixels[destination++] = (byte) g;
                                pixels[destination++] = (byte) b;
                                if (count == 4) pixels[destination++] = (byte) a;
                            }
                        }
                        result.put(pixels);
                    }
                } else {
                    result.put(pixels);
                }
            }
            result.flip();
            synchronized (images) { images.put(result, Boolean.FALSE); }
            if (x != null) x[0] = width;
            if (y != null) y[0] = height;
            if (channels != null) channels[0] = natural;
            return result;
        } catch (IOException | RuntimeException | Error exception) {
            SpriteGraphics.memFree(result);
            throw exception;
        }
    }

    private static void checkDesired(int desired) {
        if (desired < 0 || desired > 4) throw new IllegalArgumentException("Channels must be 0..4");
    }
    private static void check(int[] output) {
        if (output != null && output.length < 1) throw new IllegalArgumentException("Image dimension output is empty");
    }
    private static void check(IntBuffer output) {
        if (output != null && (!output.hasRemaining() || output.isReadOnly())) throw new IllegalArgumentException("Image dimension output is not writable");
    }
    private static void put(IntBuffer output, int value) { if (output != null) output.put(output.position(), value); }
}
