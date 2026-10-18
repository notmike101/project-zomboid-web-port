/** Checks the authored menu's JSON string transport without initializing the game. */
public final class BrowserMenuJsonQualification {
    public static void main(String[] args) {
        String input = "\t\0\"\\\n\r\u001f";
        String expected = "\"\\u0009\\u0000\\\"\\\\\\u000a\\u000d\\u001f\"";
        if (!expected.equals(BrowserMenuSession.quote(input))) {
            throw new AssertionError("Menu JSON control-character escaping");
        }
        System.out.println("MENU_JSON_PASS");
    }
}
