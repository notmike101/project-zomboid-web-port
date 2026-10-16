package port.runtime;

import java.util.Objects;

/** Package names follow the ultimate array component, including primitive and void classes. */
public final class ClassNameSupport {
    /** Anonymous classfiles have an enclosing class and an absent inner simple name. */
    public static boolean anonymousClass(Class<?> type) {
        Objects.requireNonNull(type);
        return !type.isArray() && !type.isPrimitive() && type.getEnclosingClass() != null
                && type.getSimpleName().isEmpty();
    }
    public static String packageName(Class<?> type) {
        Objects.requireNonNull(type);
        while (type.isArray()) type = type.getComponentType();
        if (type.isPrimitive()) return "java.lang";
        String name = type.getName();
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(0, dot).intern();
    }
}
