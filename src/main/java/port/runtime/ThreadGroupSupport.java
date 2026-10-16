package port.runtime;

/** Thread group assignment follows creation-time ownership in one cooperative runtime. */
public final class ThreadGroupSupport {
    public static ThreadGroup currentGroup() {
        Thread current = Thread.currentThread();
        return current == null ? rootGroup() : groupOf(current);
    }
    public static ThreadGroup groupOf(Thread thread) {
        if (!thread.isAlive()) return null;
        ThreadGroup group = rawGroup(thread);
        return group == null ? rootGroup() : group;
    }
    public static void inherit(Thread thread) { assign(thread, null); }
    public static void assign(Thread thread, ThreadGroup group) {
        setGroup(thread, group == null ? currentGroup() : group);
    }
    private static native ThreadGroup rawGroup(Thread thread);
    private static native void setGroup(Thread thread, ThreadGroup group);
    private static native ThreadGroup rootGroup();
}
