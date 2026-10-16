package probe;

import port.host.BrowserFoodBootstrap;
import port.host.BrowserWorldBootstrap;
import zombie.characters.CharacterStat;
import zombie.inventory.InventoryItemFactory;

/** Runs actual script loading, inventory insertion and original player food consumption. */
public final class CheerpJFood {
    public static native void report(String json);

    public static void main(String[] args) {
        String stage = "player-bootstrap", outcome;
        try (BrowserWorldBootstrap session = BrowserWorldBootstrap.open()) {
            stage = "food-scripts";
            BrowserFoodBootstrap.load();
            stage = "item-factory";
            var item = InventoryItemFactory.CreateItem("Base.Apple");
            if (!(item instanceof zombie.inventory.types.Food)) throw new AssertionError("Original apple absent");
            var player = session.getPlayer();
            // These are the scenario's initial conditions; Eat computes every subsequent change.
            player.getStats().set(CharacterStat.HUNGER, .5f);
            player.getStats().set(CharacterStat.THIRST, .5f);
            player.getInventory().AddItem(item);
            float calories = player.getNutrition().getCalories();
            stage = "original-eat";
            if (!player.Eat(item, .5f)) throw new AssertionError("Original Eat rejected apple");
            float hunger = player.getStats().get(CharacterStat.HUNGER);
            float thirst = player.getStats().get(CharacterStat.THIRST);
            float caloriesDelta = player.getNutrition().getCalories() - calories;
            if (Math.abs(hunger - .42f) > .000001f || Math.abs(thirst - .465f) > .000001f
                    || caloriesDelta != 47.5f || item.getContainer() != player.getInventory())
                throw new AssertionError("Original consumption result differs");
            outcome = "{\"pass\":true,\"item\":\"Base.Apple\",\"originalPlayerEat\":true,\"hunger\":"
                + hunger + ",\"thirst\":" + thirst + ",\"caloriesDelta\":" + caloriesDelta
                + ",\"definitions\":" + zombie.scripting.ScriptManager.instance.getAllItems().size() + "}";
        } catch (Throwable failure) {
            failure.printStackTrace();
            outcome = "{\"pass\":false,\"stage\":\"" + stage + "\",\"error\":\""
                + failure.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"}";
        }
        report(outcome);
    }
}
