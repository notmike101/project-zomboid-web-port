package probe;

import zombie.iso.weather.SimplexNoise;
import zombie.iso.weather.fx.SteppedUpdateFloat;

/** Direct calls to shipped state transitions and noise. No gameplay implementation. */
public final class WeatherProbe {
    public static void main(String[] args) {
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-ieee754-raw-bits\",\"cases\":[");
        SteppedUpdateFloat state = new SteppedUpdateFloat(0.0f, 0.2f, 0.0f, 1.0f);
        String[] names = {"rise", "zero-delta", "rise-again", "overshoot-up",
                "hold-at-target", "fall", "overshoot-down", "hold-at-min"};
        float[] targets = {1, 1, 1, 1.5f, 1, 0, -0.5f, 0};
        float[] deltas = {1, 0, 1, 4, 1, 1, 9, 1};
        for (int i = 0; i < names.length; i++) {
            if (i != 0) json.append(',');
            json.append("{\"id\":\"step-").append(names[i]).append("\",\"inputs\":[");
            appendFloat(json, targets[i]);
            json.append(',');
            appendFloat(json, deltas[i]);
            state.setTarget(targets[i]);
            state.update(deltas[i]);
            json.append("],\"outputs\":{\"current\":");
            appendFloat(json, state.value());
            json.append(",\"target\":");
            appendFloat(json, state.getTarget());
            json.append("}}");
        }
        String[] noiseNames = {"origin", "ordinary", "negative", "mixed",
                "cell-below", "cell-at", "cell-above", "weather-scale"};
        double[][] points = {{0, 0, 0, 0}, {0.25, 0.5, 0.75, 0.125}, {-0.25, -0.5, -0.75, -0.125},
                {-1.25, 2.5, -0.75, 0.5}, {Math.nextDown(1.0), -1, 0, 0},
                {1, -1, 0, 0}, {Math.nextUp(1.0), -1, 0, 0}, {100.125, 0.001, 3.25, 0.5}};
        for (int i = 0; i < points.length; i++) {
            double[] p = points[i];
            json.append(",{\"id\":\"noise-").append(noiseNames[i]).append("\",\"inputs\":[");
            for (int j = 0; j < p.length; j++) {
                if (j != 0) json.append(',');
                appendDouble(json, p[j]);
            }
            json.append("],\"outputs\":{\"noise2D\":");
            appendDouble(json, SimplexNoise.noise(p[0], p[1]));
            json.append(",\"noise3D\":");
            appendDouble(json, SimplexNoise.noise(p[0], p[1], p[2]));
            json.append(",\"noise4D\":");
            appendDouble(json, SimplexNoise.noise(p[0], p[1], p[2], p[3]));
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void appendFloat(StringBuilder json, float value) {
        append(json, Float.toString(value), Integer.toHexString(Float.floatToRawIntBits(value)), 8);
    }

    private static void appendDouble(StringBuilder json, double value) {
        append(json, Double.toString(value), Long.toHexString(Double.doubleToRawLongBits(value)), 16);
    }

    private static void append(StringBuilder json, String value, String bits, int width) {
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < width; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
