package org.teavm.classlib.java.lang;

import java.util.Objects;
import port.runtime.ThreadGroupSupport;

/** Real name/parent identities for cooperative threads; no cross-worker sharing or invented counters. */
public class TThreadGroup extends TObject {
    private static final TThreadGroup SYSTEM = new TThreadGroup(null, "system", true);
    private static final TThreadGroup MAIN = new TThreadGroup(SYSTEM, "main", true);
    private final TThreadGroup parent;
    private final String name;

    private TThreadGroup(TThreadGroup parent, String name, boolean root) {
        this.parent = parent;
        this.name = name;
    }
    public TThreadGroup(String name) {
        this((TThreadGroup) (Object) ThreadGroupSupport.currentGroup(), name);
    }
    public TThreadGroup(TThreadGroup parent, String name) {
        this.parent = Objects.requireNonNull(parent);
        this.name = name;
    }
    public final String getName() { return name; }
    public final TThreadGroup getParent() { return parent; }
    public final boolean parentOf(TThreadGroup group) {
        for (TThreadGroup ancestor = group; ancestor != null; ancestor = ancestor.parent) {
            if (ancestor == this) return true;
        }
        return false;
    }
}
