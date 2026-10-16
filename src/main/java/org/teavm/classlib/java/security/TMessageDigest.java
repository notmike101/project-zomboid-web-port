package org.teavm.classlib.java.security;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Objects;

/** Bounded SHA-1 implementation for resource checksums, using FIPS 180-4 section 6.1. */
public abstract class TMessageDigest extends TMessageDigestSpi {
    private final String algorithm;

    protected TMessageDigest(String algorithm) { this.algorithm = algorithm; }

    public static TMessageDigest getInstance(String algorithm) throws TNoSuchAlgorithmException {
        Objects.requireNonNull(algorithm);
        if (!algorithm.equalsIgnoreCase("SHA-1") && !algorithm.equalsIgnoreCase("SHA1")) {
            throw new TNoSuchAlgorithmException("Unsupported digest: " + algorithm);
        }
        return new Sha1(algorithm);
    }

    public void update(byte value) { engineUpdate(value); }
    public void update(byte[] input) { engineUpdate(input, 0, input.length); }
    public void update(byte[] input, int offset, int length) {
        if (input == null || input.length - offset < length) throw new IllegalArgumentException("Invalid digest input buffer");
        engineUpdate(input, offset, length);
    }
    public final void update(ByteBuffer input) { engineUpdate(Objects.requireNonNull(input)); }
    public byte[] digest() { return engineDigest(); }
    public byte[] digest(byte[] input) { update(input); return digest(); }
    public int digest(byte[] output, int offset, int length) throws TDigestException {
        if (output == null || output.length - offset < length) throw new IllegalArgumentException("Invalid digest output buffer");
        return engineDigest(output, offset, length);
    }
    public void reset() { engineReset(); }
    public final String getAlgorithm() { return algorithm; }
    public final int getDigestLength() { return engineGetDigestLength(); }

    public static boolean isEqual(byte[] left, byte[] right) {
        if (left == right) return true;
        if (left == null || right == null) return false;
        if (right.length == 0) return left.length == 0;
        int difference = left.length ^ right.length;
        for (int i = 0; i < left.length; i++) difference |= left[i] ^ right[i < right.length ? i : 0];
        return difference == 0;
    }

    private static final class Sha1 extends TMessageDigest {
        private final byte[] block = new byte[64];
        private final int[] words = new int[80];
        private final int[] hash = new int[5];
        private int used;
        private long bytes;

        Sha1(String algorithm) { super(algorithm); engineReset(); }
        @Override protected int engineGetDigestLength() { return 20; }

        @Override protected void engineUpdate(byte value) {
            block[used++] = value;
            bytes++;
            if (used == block.length) { compress(); used = 0; }
        }

        @Override protected void engineUpdate(byte[] input, int offset, int length) {
            if (length == 0) return;
            if (offset < 0 || length < 0 || offset > input.length - length) throw new ArrayIndexOutOfBoundsException();
            bytes += length;
            while (length > 0) {
                int count = Math.min(length, block.length - used);
                System.arraycopy(input, offset, block, used, count);
                used += count;
                offset += count;
                length -= count;
                if (used == block.length) { compress(); used = 0; }
            }
        }

        @Override protected byte[] engineDigest() {
            long bits = bytes << 3;
            block[used++] = (byte) 0x80;
            if (used > 56) {
                Arrays.fill(block, used, block.length, (byte) 0);
                compress();
                used = 0;
            }
            Arrays.fill(block, used, 56, (byte) 0);
            for (int i = 0; i < 8; i++) block[56 + i] = (byte) (bits >>> (56 - i * 8));
            compress();
            byte[] result = new byte[20];
            for (int i = 0; i < result.length; i++) result[i] = (byte) (hash[i / 4] >>> (24 - (i % 4) * 8));
            engineReset();
            return result;
        }

        @Override protected int engineDigest(byte[] output, int offset, int length) throws TDigestException {
            if (length < 20 || offset < 0 || offset > output.length - length) throw new TDigestException("Insufficient SHA-1 output space");
            System.arraycopy(engineDigest(), 0, output, offset, 20);
            return 20;
        }

        @Override protected void engineReset() {
            hash[0] = 0x67452301; hash[1] = 0xefcdab89; hash[2] = 0x98badcfe;
            hash[3] = 0x10325476; hash[4] = 0xc3d2e1f0;
            used = 0;
            bytes = 0;
            Arrays.fill(block, (byte) 0);
        }

        private void compress() {
            for (int i = 0; i < 16; i++) {
                int offset = i * 4;
                words[i] = (block[offset] & 255) << 24 | (block[offset + 1] & 255) << 16
                        | (block[offset + 2] & 255) << 8 | block[offset + 3] & 255;
            }
            for (int i = 16; i < words.length; i++) words[i] = Integer.rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
            int a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4];
            for (int i = 0; i < words.length; i++) {
                int function;
                int constant;
                if (i < 20) { function = b & c | ~b & d; constant = 0x5a827999; }
                else if (i < 40) { function = b ^ c ^ d; constant = 0x6ed9eba1; }
                else if (i < 60) { function = b & c | b & d | c & d; constant = 0x8f1bbcdc; }
                else { function = b ^ c ^ d; constant = 0xca62c1d6; }
                int next = Integer.rotateLeft(a, 5) + function + e + constant + words[i];
                e = d; d = c; c = Integer.rotateLeft(b, 30); b = a; a = next;
            }
            hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d; hash[4] += e;
        }
    }
}
