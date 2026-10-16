package probe;

import org.lwjgl.opengl.GL11C;

/** Browser-only check of truthful third-party native failure; requires the real WebGL bridge. */
public final class NativeCapabilitiesProbe {
    public static void main(String[] args) {
        int failures = 0;
        int signature = 0;
        try {
            GL11C.glFinish();
            throw new AssertionError("Unsupported glFinish returned successfully");
        } catch (UnsupportedOperationException expected) {
            failures++;
            String message = expected.getMessage();
            if (message != null && message.equals("Browser native capability unavailable: org.lwjgl.opengl.GL11C.glFinish()V")) signature = 1;
            else {
                System.out.println("Unexpected capability diagnostic: " + message);
                throw new AssertionError("Missing exact unsupported native signature");
            }
        }
        // The capability plugin must not replace this supported native graphics bridge.
        if (GL11C.glGetError() != 0) throw new AssertionError("Real graphics bridge reports an error");
        if (failures != 1 || signature != 1) throw new AssertionError("Capability failure contract");
        System.out.println("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-native-capabilities\",\"cases\":[{\"id\":\"unsupported-native\",\"inputs\":[],\"outputs\":{\"measure\":{\"value\":1,\"bits\":\"00000001\"},\"contentHash\":{\"value\":1,\"bits\":\"00000001\"}}}],\"pass\":true}");
    }
}
