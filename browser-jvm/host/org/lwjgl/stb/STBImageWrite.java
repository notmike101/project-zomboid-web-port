package org.lwjgl.stb;

import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Objects;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/** File PNG output for original screenshots; scratch storage is one row plus 32 KiB. */
public final class STBImageWrite {
    // shortcut: Callback encoders and other formats remain unsupported until their original callers are admitted.
    private static volatile boolean flip;
    private STBImageWrite() { }

    public static void stbi_flip_vertically_on_write(boolean value) { flip = value; }

    public static boolean stbi_write_png(CharSequence filename, int width, int height, int channels,
                                         ByteBuffer pixels, int stride) {
        Objects.requireNonNull(filename, "filename");
        Objects.requireNonNull(pixels, "pixels");
        if (width <= 0 || height <= 0 || channels < 1 || channels > 4)
            throw new IllegalArgumentException("Invalid PNG dimensions/channels");
        int rowBytes = Math.multiplyExact(width, channels);
        if (stride == 0) stride = rowBytes;
        long required = (long) (height - 1) * stride + rowBytes;
        if (stride < rowBytes || required > pixels.remaining())
            throw new IllegalArgumentException("PNG source buffer too short or overlapping rows");
        ByteBuffer source = pixels.duplicate();
        int start = source.position();
        boolean flipped = flip;
        byte[] row = new byte[Math.addExact(rowBytes, 1)], compressed = new byte[32768];
        Deflater encoder = new Deflater();
        try (DataOutputStream out = new DataOutputStream(Files.newOutputStream(Path.of(filename.toString())))) {
            out.writeLong(0x89504e470d0a1a0aL);
            byte[] header = ByteBuffer.allocate(13).putInt(width).putInt(height)
                .put((byte) 8).put((byte) new int[]{0, 0, 4, 2, 6}[channels]).put(new byte[3]).array();
            chunk(out, "IHDR", header, header.length);
            for (int y = 0; y < height; y++) {
                source.position(start + (flipped ? height - 1 - y : y) * stride);
                source.get(row, 1, rowBytes);
                encoder.setInput(row);
                while (!encoder.needsInput()) {
                    int count = encoder.deflate(compressed);
                    if (count > 0) chunk(out, "IDAT", compressed, count);
                }
            }
            encoder.finish();
            while (!encoder.finished()) {
                int count = encoder.deflate(compressed);
                if (count > 0) chunk(out, "IDAT", compressed, count);
            }
            chunk(out, "IEND", compressed, 0);
            return true;
        } catch (IOException exception) {
            return false;
        } finally {
            encoder.end();
        }
    }

    private static void chunk(DataOutputStream out, String type, byte[] bytes, int count) throws IOException {
        byte[] name = type.getBytes(StandardCharsets.US_ASCII);
        out.writeInt(count);
        out.write(name);
        out.write(bytes, 0, count);
        CRC32 crc = new CRC32();
        crc.update(name);
        crc.update(bytes, 0, count);
        out.writeInt((int) crc.getValue());
    }
}
