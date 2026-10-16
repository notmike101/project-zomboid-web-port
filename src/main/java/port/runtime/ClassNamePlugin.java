package port.runtime;

import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Supplies missing class-name queries using the existing actual class metadata. */
public final class ClassNamePlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        host.add((cls, context) -> {
            if (!cls.getName().equals("java.lang.Class")) return;
            MethodDescriptor descriptor = new MethodDescriptor("getPackageName", String.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Class.getPackageName already exists");
            MethodHolder method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            cls.addMethod(method);
            ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
            body.invoke(ClassNameSupport.class, "packageName", String.class, body.var(0, Class.class)).returnValue();
            descriptor = new MethodDescriptor("isAnonymousClass", boolean.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Class.isAnonymousClass already exists");
            method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            cls.addMethod(method);
            body = ProgramEmitter.create(method, context.getHierarchy());
            body.invoke(ClassNameSupport.class, "anonymousClass", boolean.class, body.var(0, Class.class)).returnValue();
        });
    }
}
