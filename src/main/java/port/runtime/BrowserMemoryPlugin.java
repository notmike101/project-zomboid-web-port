package port.runtime;

import java.nio.Buffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import org.teavm.interop.Address;
import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Bounded native-memory backend: unsupported operations fail before desktop code can run. */
public final class BrowserMemoryPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.browserMemory")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals(BrowserMemory.class.getName())) {
                var method = cls.getMethod(new MethodDescriptor("baseAddress", Buffer.class, Address.class));
                if (method == null) throw new IllegalStateException("BrowserMemory.baseAddress changed");
                method.getModifiers().remove(ElementModifier.NATIVE);
                var body = ProgramEmitter.create(method, context.getHierarchy());
                body.var(1, Buffer.class).cast(ValueType.object("java.nio.file.AddressBasedBuffer"))
                        .invokeVirtual("getDataAddress", Address.class).returnValue();
                return;
            }
            if (!cls.getName().equals("org.lwjgl.system.MemoryUtil")) return;
            for (var method : cls.getMethods()) {
                method.getModifiers().remove(ElementModifier.NATIVE);
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                String name = method.getName();
                ValueType[] signature = method.getDescriptor().getSignature();
                if (name.equals("<clinit>")) {
                    // Wasm's allocation page is 64 KiB; desktop allocator/Unsafe state is unused.
                    body.setField("org.lwjgl.system.MemoryUtil", "PAGE_SIZE", body.constant(65536));
                    body.exit();
                } else if ((name.equals("memAllocFloat") || name.equals("memAllocInt")) && signature.length == 2 && signature[0].equals(ValueType.INTEGER)) {
                    body.invoke(BrowserMemory.class, name, name.equals("memAllocFloat") ? FloatBuffer.class : IntBuffer.class, body.var(1, int.class)).returnValue();
                } else if (name.equals("memFree") && signature.length == 2 &&
                        (signature[0].equals(ValueType.object("java.nio.FloatBuffer")) || signature[0].equals(ValueType.object("java.nio.IntBuffer")))) {
                    Class<?> type = signature[0].equals(ValueType.object("java.nio.FloatBuffer")) ? FloatBuffer.class : IntBuffer.class;
                    body.invoke(BrowserMemory.class, "memFree", body.var(1, type));
                    body.exit();
                } else if (name.equals("memAddress") && signature.length == 2 &&
                        (signature[0].equals(ValueType.object("java.nio.Buffer")) || signature[0].equals(ValueType.object("java.nio.FloatBuffer")) || signature[0].equals(ValueType.object("java.nio.IntBuffer")))) {
                    body.invoke(BrowserMemory.class, "memAddress", long.class, body.var(1, Buffer.class)).returnValue();
                } else {
                    body.construct(UnsupportedOperationException.class,
                            body.constant("Browser memory backend does not support MemoryUtil." + method.getDescriptor())).raise();
                }
            }
        });
    }
}
