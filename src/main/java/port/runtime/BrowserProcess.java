package port.runtime;

import org.teavm.jso.JSBody;

/** Terminates this owned worker runtime. JVM shutdown hooks are not implemented here. */
public final class BrowserProcess {
    public static void exit(int status) {
        closeWorker(status);
        trap();
    }

    @JSBody(params = "status", script = """
            if (typeof DedicatedWorkerGlobalScope === 'undefined'
                    || !(self instanceof DedicatedWorkerGlobalScope)
                    || self.portOwnedRuntime !== true) {
                throw new Error('System.exit requires an owned dedicated worker');
            }
            self.portExited = true;
            self.postMessage({type: 'runtime-exit', code: status | 0});
            self.close();
            """)
    private static native void closeWorker(int status);

    private static native void trap();
}
