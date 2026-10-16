package org.teavm.classlib.java.security;

import java.nio.ByteBuffer;
import org.teavm.classlib.java.lang.TObject;

public abstract class TMessageDigestSpi extends TObject {
    protected int engineGetDigestLength() { return 0; }
    protected abstract void engineUpdate(byte value);
    protected abstract void engineUpdate(byte[] input, int offset, int length);
    protected abstract byte[] engineDigest();
    protected abstract void engineReset();

    protected void engineUpdate(ByteBuffer input) {
        while (input.hasRemaining()) engineUpdate(input.get());
    }

    protected int engineDigest(byte[] output, int offset, int length) throws TDigestException {
        byte[] digest = engineDigest();
        if (length < digest.length || offset < 0 || offset > output.length - digest.length) {
            throw new TDigestException("Insufficient digest output space");
        }
        System.arraycopy(digest, 0, output, offset, digest.length);
        return digest.length;
    }
}
