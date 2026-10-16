package probe;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** Browser-only proof: validation and an explicit failed launch, never a desktop subprocess. */
public final class ProcessBoundaryProbe {
    public static void main(String[] args) throws Exception {
        List<String> command = new ArrayList<>(List.of("unavailable-browser-process-6f029ebe"));
        ProcessBuilder builder = new ProcessBuilder(command);
        if (builder.command() != command) throw new AssertionError("Command list ownership differs");
        command.add("argument");
        if (builder.command().size() != 2) throw new AssertionError("Command mutation lost");
        try {
            builder.start();
            throw new AssertionError("Desktop launch returned a process");
        } catch (IOException expected) {
            if (!expected.getMessage().startsWith("Desktop subprocesses are unavailable in the browser:"))
                throw new AssertionError("Missing unavailable-host diagnostic");
        }
        try { new ProcessBuilder((List<String>) null); throw new AssertionError("Null command accepted"); }
        catch (NullPointerException expected) { }
        try { new ProcessBuilder(new ArrayList<String>()).start(); throw new AssertionError("Empty command accepted"); }
        catch (IndexOutOfBoundsException expected) { }
        List<String> invalid = new ArrayList<>(); invalid.add(null);
        try { new ProcessBuilder(invalid).start(); throw new AssertionError("Null executable accepted"); }
        catch (NullPointerException expected) { }
        try { new ProcessBuilder("bad\0command").start(); throw new AssertionError("NUL executable accepted"); }
        catch (IOException expected) { }
        System.out.println("{\"pass\":true,\"rule\":\"exact-raw-bits\",\"category\":\"browser-process\",\"cases\":[{\"id\":\"unavailable-subprocess\",\"outputs\":{\"validation\":{\"value\":6,\"bits\":\"00000006\"},\"unavailable\":{\"value\":1,\"bits\":\"00000001\"}}}]}");
    }
}
