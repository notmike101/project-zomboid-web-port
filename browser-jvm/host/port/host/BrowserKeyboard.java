package port.host;
/** Physical keyboard adapter for an owned DOM canvas. */
public final class BrowserKeyboard {
 public static native boolean created();
 private static native int key(int glfwKey);
 public static boolean isKeyDown(int legacyKey){int translated=org.lwjglx.input.KeyCodes.toGlfwKey(legacyKey);if(translated==-1)return false;return key(translated)==1;}
}
