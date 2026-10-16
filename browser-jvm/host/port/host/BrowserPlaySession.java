package port.host;

import java.util.Objects;
import java.util.function.Consumer;
import org.lwjglx.opengl.Display;
import zombie.GameTime;
import zombie.GameWindow;
import zombie.characters.IsoPlayer;
import zombie.characters.IsoGameCharacter;
import zombie.input.GameKeyboard;
import zombie.iso.IsoCell;
import zombie.iso.IsoCamera;
import zombie.iso.IsoChunkMap;
import zombie.iso.IsoWorld;

/** Authored stepping owner around original input, time, entity scheduling and collision algorithms. */
public final class BrowserPlaySession implements AutoCloseable {
    private final BrowserWorldBootstrap world;
    private final IsoCell cell;
    private final IsoPlayer player;
    private final Thread owner;
    private final Consumer<String> progress;
    private final IsoPlayer previousInstance;
    private final IsoGameCharacter previousCamera;
    private boolean closed;
    private long frames;
    private String stage = "attach";

    public BrowserPlaySession(BrowserWorldBootstrap world) {
        this(world, ignored -> {});
    }

    public BrowserPlaySession(BrowserWorldBootstrap world, Consumer<String> progress) {
        this.world = Objects.requireNonNull(world, "world");
        this.progress = Objects.requireNonNull(progress, "progress");
        cell = world.getCell();
        player = world.getPlayer();
        owner = Thread.currentThread();
        requireWorld();
        if (!player.getAnimationPlayer().isReady()) throw new IllegalStateException("Original player animation is not ready");
        if (IsoPlayer.numPlayers != 1 || IsoPlayer.players[0] != null)
            throw new IllegalStateException("Expected an unoccupied original single-player slot");
        previousInstance = IsoPlayer.getInstance();
        previousCamera = IsoCamera.getCameraCharacter();
        // Original IsoWorld.Init registers its newly constructed local actor in this same order.
        IsoPlayer.setLocalPlayer(0, player);
        IsoPlayer.setInstance(player);
        try {
            IsoCamera.setCameraCharacter(player);
            world.enterKeyboardInput();
            progress.accept("original-ingame-model-registration");
            player.updateUsername();
            player.setSceneCulled(false);
            if (!player.isAddedToModelManager())
                throw new IllegalStateException("Original model manager did not register the actor");
        } catch (Throwable failure) {
            restoreRegistration();
            throw failure;
        }
    }

    /** Advances the original world lifecycle, including its frame identity and entity scheduler. */
    public void step() {
        requireOwner();
        requireWorld();
        if (IsoPlayer.players[0] != player || IsoPlayer.getInstance() != player)
            throw new IllegalStateException("Original local player registration changed");
        stage = "owned-browser-events";
        progress.accept(stage);
        Display.processMessages();
        stage = "original-keyboard";
        progress.accept(stage);
        GameKeyboard.poll();
        GameKeyboard.update();
        stage = "original-controller-cache";
        progress.accept(stage);
        GameWindow.GameInput.updateGameThread();
        stage = "original-game-time";
        progress.accept(stage);
        GameTime.getInstance().update(false);
        stage = "original-world-update";
        progress.accept(stage);
        IsoWorld.instance.update();
        stage = "original-finish-animation";
        progress.accept(stage);
        IsoWorld.instance.FinishAnimation();
        stage = "original-model-manager-update";
        progress.accept(stage);
        zombie.core.skinnedmodel.ModelManager.instance.update();
        frames++;
        stage = "original-frame-complete";
        progress.accept(stage);
        requireWorld();
    }

    /** Read-only state for the host status display and input/movement assertions. */
    public String snapshot() {
        requireOwner();
        var input = new zombie.iso.Vector2();
        player.getInputMoveVector(input);
        return "{\"frames\":" + frames + ",\"x\":" + player.getX() + ",\"y\":" + player.getY()
                + ",\"z\":" + player.getZ() + ",\"state\":\"" + escape(player.getActionContext().getCurrentStateName())
                + "\",\"tracks\":" + player.getAnimationPlayer().getMultiTrack().getTrackCount()
                + ",\"inputX\":" + input.x + ",\"inputY\":" + input.y + "}";
    }

    public IsoPlayer getPlayer() { requireOwner(); return player; }
    public String getStage() { return stage; }

    private void requireWorld() {
        if (IsoWorld.instance.currentCell != cell || !cell.getObjectList().contains(player))
            throw new IllegalStateException("Original player/cell ownership is not active");
        if (!Float.isFinite(player.getX()) || !Float.isFinite(player.getY()) || !Float.isFinite(player.getZ()))
            throw new IllegalStateException("Original player position is not finite");
        int x = (int) Math.floor(player.getX()), y = (int) Math.floor(player.getY()), z = (int) Math.floor(player.getZ());
        var square = cell.getGridSquare(x, y, z);
        if (square == null || square.getChunk() == null || !square.getChunk().loaded)
            throw new IllegalStateException("Original player square/chunk is not loaded");
        if (square.getChunk().wx != Math.floorDiv(x, IsoChunkMap.CHUNK_SIZE_IN_SQUARES)
                || square.getChunk().wy != Math.floorDiv(y, IsoChunkMap.CHUNK_SIZE_IN_SQUARES))
            throw new IllegalStateException("Original square resolved to a different chunk");
        if (square.getFloor() == null || !square.TreatAsSolidFloor())
            throw new IllegalStateException("Original spawn/current square has no solid floor");
        if (player.getCurrentSquare() != square)
            throw new IllegalStateException("Original player has not attached to its loaded current square");
    }

    private void requireOwner() {
        if (closed) throw new IllegalStateException("Play session is closed");
        if (Thread.currentThread() != owner) throw new IllegalStateException("Play session belongs to another Java thread");
    }

    /** Stops this stepping driver; the caller retains ownership of the world and renderer. */
    @Override public void close() {
        if (Thread.currentThread() != owner) throw new IllegalStateException("Play session belongs to another Java thread");
        if (closed) return;
        closed = true;
        try {
            if (player.isAddedToModelManager()) {
                player.setSceneCulled(true);
                zombie.core.skinnedmodel.ModelManager.instance.update();
            }
        } finally { restoreRegistration(); }
    }

    private void restoreRegistration() {
        if (IsoPlayer.players[0] == player) IsoPlayer.setLocalPlayer(0, null);
        if (IsoPlayer.getInstance() == player) IsoPlayer.setInstance(previousInstance);
        if (IsoCamera.getCameraCharacter() == player) {
            if (previousCamera == null) IsoCamera.clearCameraCharacter();
            else IsoCamera.setCameraCharacter(previousCamera);
        }
    }

    private static String escape(String value) {
        return value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
