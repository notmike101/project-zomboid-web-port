package port.runtime;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.IOException;

/** Opens the same truncating output used by PrintStream(File). */
public final class PrintStreamSupport {
    public static OutputStream open(File file) throws FileNotFoundException {
        return new FileOutputStream(file);
    }

    /** Implemented by transformed PrintStream with access to its existing fields. */
    public interface Access {
        OutputStream portOutput();
        void portOutput(OutputStream output);
        boolean portError();
        void portError(boolean error);
        boolean portClosing();
        void portClosing(boolean closing);
    }

    public static void close(PrintStream stream) {
        Access access = (Access) stream;
        if (access.portClosing()) return;
        access.portClosing(true);
        OutputStream output = access.portOutput();
        try {
            if (output != null) {
                stream.flush();
                output.close();
            }
        } catch (IOException failure) {
            access.portError(true);
        } finally {
            access.portOutput(null);
        }
    }

    public static boolean checkError(PrintStream stream) {
        Access access = (Access) stream;
        if (access.portOutput() != null) stream.flush();
        OutputStream output = access.portOutput();
        return output instanceof PrintStream ? ((PrintStream) output).checkError() : access.portError();
    }
}
