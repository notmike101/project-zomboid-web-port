package port.runtime;

import java.lang.reflect.Method;
import java.lang.reflect.Type;
import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.dependency.AbstractDependencyListener;
import org.teavm.dependency.DependencyAgent;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Missing generic API entries read actual mounted class-file signatures. */
public final class GenericMetadataPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.generics")) return;
        host.add(new AbstractDependencyListener() {
            @Override public void started(DependencyAgent agent) {
                var getName = agent.linkMethod(new MethodReference(Class.class, "getName", String.class));
                getName.use();
                getName.getVariable(0).propagate(agent.getType(ValueType.object("java.lang.Class")));
                var lookup = agent.linkMethod(new MethodReference(Class.class, "forName", String.class, Class.class));
                lookup.getResult().propagate(agent.getType(ValueType.object("java.lang.Class")));
                for (String name : GenericReflectionMetadata.registeredTypes()) {
                    agent.linkClass(name);
                    var type = agent.getType(ValueType.object(name));
                    // TeaVM's found-by-name policy does not itself retain each class's name field.
                    getName.getVariable(0).getClassValueNode().propagate(type);
                    lookup.getResult().getClassValueNode().propagate(type);
                }
            }
        });
        host.add((cls, context) -> {
            boolean superclass = cls.getName().equals("java.lang.Class");
            if (!superclass && !cls.getName().equals("java.lang.reflect.Method")) return;
            MethodDescriptor descriptor = superclass ? new MethodDescriptor("getGenericSuperclass", Type.class)
                    : new MethodDescriptor("getGenericExceptionTypes", Type[].class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Generic API already exists: " + descriptor);
            MethodHolder method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            cls.addMethod(method);
            ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
            if (superclass) body.invoke(GenericTypeSupport.class, "superclass", Type.class, body.var(0, Class.class)).returnValue();
            else body.invoke(GenericTypeSupport.class, "exceptionTypes", Type[].class, body.var(0, Method.class)).returnValue();
        });
    }
}
