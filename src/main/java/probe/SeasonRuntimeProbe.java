package probe;

import java.util.TimeZone;
import zombie.erosion.season.ErosionSeason;

/** Browser-only original season lifecycle. Never run this entry point on a desktop JVM. */
public final class SeasonRuntimeProbe {
    public static void main(String[] args) {
        TimeZone.setDefault(TimeZone.getTimeZone("GMT"));
        // ErosionConfig.Season constructor defaults, passed in ErosionMain.init's original order.
        ErosionSeason season = new ErosionSeason();
        season.init(38, 25, 0, 7, 31, 12.5f, 64, 128, 255);
        season.setRain(0.39f, 0.35f, 0.39f, 0.4f, 0.35f, 0.37f,
                0.29f, 0.26f, 0.23f, 0.23f, 0.3f, 0.32f);
        if (season.getLat() != 38 || season.getTempMax() != 25 || season.getTempMin() != 0
                || season.getSeedA() != 64 || season.getSeedB() != 128 || season.getSeedC() != 255)
            throw new AssertionError("Original season configuration was not retained");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[");
        float summerDaylight = 0;
        int summerSeason = -1;
        for (int index = 0; index < 2; index++) {
            int month = index == 0 ? 5 : 11;
            season.setDay(21, month, 1993);
            float daylight = season.getDaylight();
            float dawn = season.getDawn();
            float dusk = season.getDusk();
            int currentSeason = season.getSeason();
            if (currentSeason < 1 || currentSeason >= ErosionSeason.NUM_SEASONS
                    || !(daylight > 0 && daylight < 24) || !(dawn >= 0 && dawn < dusk && dusk <= 24)
                    || Math.abs((dusk - dawn) - daylight) > 0.00001f)
                throw new AssertionError("Original season returned invalid daylight or season state");
            if (index == 0) {
                summerDaylight = daylight;
                summerSeason = currentSeason;
            } else if (!(summerDaylight > daylight + 3) || summerSeason == currentSeason) {
                throw new AssertionError("Original date update did not change northern seasonal state");
            }
            if (index != 0) json.append(',');
            json.append("{\"id\":\"").append(index == 0 ? "june-1993" : "december-1993")
                    .append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "season", currentSeason); json.append(',');
            output(json, "daylight", daylight); json.append(',');
            output(json, "dawn", dawn); json.append(',');
            output(json, "dusk", dusk); json.append(',');
            output(json, "temperature", season.getDayTemperature()); json.append(',');
            output(json, "meanTemperature", season.getDayMeanTemperature()); json.append(',');
            output(json, "noise", season.getDayNoiseVal()); json.append(',');
            output(json, "progression", season.getSeasonProgression()); json.append(',');
            output(json, "rainStrength", season.getRainDayStrength()); json.append(',');
            integer(json, "weather", (season.isRainDay() ? 1 : 0) | (season.isThunderDay() ? 2 : 0)
                    | (season.isSunnyDay() ? 4 : 0));
            json.append("}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static void output(StringBuilder json, String name, float value) {
        if (!Float.isFinite(value)) throw new AssertionError("Non-finite original season output: " + name);
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        bits(json, Float.floatToRawIntBits(value));
        json.append("\"}");
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        bits(json, value);
        json.append("\"}");
    }
    private static void bits(StringBuilder json, int value) {
        String hex = Integer.toHexString(value);
        for (int i = hex.length(); i < 8; i++) json.append('0');
        json.append(hex);
    }
}
