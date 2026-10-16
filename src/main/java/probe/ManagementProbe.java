package probe;

import java.lang.management.ManagementFactory;
import java.lang.management.RuntimeMXBean;
import java.util.List;

/** Browser-only management facts. A JVM baseline would describe a different runtime. */
public final class ManagementProbe {
    public static void main(String[] args) {
        RuntimeMXBean runtime = ManagementFactory.getRuntimeMXBean();
        if (runtime == null || runtime != ManagementFactory.getRuntimeMXBean()) throw new AssertionError("Runtime bean identity differs");
        List<String> arguments = runtime.getInputArguments();
        if (arguments == null || !arguments.isEmpty() || arguments.iterator().hasNext()) throw new AssertionError("Browser unexpectedly claims JVM command-line arguments");
        try { arguments.add("-Dmust-not-be-added"); throw new AssertionError("Runtime arguments are mutable"); }
        catch (UnsupportedOperationException expected) { }
        try { arguments.addAll(List.of("-Xmust-not-be-added")); throw new AssertionError("Runtime arguments accept bulk mutation"); }
        catch (UnsupportedOperationException expected) { }
        if (!runtime.getInputArguments().isEmpty()) throw new AssertionError("Argument mutation escaped validation");
        System.out.println("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[{\"id\":\"browser-runtime-arguments\",\"inputs\":[],\"outputs\":{\"argumentCount\":{\"value\":0,\"bits\":\"00000000\"},\"state\":{\"value\":7,\"bits\":\"00000007\"}}}],\"pass\":true}");
    }
}
