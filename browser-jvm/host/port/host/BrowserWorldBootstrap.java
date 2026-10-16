package port.host;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import zombie.Lua.LuaManager;
import zombie.characters.IsoPlayer;
import zombie.core.Core;
import zombie.input.KeybindId;
import zombie.iso.IsoCell;

/** Owns one original browser world/player bootstrap and its actual reuser thread. */
public final class BrowserWorldBootstrap implements AutoCloseable {
    private final IsoCell cell;
    private final IsoPlayer player;
    private boolean closed;

    private BrowserWorldBootstrap(IsoCell cell, IsoPlayer player) {
        this.cell = cell;
        this.player = player;
    }

    /** Loads a real world into the one cell before the original player constructor runs. */
    @FunctionalInterface
    public interface WorldLoader {
        void load(IsoCell cell) throws Exception;
    }

    public static BrowserWorldBootstrap open() throws Exception {
        return openInternal(0, 0, 0, null);
    }

    /** Uses original initial placement; subsequent movement belongs exclusively to the game update loop. */
    public static BrowserWorldBootstrap openAt(int x, int y, int z, WorldLoader loader) throws Exception {
        return openInternal(x, y, z, Objects.requireNonNull(loader, "loader"));
    }

    private static BrowserWorldBootstrap openInternal(int x, int y, int z, WorldLoader loader) throws Exception {

        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        Path work = Path.of("/files/work");
        Files.createDirectories(work);
        // A bounded archive of genuine installed files. No saves are mounted.
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream("/app/player-assets.jar"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory() || entry.getName().startsWith("META-INF/")) continue;
                Path target = work.resolve(entry.getName()).normalize();
                if (!target.startsWith(work)) throw new IOException("Asset escapes browser work directory");
                Files.createDirectories(target.getParent());
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        zombie.ZomboidFileSystem.instance.init();
        LuaManager.init();
        try (Reader reader = new FileReader(work.resolve("media/lua/shared/NPCs/MainCreationMethods.lua").toFile())) {
            checkLua(LuaManager.thread.pcall(LuaCompiler.loadis(reader, "MainCreationMethods.lua", LuaManager.env), new Object[0]));
        }
        checkLua(LuaManager.thread.pcall(LuaCompiler.loadstring("BaseGameCharacterDetails.DoHairColor()", "character-bootstrap", LuaManager.env), new Object[0]));
        if (zombie.characters.SurvivorDesc.HairCommonColors.isEmpty()) throw new AssertionError("Original hair colors absent");
        zombie.core.skinnedmodel.population.HairStyles.init();
        zombie.core.skinnedmodel.population.BeardStyles.init();
        zombie.core.skinnedmodel.population.PopTemplateManager.instance.init();
        // Its original initializer registers the condition factories required while parsing groups.
        Class.forName("zombie.characters.action.ActionContext");
        if (zombie.characters.action.IActionCondition.s_factoryMap.size() != 12)
            throw new AssertionError("Original action-condition factories incomplete");
        var group = zombie.characters.action.ActionGroup.getActionGroup("player");
        if (group == null || group.getInitialState() == null || !"idle".equals(group.getInitialState().getName()))
            throw new AssertionError("Original player action group incomplete");
        var states = zombie.characters.action.ActionGroup.class.getDeclaredField("states");
        states.setAccessible(true);
        if (((List<?>) states.get(group)).size() != 92) throw new AssertionError("Expected all 92 installed player states");
        IsoCell cell = new IsoCell(10, 10);
        try {
            if (loader != null) loader.load(cell);
            // The original -nosound bootstrap option selects the game's real dummy emitter path.
            Core.soundDisabled = true;
            IsoPlayer player = loader == null ? new IsoPlayer(cell) : new IsoPlayer(cell, null, x, y, z);
            if (player.getActionContext().getGroup() != group || !"idle".equals(player.getActionContext().getCurrentStateName()))
                throw new AssertionError("Original player action context incomplete");
            var fishing = group.getInitialState().transitions.stream()
                    .filter(transition -> "fishing".equals(transition.getTransitionTo())).findFirst()
                    .orElseThrow(() -> new AssertionError("Installed fishing transition absent"));
            if (fishing.passes(player.getActionContext(), group.getInitialState()))
                throw new AssertionError("Original fishing transition passed without EventFishing");
            return new BrowserWorldBootstrap(cell, player);
        } catch (Throwable failure) {
            zombie.iso.WorldReuserThread.instance.stop();
            throw failure;
        }
    }

    private static void checkLua(Object[] result) {
        if (result.length == 0 || !Boolean.TRUE.equals(result[0])) throw new AssertionError(Arrays.toString(result));
    }

    public IsoPlayer getPlayer() { return player; }
    public IsoCell getCell() { return cell; }

    public void enterKeyboardInput() {
        if (closed) throw new IllegalStateException("World session closed");
        Core core = Core.getInstance();
        core.addKeyBinding(KeybindId.FORWARD, 17, 0, false, false, false);
        core.addKeyBinding(KeybindId.BACKWARD, 31, 0, false, false, false);
        core.addKeyBinding(KeybindId.LEFT, 30, 0, false, false, false);
        core.addKeyBinding(KeybindId.RIGHT, 32, 0, false, false, false);
        player.getCharacterInputComponent().onInGameStateEnter();
    }

    @Override public void close() {
        if (!closed) {
            zombie.iso.WorldReuserThread.instance.stop();
            closed = true;
        }
    }
}
