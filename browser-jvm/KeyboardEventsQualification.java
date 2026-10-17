import org.lwjglx.input.Keyboard;
import port.host.BrowserKeyboardEvents;
public final class KeyboardEventsQualification {
    static native void ready(int phase);
    static native void report(String text);
    public static void main(String[]args) {
        if (args.length != 0) {
            rejection();
            return;
        }
        try {
            Keyboard.create();
            if(!Keyboard.getKeyName(Keyboard.KEY_A).equals("A")||BrowserKeyboardEvents.scancodeQueries()<50)throw new AssertionError("Original portable fallback names");
            long previous=0;
            for(int phase=0;phase<10;phase++) {
                Keyboard.enableRepeatEvents(phase>=5);
                ready(phase);
                BrowserKeyboardEvents.poll();
                var q=zombie.input.GameKeyboard.getEventQueuePolling();
                StringBuilder events=new StringBuilder("[");
                while(q.next()) {
                    long now=q.getEventNanoseconds();
                    if(now<previous)throw new AssertionError("Clock regressed");
                    previous=now;
                    if(events.length()>1)events.append(',');
                    events.append("[").append(q.getEventKey()).append(',').append((int)q.getEventCharacter()).append(',').append(q.getEventKeyState()).append(']');
                }
                events.append(']');
                report("{\"phase\":"+phase+",\"events\":"+events+",\"xHeld\":"+Keyboard.isKeyDown(Keyboard.KEY_X)+",\"shiftHeld\":"+Keyboard.isKeyDown(Keyboard.KEY_LSHIFT)+"}");
            }
            ready(10);
            boolean caught=false,done=false;
            try {
                BrowserKeyboardEvents.poll();
            }
            catch(IllegalStateException expected) {
                caught=true;
            }
            finally {
                done=true;
            }
            if(!caught||!done)throw new AssertionError("Disposed finally");
            report("{\"pass\":true,\"disposedCaught\":true,\"finallyRan\":true,\"scancodeQueries\":"+BrowserKeyboardEvents.scancodeQueries()+"}");
        }
        catch(Throwable e) {
            e.printStackTrace();
            report("{\"pass\":false,\"error\":\""+e.toString().replace("\"","'")+"\"}");
        }
    }
    /** Authored negative input probes must reach Java catch and finally. */
    private static void rejection() {
        boolean caught = false, finished = false;
        ready(0);
        try {
            BrowserKeyboardEvents.poll();
        } catch (UnsupportedOperationException expected) {
            caught = true;
        } finally {
            finished = true;
        }
        report("{\"pass\":" + (caught && finished) +
            ",\"unsupportedCaught\":" + caught + ",\"finallyRan\":" + finished + "}");
    }

}
