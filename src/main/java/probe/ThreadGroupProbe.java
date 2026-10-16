package probe;

/** Standard-library group identity and cooperative child ownership, without game classes. */
public final class ThreadGroupProbe {
    public static void main(String[] args) throws Exception {
        ThreadGroup current = Thread.currentThread().getThreadGroup();
        ThreadGroup root = new ThreadGroup("probe-root");
        ThreadGroup child = new ThreadGroup(root, "probe-child");
        ThreadGroup sibling = new ThreadGroup(root, "probe-sibling");
        int hierarchy = (root.getParent() == current ? 1 : 0) | (child.getParent() == root ? 2 : 0)
                | (root.parentOf(child) && root.parentOf(root) ? 4 : 0)
                | (!child.parentOf(sibling) && !child.parentOf(null) ? 8 : 0)
                | ("probe-child".equals(child.getName()) ? 16 : 0);
        if (hierarchy != 31) throw new AssertionError("Thread group hierarchy differs");
        int[] observed = {0, 0};
        Thread worker = new Thread(child, () -> {
            Thread self = Thread.currentThread();
            observed[0] = (self.getThreadGroup() == child ? 1 : 0) | ("group-worker".equals(self.getName()) ? 2 : 0);
            Thread nested = new Thread(() -> {
                if (Thread.currentThread().getThreadGroup() == child) observed[1] |= 1;
            });
            if (nested.getThreadGroup() == child) observed[1] |= 2;
            nested.start();
            try { nested.join(2000); } catch (InterruptedException failure) { throw new AssertionError(failure); }
            if (nested.getThreadGroup() == null) observed[1] |= 4;
        });
        worker.setName("group-worker");
        if (worker.getThreadGroup() != child) throw new AssertionError("Explicit group absent before start");
        worker.start();
        worker.join(3000);
        if (worker.isAlive() || worker.getThreadGroup() != null || observed[0] != 3 || observed[1] != 7)
            throw new AssertionError("Thread group ownership differs");
        int validation = 0;
        try { new ThreadGroup(null, "invalid"); throw new AssertionError("Null parent accepted"); }
        catch (NullPointerException expected) { validation |= 1; }
        Thread inherited = new Thread((ThreadGroup) null, () -> { });
        if (inherited.getThreadGroup() == current) validation |= 2;
        ThreadGroup nullableName = new ThreadGroup(root, null);
        if (nullableName.getName() == null && nullableName.getParent() == root) validation |= 4;
        inherited.start(); inherited.join(2000);
        if (validation != 7) throw new AssertionError("Thread group validation differs");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        row(json, "hierarchy", hierarchy, root.getName().hashCode()); json.append(',');
        row(json, "explicit-worker", observed[0], worker.getName().hashCode()); json.append(',');
        row(json, "nested-inheritance", observed[1], worker.getThreadGroup() == null ? 1 : 0); json.append(',');
        row(json, "validation", validation, inherited.getThreadGroup() == null ? 1 : 0);
        System.out.println(json.append("]}"));
    }
    private static void row(StringBuilder json, String id, int checks, int detail) {
        json.append("{\"id\":\"").append(id).append("\",\"inputs\":[],\"outputs\":{");
        integer(json, "checks", checks); json.append(','); integer(json, "detail", detail); json.append("}}");
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
