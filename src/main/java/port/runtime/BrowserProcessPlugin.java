package port.runtime;

import org.teavm.backend.wasm.TeaVMWasmGCHost;
import org.teavm.backend.wasm.model.instruction.WasmUnreachable;
import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ElementModifier;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Owned-worker exit uses a terminating WASM instruction, never a catchable Java exception. */
public final class BrowserProcessPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.workerProcess")) return;
        TeaVMWasmGCHost wasm = host.getExtension(TeaVMWasmGCHost.class);
        if (wasm == null) throw new IllegalStateException("Worker process exit requires WasmGC");
        wasm.contributeToCodeGen((context, registry) -> registry.bodyIntrinsics().registerIntrinsic(
                new MethodReference(BrowserProcess.class, "trap", void.class),
                (method, function) -> function.getBody().add(new WasmUnreachable())));
        host.add((cls, context) -> {
            if (!cls.getName().equals("java.lang.System")) return;
            MethodDescriptor descriptor = new MethodDescriptor("exit", int.class, void.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("System.exit changed; reassess the worker bridge");
            MethodHolder method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            method.getModifiers().add(ElementModifier.STATIC);
            cls.addMethod(method);
            ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
            body.invoke(BrowserProcess.class, "exit", body.var(1, int.class));
            body.exit();
        });
    }
}
