package port.host;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import zombie.core.znet.ZNet;

/** Routes the host logger to the unchanged original private Java callback. */
public final class BrowserZNet {
    private BrowserZNet() {}

    public static void deliver(String text) throws Throwable {
        Method callback = ZNet.class.getDeclaredMethod("logPutsCallback", String.class);
        callback.setAccessible(true);
        try {
            callback.invoke(null, text);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }
}
