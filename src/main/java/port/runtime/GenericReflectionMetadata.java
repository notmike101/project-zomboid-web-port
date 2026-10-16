package port.runtime;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Set;
import org.teavm.classlib.ReflectionContext;
import org.teavm.classlib.ReflectionSupplier;
import org.teavm.model.MethodDescriptor;

/** Only the declared generic probe types are reflectively callable or discoverable. */
public final class GenericReflectionMetadata implements ReflectionSupplier {
    private static final Set<String> TYPES = Set.of("java.lang.Object", "java.lang.String", "java.lang.Number",
            "java.lang.Exception", "java.io.IOException", "java.util.List", "probe.GenericProbe",
            "probe.GenericProbe$Base", "probe.GenericProbe$Concrete", "probe.GenericProbe$Variable",
            "probe.GenericProbe$Throws", "probe.GenericProbe$Plain");
    static Set<String> registeredTypes() { return TYPES; }
    @Override public boolean isClassFoundByName(ReflectionContext context, String name) {
        return Boolean.getBoolean("port.generics") && TYPES.contains(name);
    }
    @Override public Collection<MethodDescriptor> getAccessibleMethods(ReflectionContext context, String name) {
        if (!Boolean.getBoolean("port.generics") || !name.startsWith("probe.GenericProbe$")) return Collections.emptyList();
        var cls = context.getClassSource().get(name);
        if (cls == null) return Collections.emptyList();
        Collection<MethodDescriptor> methods = new ArrayList<>();
        for (var method : cls.getMethods()) methods.add(method.getDescriptor());
        return methods;
    }
}
