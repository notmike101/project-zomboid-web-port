package port.runtime;

import java.net.URL;
import java.util.Enumeration;
import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Adds resource discovery for the explicitly configured browser classpath. */
public final class ResourcePlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.resources")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals("java.lang.Class")) {
                var descriptor = new MethodDescriptor("getResource", String.class, URL.class);
                if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Class resource API already exists");
                var method = new MethodHolder(descriptor);
                method.setLevel(AccessLevel.PUBLIC);
                cls.addMethod(method);
                var body = ProgramEmitter.create(method, context.getHierarchy());
                body.invoke(ResourceSupport.class, "getClassResource", URL.class,
                        body.var(0, Class.class), body.var(1, String.class)).returnValue();
                return;
            }
            if (cls.getName().equals("java.lang.Package")) {
                for (String name : new String[]{"getSpecificationVersion", "getImplementationVersion"}) {
                    var descriptor = new MethodDescriptor(name, String.class);
                    if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Package metadata API already exists");
                    var method = new MethodHolder(descriptor);
                    method.setLevel(AccessLevel.PUBLIC);
                    cls.addMethod(method);
                    var body = ProgramEmitter.create(method, context.getHierarchy());
                    body.invoke(ResourceSupport.class, name, String.class, body.var(0, Package.class)).returnValue();
                }
                return;
            }
            if (!cls.getName().equals("java.lang.ClassLoader")) return;
            for (String name : new String[]{"getResource", "getResources"}) {
                Class<?> result = name.equals("getResource") ? URL.class : Enumeration.class;
                var descriptor = new MethodDescriptor(name, String.class, result);
                if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Resource API already exists: " + descriptor);
                var method = new MethodHolder(descriptor);
                method.setLevel(AccessLevel.PUBLIC);
                cls.addMethod(method);
                var body = ProgramEmitter.create(method, context.getHierarchy());
                body.invoke(ResourceSupport.class, name, result, body.var(1, String.class)).returnValue();
            }
        });
    }
}
