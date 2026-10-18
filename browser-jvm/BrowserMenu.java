/** Browser-owned component entry around original front-end state and UI. */
public final class BrowserMenu {
    public static native void report(String json);
    public static native boolean stopping();

    public static void main(String[] args) {
        Throwable failure = null;
        BrowserMenuSession session = new BrowserMenuSession();
        try {
            if (args.length != 1) throw new IllegalArgumentException("Owned browser filesystem root required");
            session.open(args[0]);
            while (!stopping() && !zombie.GameWindow.closeRequested) {
                session.step();
                Thread.sleep(16);
            }
        } catch (Throwable error) {
            failure = error;
            error.printStackTrace();
        } finally {
            try { session.close(); }
            catch (Throwable cleanup) {
                if (failure == null) failure = cleanup;
                else failure.addSuppressed(cleanup);
            }
            if (failure == null) report("{\"pass\":true,\"frames\":" + session.frames
                    + ",\"frontEndTicks\":" + session.ticks() + ",\"originalMenuExited\":true,\"ownedCleanup\":true,\"fullGamePlayable\":false}");
            else report("{\"pass\":false,\"error\":" + BrowserMenuSession.quote(failure.toString()) + "}");
        }
    }
}
