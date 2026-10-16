package org.teavm.classlib.java.lang;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/** Command configuration is real; desktop subprocess launch is an unavailable host capability. */
public final class TProcessBuilder {
    private List<String> command;

    public TProcessBuilder(List<String> command) { this.command = Objects.requireNonNull(command); }
    public TProcessBuilder(String... command) { this.command = new ArrayList<>(Arrays.asList(command)); }
    public List<String> command() { return command; }
    public TProcessBuilder command(List<String> value) { command = Objects.requireNonNull(value); return this; }
    public TProcessBuilder command(String... value) { command = new ArrayList<>(Arrays.asList(value)); return this; }

    public Process start() throws IOException {
        String[] arguments = command.toArray(new String[0]);
        for (String argument : arguments) Objects.requireNonNull(argument);
        String executable = arguments[0];
        for (String argument : arguments) {
            if (argument.indexOf('\0') >= 0) throw new IOException("Invalid null character in command");
        }
        throw new IOException("Desktop subprocesses are unavailable in the browser: " + executable);
    }
}
