package org.teavm.classlib.java.nio.file;

public final class TStandardWatchEventKinds {
    public static final TWatchEvent.Kind<Object> OVERFLOW = new Kind<>("OVERFLOW", Object.class);
    public static final TWatchEvent.Kind<TPath> ENTRY_CREATE = new Kind<>("ENTRY_CREATE", TPath.class);
    public static final TWatchEvent.Kind<TPath> ENTRY_DELETE = new Kind<>("ENTRY_DELETE", TPath.class);
    public static final TWatchEvent.Kind<TPath> ENTRY_MODIFY = new Kind<>("ENTRY_MODIFY", TPath.class);
    private TStandardWatchEventKinds() { }
    private static final class Kind<T> implements TWatchEvent.Kind<T> {
        private final String name;
        private final Class<T> type;
        Kind(String name, Class<T> type) { this.name = name; this.type = type; }
        @Override public String name() { return name; }
        @Override public Class<T> type() { return type; }
    }
}
