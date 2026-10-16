package port.runtime;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import org.teavm.classlib.ReflectionContext;
import org.teavm.classlib.ReflectionSupplier;
import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;

/** Opt-in original GameVersion public API, including inherited public Object methods. */
public final class ReflectionExposureMetadata implements ReflectionSupplier {
    @Override public Collection<MethodDescriptor> getAccessibleMethods(ReflectionContext context, String className) {
        if (!Boolean.getBoolean("port.reflectionExposure") || (!className.equals("zombie.core.GameVersion")
                && !className.equals("java.lang.Object"))) return Collections.emptyList();
        var cls = context.getClassSource().get(className);
        if (cls == null) throw new IllegalStateException("Reflection target missing: " + className);
        if (className.equals("java.lang.Object")) {
            // Public classlib implementation helpers are not Java Object APIs.
            // In particular, getObjectClassInfo is an inline-only native helper.
            var descriptors = java.util.List.of(
                    new MethodDescriptor("<init>", void.class),
                    new MethodDescriptor("getClass", Class.class),
                    new MethodDescriptor("hashCode", int.class),
                    new MethodDescriptor("equals", Object.class, boolean.class),
                    new MethodDescriptor("toString", String.class),
                    new MethodDescriptor("notify", void.class),
                    new MethodDescriptor("notifyAll", void.class),
                    new MethodDescriptor("wait", void.class),
                    new MethodDescriptor("wait", long.class, void.class),
                    new MethodDescriptor("wait", long.class, int.class, void.class));
            for (var descriptor : descriptors) {
                if (cls.getMethod(descriptor) == null)
                    throw new IllegalStateException("Java Object API missing: " + descriptor);
            }
            return descriptors;
        }
        ArrayList<MethodDescriptor> descriptors = new ArrayList<>();
        for (var method : cls.getMethods()) {
            if (method.getLevel() == AccessLevel.PUBLIC && !method.getName().equals("<clinit>"))
                descriptors.add(method.getDescriptor());
        }
        if (className.equals("zombie.core.GameVersion") && descriptors.size() != 12)
            throw new IllegalStateException("Inspected GameVersion API changed: " + descriptors.size());
        return descriptors;
    }
}
