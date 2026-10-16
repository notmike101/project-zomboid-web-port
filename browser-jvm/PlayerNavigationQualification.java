import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import port.host.BrowserPlaySession;
import se.krka.kahlua.vm.KahluaTable;
import zombie.Lua.LuaManager;
import zombie.pathfind.PathFindBehavior2.BehaviorResult;
import zombie.pathfind.PolygonalMap2;

/** Bounded qualification of the installed original walk action and normal player lifecycle. */
public final class PlayerNavigationQualification {
    private static final String[] SOURCES = {
        "shared/ISBaseObject.lua", "shared/TimedActions/ISBaseTimedAction.lua",
        "client/TimedActions/ISTimedActionQueue.lua", "client/TimedActions/WalkToTimedAction.lua"
    };

    public record Result(int frames, String json) { }

    private PlayerNavigationQualification() { }

    public static void mountAssets() throws Exception {
        for (String source : SOURCES) {
            Path destination = Path.of("/files/work/media/lua").resolve(source);
            Files.createDirectories(destination.getParent());
            Files.copy(Path.of("/app/media/lua").resolve(source), destination, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    public static Result run(BrowserPlaySession session) throws Exception {
        var player = session.getPlayer();
        float initialX = player.getX(), initialY = player.getY();
        float targetX = 151.5f, targetY = 156.5f;
        var map = PolygonalMap2.instance;
        if (!player.getCharacterActions().isEmpty() || player.pressedMovement(false) || player.pressedCancelAction()) {
            throw new AssertionError("Navigation requires the original released-input idle action queue");
        }
        if (Math.hypot(targetX - initialX, targetY - initialY) < .5
                || !map.canStandAt(targetX, targetY, 0, player, false, false)
                || map.lineClearCollide(initialX, initialY, targetX, targetY, 0, player)) {
            throw new AssertionError("Installed navigation target is not clear and standable");
        }
        // The true argument indexes paths without executing the rest of the client Lua tree.
        LuaManager.LoadDirBase("shared", true);
        LuaManager.LoadDirBase("client", true);
        for (String source : SOURCES) {
            LuaManager.RunLua("/files/work/media/lua/" + source);
        }
        if (!(LuaManager.env.rawget("ISWalkToTimedAction") instanceof KahluaTable)) {
            throw new AssertionError("Installed original walk action did not load");
        }
        Path command = Path.of("/files/work/private-navigation-command.lua");
        Files.writeString(command, "__portNavigationAction=ISWalkToTimedAction:new(getPlayer(),"
                + "getCell():getGridSquare(151,156,0)); ISTimedActionQueue.add(__portNavigationAction)");
        LuaManager.RunLua(command.toString());
        if (!(LuaManager.env.rawget("__portNavigationAction") instanceof KahluaTable action)
                || !(action.rawget("action") instanceof zombie.characters.CharacterTimedActions.LuaTimedActionNew)) {
            throw new AssertionError("Original queue did not construct its original Java timed action");
        }
        boolean moved = false, animated = false;
        long deadline = System.currentTimeMillis() + 20000;
        int frames = 0;
        Object result = null;
        while (frames < 300 && System.currentTimeMillis() < deadline) {
            session.step();
            frames++;
            result = action.rawget("result");
            moved |= Math.hypot(player.getX() - initialX, player.getY() - initialY) > .1;
            animated |= player.getActionContext().getCurrentStateName().equals("movement")
                    && player.getAnimationPlayer().getMultiTrack().getTrackCount() > 0;
            if (player.pressedMovement(false) || player.pressedCancelAction()) {
                throw new AssertionError("Unexpected host input during original navigation");
            }
            if (result == BehaviorResult.Succeeded || result == BehaviorResult.Failed) {
                break;
            }
            Thread.sleep(10);
        }
        if (result != BehaviorResult.Succeeded || !moved || !animated
                || Math.hypot(player.getX() - targetX, player.getY() - targetY) > .3) {
            throw new AssertionError("Original navigation failed: result=" + result + " moved=" + moved
                    + " animated=" + animated + " frames=" + frames + " position=" + player.getX() + "," + player.getY());
        }
        for (int index = 0; index < 3; index++) {
            session.step();
            Thread.sleep(10);
        }
        if (!player.getCharacterActions().isEmpty() || player.hasPath()
                || !player.getPathFindBehavior2().getIsCancelled()
                || !player.getActionContext().getCurrentStateName().equals("idle")) {
            throw new AssertionError("Original completed walk action did not clear its queue/path and return idle");
        }
        if (!(LuaManager.env.rawget("ISTimedActionQueue") instanceof KahluaTable service)
                || !(service.rawget("queues") instanceof KahluaTable queues)
                || !(queues.rawget(player) instanceof KahluaTable queue)
                || !(queue.rawget("queue") instanceof KahluaTable actions)
                || !actions.isEmpty() || queue.rawget("current") != null) {
            throw new AssertionError("Original completed walk action left its Lua queue/current action populated");
        }
        String json = "{\"pass\":true,\"navigationFrames\":" + frames + ",\"cleanupFrames\":3"
                + ",\"initialX\":" + initialX + ",\"initialY\":" + initialY
                + ",\"targetX\":" + targetX + ",\"targetY\":" + targetY
                + ",\"moved\":" + moved + ",\"animated\":" + animated
                + ",\"actionSucceeded\":true,\"actionQueueEmpty\":true,\"luaActionQueueEmpty\":true,\"pathCleared\":true,\"final\":" + session.snapshot() + "}";
        return new Result(frames + 3, json);
    }
}
