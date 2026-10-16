package port.host;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.EnumSet;
import zombie.scripting.ScriptType;
import zombie.world.WorldDictionary;

/** Mounts the actual food definitions and their required evolved recipes. */
public final class BrowserFoodBootstrap {
    private BrowserFoodBootstrap() { }

    public static void load() throws Exception {
        String[] sources = {
            "media/scripts/generated/items/food.txt",
            "media/scripts/generated/evolvedrecipes.txt",
            "media/scripts/generated/recipes/recipes_fishing_evolvedrecipe.txt"
        };
        for (String name : sources) {
            Path destination = Path.of("/files/work").resolve(name);
            Files.createDirectories(destination.getParent());
            Files.copy(Path.of("/app").resolve(name), destination, StandardCopyOption.REPLACE_EXISTING);
        }
        zombie.ZomboidFileSystem.instance.init();
        WorldDictionary.StartScriptLoading();
        ScriptBootstrap.load(EnumSet.of(ScriptType.Item, ScriptType.EvolvedRecipe), sources);
        WorldDictionary.ScriptsLoaded();
    }
}
