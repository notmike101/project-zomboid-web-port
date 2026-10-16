package port.runtime;

import java.util.Collection;
import java.util.Collections;
import org.teavm.classlib.ReflectionContext;
import org.teavm.classlib.ReflectionSupplier;

/** Retains only the three explicitly inspected instance-field handle targets. */
public final class MissingFieldMetadata implements ReflectionSupplier {
    @Override public Collection<String> getAccessibleFields(ReflectionContext context, String className) {
        return Boolean.getBoolean("port.fieldHandles")
                && (className.equals("zombie.util.LazyValue") || className.equals("probe.FieldHandleProbe$Holder")
                        || className.equals("probe.ForeignFieldHolder"))
                ? Collections.singletonList("value") : Collections.emptyList();
    }
}
