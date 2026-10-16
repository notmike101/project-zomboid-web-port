package port.runtime;

import org.teavm.model.AccessLevel;
import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Supplies truthful native-library failure behavior on the browser target. */
public final class BrowserLibraryPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.nativeLibraries")) return;
        host.add((cls, context) -> {
            if (!cls.getName().equals("java.lang.System")) return;
            for (String name : new String[]{"load", "loadLibrary", "mapLibraryName"}) {
                Class<?> resultType = name.equals("mapLibraryName") ? String.class : void.class;
                MethodDescriptor descriptor = new MethodDescriptor(name, String.class, resultType);
                MethodHolder method = cls.getMethod(descriptor);
                if (method != null) throw new IllegalStateException("Native library API already exists: " + name);
                method = new MethodHolder(descriptor);
                method.setLevel(AccessLevel.PUBLIC);
                method.getModifiers().add(ElementModifier.STATIC);
                cls.addMethod(method);
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                if (resultType == String.class) body.invoke(BrowserLibrary.class, name, String.class, body.var(1, String.class)).returnValue();
                else {
                    body.invoke(BrowserLibrary.class, name, body.var(1, String.class));
                    body.exit();
                }
            }
        });
    }
}
