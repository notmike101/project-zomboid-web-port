package org.teavm.classlib.java.awt;

import org.teavm.classlib.java.lang.TObject;
import org.teavm.classlib.java.lang.TCloneable;
import org.teavm.classlib.java.lang.TCloneNotSupportedException;
import org.teavm.classlib.java.io.TSerializable;

/** Bounded integer rectangle API; does not provide the AWT Shape hierarchy. */
public class TRectangle extends TObject implements TCloneable, TSerializable {
    public int x;
    public int y;
    public int width;
    public int height;

    public TRectangle() { }
    public TRectangle(int x, int y, int width, int height) { setBounds(x, y, width, height); }
    public void setBounds(int x, int y, int width, int height) {
        this.x = x; this.y = y; this.width = width; this.height = height;
    }
    public double getX() { return x; }
    public double getY() { return y; }
    public double getWidth() { return width; }
    public double getHeight() { return height; }
    public boolean contains(int px, int py) {
        return width > 0 && height > 0 && px >= x && py >= y
                && px < (long) x + width && py < (long) y + height;
    }
    public boolean contains(TRectangle r) {
        return width > 0 && height > 0 && r.width > 0 && r.height > 0
                && r.x >= x && r.y >= y && (long) r.x + r.width <= (long) x + width
                && (long) r.y + r.height <= (long) y + height;
    }
    public boolean intersects(TRectangle r) {
        return width > 0 && height > 0 && r.width > 0 && r.height > 0
                && (long) r.x + r.width > x && (long) r.y + r.height > y
                && (long) x + width > r.x && (long) y + height > r.y;
    }
    public TRectangle union(TRectangle r) {
        if ((width | height) < 0) return new TRectangle(r.x, r.y, r.width, r.height);
        if ((r.width | r.height) < 0) return new TRectangle(x, y, width, height);
        int left = Math.min(x, r.x), top = Math.min(y, r.y);
        long right = Math.max((long) x + width, (long) r.x + r.width);
        long bottom = Math.max((long) y + height, (long) r.y + r.height);
        return new TRectangle(left, top, cap(right - left), cap(bottom - top));
    }
    public void add(TRectangle r) {
        // Preserve the JDK's pre-reshape dimension locals for negative extents.
        long right = width, bottom = height;
        if ((right | bottom) < 0) setBounds(r.x, r.y, r.width, r.height);
        long otherRight = r.width, otherBottom = r.height;
        if ((otherRight | otherBottom) < 0) return;
        int left = Math.min(x, r.x), top = Math.min(y, r.y);
        right = Math.max(right + x, otherRight + r.x);
        bottom = Math.max(bottom + y, otherBottom + r.y);
        setBounds(left, top, cap(right - left), cap(bottom - top));
    }
    private static int cap(long value) { return (int) Math.min(value, Integer.MAX_VALUE); }
    @Override public Object clone() {
        try { return super.clone(); }
        catch (TCloneNotSupportedException impossible) { throw new AssertionError(impossible); }
    }
    @Override public String toString() {
        return getClass().getName() + "[x=" + x + ",y=" + y + ",width=" + width + ",height=" + height + "]";
    }
}
