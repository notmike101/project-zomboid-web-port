package port.runtime;

import org.teavm.model.ElementModifier;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.After;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Explicit failure boundary for third-party native capabilities without a browser backend. */
@After({BrowserGraphicsPlugin.class, BrowserMemoryPlugin.class})
public final class NativeCapabilitiesPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.nativeCapabilities")) return;
        host.add((cls, context) -> {
            String name = cls.getName();
            if (!name.startsWith("org.lwjgl.") && !name.startsWith("imgui.")) return;
            for (var method : cls.getMethods()) {
                // Real bridges clear NATIVE before supplying their implementations.
                if (!method.getModifiers().contains(ElementModifier.NATIVE)) continue;
                method.getModifiers().remove(ElementModifier.NATIVE);
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                body.construct(UnsupportedOperationException.class,
                        body.constant("Browser native capability unavailable: " + name + "." + method.getDescriptor())).raise();
            }
        });
    }
}
