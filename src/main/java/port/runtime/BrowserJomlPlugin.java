package port.runtime;

import org.teavm.model.MethodDescriptor;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Selects JOML's shipped NIO implementation on a platform without JVM Unsafe. */
public final class BrowserJomlPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.joml")) return;
        host.add((cls, context) -> {
            if (!cls.getName().equals("org.joml.MemUtil")) return;
            var method = cls.getMethod(new MethodDescriptor("createInstance", ValueType.object("org.joml.MemUtil")));
            if (method == null) throw new IllegalStateException("JOML provider selection changed");
            var body = ProgramEmitter.create(method, context.getHierarchy());
            body.construct("org.joml.MemUtil$MemUtilNIO").returnValue();
        });
    }
}
