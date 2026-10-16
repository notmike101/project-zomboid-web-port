package probe;
import port.host.BrowserWorldBootstrap;
import zombie.characters.IsoPlayer;
import zombie.iso.Vector2;
public final class CheerpJWorld {
    public static native void report(String json);
    private static void awaitInput(IsoPlayer player, boolean down) throws Exception {
        long end = System.currentTimeMillis() + 15000;
        while (true) {
            zombie.input.GameKeyboard.poll(); zombie.input.GameKeyboard.update();
            zombie.input.GameKeyboard.poll(); zombie.input.GameKeyboard.update();
            player.getCharacterInputComponent().frameStep();
            Vector2 vector = player.getInputMoveVector(new Vector2());
            if (zombie.input.GameKeyboard.isKeyDown(17) == down) {
                if (down && (vector.x != 0 || vector.y != -1.95f))
                    throw new AssertionError("Original W vector differs: " + vector.x + "," + vector.y);
                if (!down && vector.getLengthSquared() != 0) throw new AssertionError("Released vector nonzero");
                return;
            }
            if (System.currentTimeMillis() > end) throw new AssertionError("DOM transition timed out");
            Thread.sleep(10);
        }
    }
    public static void main(String[] args) {
        String outcome;
        try (BrowserWorldBootstrap session = BrowserWorldBootstrap.open()) {
            IsoPlayer player = session.getPlayer();
            if (zombie.iso.IsoWorld.instance.currentCell != session.getCell()
                    || player.getX() != 0.5f || player.getY() != 0.5f || player.getZ() != 0)
                throw new AssertionError("Original cell/player ownership or spawn defaults differ");
            session.enterKeyboardInput();
            if (player.getInputMode() != zombie.characters.CharacterInputMode.KEYBOARD)
                throw new AssertionError("Original player did not enter keyboard mode");
            report("{\"phase\":\"press\"}"); awaitInput(player, true);
            report("{\"phase\":\"release\"}"); awaitInput(player, false);
            if (player.getX() != 0.5f || player.getY() != 0.5f) throw new AssertionError("Input qualification moved the player");
            outcome = "{\"pass\":true,\"actionStates\":92,\"initialState\":\"idle\",\"x\":0.5,\"y\":0.5,\"z\":0,\"originalPlayerKeyboardInput\":true,\"pressVector\":[0,-1.95],\"releaseVector\":[0,0],\"reuserThreadStopped\":true}";
        } catch (Throwable failure) {
            failure.printStackTrace();
            outcome = "{\"pass\":false,\"error\":\"" + failure.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"}";
        }
        report(outcome);
    }
}
