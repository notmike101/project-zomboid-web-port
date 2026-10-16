package org.teavm.classlib.java.lang.management;

import java.util.List;

/** Reports this browser Wasm runtime's arguments, never the compiler JVM's arguments. */
public final class TManagementFactory {
    private static final TRuntimeMXBean RUNTIME = new BrowserRuntime();
    private TManagementFactory() { }

    public static TRuntimeMXBean getRuntimeMXBean() { return RUNTIME; }

    private static final class BrowserRuntime implements TRuntimeMXBean {
        private final List<String> arguments = List.of();
        @Override public List<String> getInputArguments() { return arguments; }
    }
}
