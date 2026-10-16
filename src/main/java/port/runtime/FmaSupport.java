package port.runtime;

import java.math.BigInteger;

/** Exact binary32 fused multiply-add with one ties-to-even rounding. */
public final class FmaSupport {
    public static float fma(float a, float b, float c) {
        if (!Float.isFinite(a) || !Float.isFinite(b) || !Float.isFinite(c)) {
            return (float) ((double) a * (double) b + (double) c);
        }
        int aBits = Float.floatToRawIntBits(a);
        int bBits = Float.floatToRawIntBits(b);
        int cBits = Float.floatToRawIntBits(c);
        int productExponent = exponent(aBits) + exponent(bBits);
        int cExponent = exponent(cBits);
        int baseExponent = Math.min(productExponent, cExponent);
        BigInteger product = BigInteger.valueOf(mantissa(aBits)).multiply(BigInteger.valueOf(mantissa(bBits)));
        BigInteger sum = product.shiftLeft(productExponent - baseExponent)
                .add(BigInteger.valueOf(mantissa(cBits)).shiftLeft(cExponent - baseExponent));
        if (sum.signum() == 0) {
            // Floating zero arithmetic preserves -0 only when both summands are -0.
            return (float) ((double) a * (double) b + (double) c);
        }
        int sign = sum.signum() < 0 ? 0x80000000 : 0;
        BigInteger magnitude = sum.abs();
        int quantum = Math.max(-149, baseExponent + magnitude.bitLength() - 24);
        int shift = quantum - baseExponent;
        BigInteger rounded;
        if (shift <= 0) rounded = magnitude.shiftLeft(-shift);
        else {
            rounded = magnitude.shiftRight(shift);
            BigInteger remainder = magnitude.subtract(rounded.shiftLeft(shift));
            int halfComparison = remainder.compareTo(BigInteger.ONE.shiftLeft(shift - 1));
            if (halfComparison > 0 || halfComparison == 0 && rounded.testBit(0)) rounded = rounded.add(BigInteger.ONE);
        }
        if (rounded.signum() == 0) return Float.intBitsToFloat(sign);
        if (rounded.bitLength() > 24) {
            rounded = rounded.shiftRight(1);
            quantum++;
        }
        int topExponent = quantum + rounded.bitLength() - 1;
        if (topExponent > 127) return Float.intBitsToFloat(sign | 0x7f800000);
        if (topExponent < -126) return Float.intBitsToFloat(sign | rounded.intValue());
        return Float.intBitsToFloat(sign | (topExponent + 127) << 23 | (rounded.intValue() & 0x7fffff));
    }

    private static int exponent(int bits) {
        int exponent = (bits >>> 23) & 0xff;
        return exponent == 0 ? -149 : exponent - 150;
    }
    private static long mantissa(int bits) {
        long value = bits & 0x7fffff;
        if ((bits & 0x7f800000) != 0) value |= 0x800000;
        return bits < 0 ? -value : value;
    }
}
