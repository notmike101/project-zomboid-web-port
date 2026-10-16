package port.runtime;

import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import org.teavm.runtime.fs.VirtualFileAccessor;

/** Shares the original output stream's accessor; never reopens or retruncates the file. */
public final class FileOutputChannelSupport {
    public static final class State {
        final File path;
        final boolean append;
        FileChannel channel;
        State(File path, boolean append) { this.path = path; this.append = append; }
    }
    public static void initialize(FileOutputStream stream, File path, boolean append) {
        setState(stream, new State(path, append));
    }
    public static FileChannel getChannel(FileOutputStream stream) {
        State state = state(stream);
        if (state == null) throw new UnsupportedOperationException("Output channel requires a pathname-backed stream");
        synchronized (state) {
            if (state.channel == null) {
                try { state.channel = create(accessor(stream), state.path, state.append, stream); }
                catch (IOException failure) { throw new IllegalStateException("Cannot share output stream channel", failure); }
            }
            return state.channel;
        }
    }
    public static void closeAttached(FileOutputStream stream) throws IOException {
        State state = state(stream);
        if (state != null && state.channel != null) state.channel.close();
    }
    public static void prepareWrite(FileOutputStream stream, int length) throws IOException {
        if (length == 0) return;
        State state = state(stream);
        if (state != null && state.append) {
            VirtualFileAccessor file = accessor(stream);
            file.seek(file.size());
        }
    }
    private static native State state(FileOutputStream stream);
    private static native void setState(FileOutputStream stream, State state);
    private static native VirtualFileAccessor accessor(FileOutputStream stream);
    private static native FileChannel create(VirtualFileAccessor accessor, File path, boolean append, Closeable owner) throws IOException;
}
