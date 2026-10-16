package org.teavm.classlib.java.nio.channels;

import java.io.IOException;

/** Lock ownership is limited to channels in this single browser agent. */
public class TFileLock implements AutoCloseable {
    private final TFileChannel channel;
    private final long position;
    private final long size;
    private final boolean shared;
    private boolean valid = true;
    protected TFileLock(TFileChannel channel, long position, long size, boolean shared) {
        java.util.Objects.requireNonNull(channel, "Null channel");
        if (position < 0 || size < 0 || position > Long.MAX_VALUE - size) throw new IllegalArgumentException();
        this.channel = channel; this.position = position; this.size = size; this.shared = shared;
    }
    public final TFileChannel channel() { return channel; }
    public TChannel acquiredBy() { return channel; }
    public final long position() { return position; }
    public final long size() { return size; }
    public final boolean isShared() { return shared; }
    public final boolean overlaps(long position, long size) {
        if (size < 0 || this.position + this.size <= position) return false;
        // In Java 25 a queried size of zero denotes an unbounded range.
        if (size > 0 && position <= Long.MAX_VALUE - size && position + size <= this.position) return false;
        return true;
    }
    public boolean isValid() { return valid && channel.isOpen(); }
    public void release() throws IOException {
        if (!channel.isOpen()) throw new TClosedChannelException();
        if (valid) { valid = false; channel.release(this); }
    }
    void invalidate() { valid = false; }
    public final void close() throws IOException { release(); }
    @Override public final String toString() {
        return getClass().getName() + "[" + position + ":" + size + " "
                + (shared ? "shared" : "exclusive") + " " + (isValid() ? "valid" : "invalid") + "]";
    }
}
