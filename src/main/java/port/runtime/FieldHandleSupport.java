package port.runtime;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.Objects;

/** Reference field handles for a cooperative runtime with no shared worker heap. */
public final class FieldHandleSupport {
    private final Field field;

    private FieldHandleSupport(Field field) { this.field = field; }

    public static FieldHandleSupport find(Class<?> caller, Class<?> owner, String name, Class<?> type)
            throws NoSuchFieldException, IllegalAccessException {
        Objects.requireNonNull(caller);
        Objects.requireNonNull(owner);
        Objects.requireNonNull(name);
        Objects.requireNonNull(type);
        if (!(owner.getName().equals("zombie.util.LazyValue")
                || owner.getName().equals("probe.FieldHandleProbe$Holder")
                || owner.getName().equals("probe.ForeignFieldHolder"))) {
            throw new UnsupportedOperationException("Field handle metadata is not registered");
        }
        Field field = owner.getDeclaredField(name);
        if (field.getType() != type) throw new NoSuchFieldException(name);
        int modifiers = field.getModifiers();
        if (Modifier.isStatic(modifiers)) throw new IllegalAccessException("Instance field required");
        if (caller != owner && !(Modifier.isPublic(modifiers) && Modifier.isPublic(owner.getModifiers()))) {
            // Distinct top-level classes cannot be nestmates. Other access modes need more metadata.
            if (Modifier.isPrivate(modifiers) && caller.getName().indexOf('$') < 0 && owner.getName().indexOf('$') < 0) {
                throw new IllegalAccessException("Private field belongs to another top-level class");
            }
            throw new UnsupportedOperationException("Package, protected, nestmate, and module lookup modes are not implemented");
        }
        if (type.isPrimitive()) throw new UnsupportedOperationException("Reference fields only");
        field.setAccessible(true);
        return new FieldHandleSupport(field);
    }

    public Object getVolatile(Object receiver) {
        checkReceiver(receiver);
        try { return field.get(receiver); }
        catch (IllegalAccessException failure) { throw new IllegalStateException(failure); }
    }

    public Object compareAndExchange(Object receiver, Object expected, Object replacement) {
        checkReceiver(receiver);
        field.getType().cast(expected);
        field.getType().cast(replacement);
        if (Modifier.isFinal(field.getModifiers())) throw new UnsupportedOperationException("Final field is read-only");
        // shortcut: no yielding between field read and write, use atomics before cross-worker sharing.
        try {
            Object witness = field.get(receiver);
            if (witness == expected) field.set(receiver, replacement);
            return witness;
        } catch (IllegalAccessException failure) { throw new IllegalStateException(failure); }
    }

    private void checkReceiver(Object receiver) {
        field.getDeclaringClass().cast(Objects.requireNonNull(receiver));
    }
}
