package org.teavm.classlib.java.lang.management;

import java.util.List;

/** Only the runtime input-argument API is provided; this is not a complete JMX bean. */
public interface TRuntimeMXBean {
    List<String> getInputArguments();
}
