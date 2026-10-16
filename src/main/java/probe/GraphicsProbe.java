package probe;

import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL20;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import org.teavm.jso.JSExport;
import port.runtime.BrowserGraphics;
import zombie.core.Color;
import zombie.core.rendering.ShaderParameter;
import org.lwjgl.util.vector.Vector4f;

/** Browser-only graphics assertions. Never run this entry point on a desktop JVM. */
public final class GraphicsProbe {
    private static int program;
    private static int colorLocation;

    public static void main(String[] args) {
        initializeShader();
        int badShader = GL20.glCreateShader(0x8B30);
        GL20.glShaderSource(badShader, "#version 300 es\ninvalid shader source");
        GL20.glCompileShader(badShader);
        if (GL20.glGetShaderi(badShader, 0x8B81) != 0 || GL20.glGetShaderInfoLog(badShader, 4096).isEmpty()) throw failure("Shader compile failure was not reported");
        GL20.glDeleteShader(badShader);
        int badProgram = GL20.glCreateProgram();
        GL20.glLinkProgram(badProgram);
        if (GL20.glGetProgrami(badProgram, 0x8B82) != 0 || GL20.glGetProgramInfoLog(badProgram, 4096).isEmpty()) throw failure("Program link failure was not reported");
        GL20.glDeleteProgram(badProgram);
        float[][] colors = {{1, 0, 0, 1}, {0, 1, 0, 1}, {0.25f, 0.5f, 0.75f, 0.75f}, {-1, 2, 0.25f, 1}};
        StringBuilder json = new StringBuilder("{\"category\":\"browser-graphics\",\"cases\":[");
        for (int i = 0; i < colors.length; i++) {
            if (i != 0) json.append(',');
            float[] c = colors[i];
            json.append(render(c[0], c[1], c[2], c[3], true));
        }
        GL11.glEnable(-1);
        int invalidEnum = GL11.glGetError();
        int consumed = GL11.glGetError();
        if (invalidEnum != 0x0500 || consumed != 0) throw failure("WebGL error state differs: " + invalidEnum + "," + consumed);
        System.out.println(json.append("],\"invalidEnum\":").append(invalidEnum)
                .append(",\"consumedError\":").append(consumed).append(",\"pass\":true}"));
    }

    @JSExport
    public static String renderColor(float red, float green, float blue, float brightness) {
        return render(red, green, blue, brightness, false);
    }

    private static String render(float red, float green, float blue, float brightness, boolean exactPixels) {
        if (!Float.isFinite(red) || !Float.isFinite(green) || !Float.isFinite(blue)
                || !Float.isFinite(brightness) || brightness < 0 || brightness > 1) {
            throw new IllegalArgumentException("Expected finite colors and brightness between zero and one");
        }
        Color color = new Color(red, green, blue, 1);
        color.scale(brightness);
        GL11.glDisable(0x0BD0);
        GL11.glClearColor(0, 0, 0, 0);
        GL11.glClear(0x4000);
        GL11.glClearColor(color.r, color.g, color.b, color.a);
        initializeShader();
        GL20.glUseProgram(program);
        ShaderParameter parameter = new ShaderParameter("instancedStructs[0].color[0]", new Vector4f(color.r, color.g, color.b, color.a));
        if (!parameter.name.equals("color")) throw failure("Original shader parameter name normalization differs");
        parameter.offset = colorLocation;
        parameter.PushUniform();
        GL11.glDrawArrays(0x0004, 0, 3);
        int[] actual = BrowserGraphics.readPixel();
        float[] values = {color.r, color.g, color.b, color.a};
        float[] clearState = BrowserGraphics.clearState();
        float[] uniformState = BrowserGraphics.uniformState(program, colorLocation);
        StringBuilder json = new StringBuilder("{\"pixels\":[");
        for (int i = 0; i < actual.length; i++) {
            if (Float.floatToRawIntBits(clearState[i]) != Float.floatToRawIntBits(values[i])) {
                throw failure("WebGL clear state differs from original float channel " + i);
            }
            if (Float.floatToRawIntBits(uniformState[i]) != Float.floatToRawIntBits(values[i])) throw failure("Shader uniform differs from original float channel " + i);
            // Fixed cases avoid half-byte positions. Interactive UNORM readback permits one byte; clear-state bits remain exact.
            int expected = Math.round(values[i] * 255);
            if (Math.abs(actual[i] - expected) > (exactPixels ? 0 : 1)) throw failure("Framebuffer channel " + i + " differs: " + actual[i] + " != " + expected + "; original float=" + values[i]);
            if (i != 0) json.append(',');
            json.append(actual[i]);
        }
        int error = GL11.glGetError();
        if (error != 0) throw failure("WebGL operation error: " + error);
        json.append("],\"clearStateBits\":[");
        for (int i = 0; i < values.length; i++) {
            if (i != 0) json.append(',');
            json.append('"').append(Integer.toHexString(Float.floatToRawIntBits(clearState[i]))).append('"');
        }
        json.append("],\"uniformStateBits\":[");
        for (int i = 0; i < values.length; i++) {
            if (i != 0) json.append(',');
            json.append('"').append(Integer.toHexString(Float.floatToRawIntBits(uniformState[i]))).append('"');
        }
        return json.append("],\"shaderDraw\":true,\"originalParameter\":true,\"exactPixels\":").append(exactPixels).append(",\"error\":0}").toString();
    }

    private static void initializeShader() {
        if (program != 0) return;
        int vertex = compile(0x8B31, """
                #version 300 es
                uniform mat4 transform;
                void main() {
                    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
                    gl_Position = transform * vec4(p * 2.0 - 1.0, 0.0, 1.0);
                }
                """);
        int fragment = compile(0x8B30, """
                #version 300 es
                precision highp float;
                uniform vec4 color;
                out vec4 pixel;
                void main() { pixel = color; }
                """);
        program = GL20.glCreateProgram();
        GL20.glAttachShader(program, vertex);
        GL20.glAttachShader(program, fragment);
        GL20.glLinkProgram(program);
        if (GL20.glGetProgrami(program, 0x8B82) != 1) throw failure("Shader link failed: " + GL20.glGetProgramInfoLog(program, 4096));
        GL20.glDeleteShader(vertex);
        GL20.glDeleteShader(fragment);
        GL20.glUseProgram(program);
        colorLocation = GL20.glGetUniformLocation(program, "color");
        int matrixLocation = GL20.glGetUniformLocation(program, "transform");
        if (colorLocation < 0 || matrixLocation < 0) throw failure("Active shader uniform missing");
        FloatBuffer matrix = ByteBuffer.allocateDirect(18 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        matrix.put(99);
        for (int i = 0; i < 16; i++) matrix.put(i % 5 == 0 ? 1 : 0);
        matrix.put(77).flip();
        matrix.position(1);
        matrix.limit(17);
        GL20.glUniformMatrix4fv(matrixLocation, false, matrix);
        if (matrix.position() != 1 || matrix.limit() != 17) throw failure("Matrix upload changed buffer position or limit");
        float[] uploaded = BrowserGraphics.uniformState(program, matrixLocation);
        if (uploaded.length != 16) throw failure("Matrix uniform length differs");
        for (int i = 0; i < 16; i++) if (uploaded[i] != (i % 5 == 0 ? 1 : 0)) throw failure("Matrix upload differs at " + i);
        for (int i = 0; i < 16; i++) matrix.put(1 + i, i + 1);
        GL20.glUniformMatrix4fv(matrixLocation, true, matrix);
        float[] transposed = BrowserGraphics.uniformState(program, matrixLocation);
        for (int i = 0; i < 16; i++) {
            int expected = (i % 4) * 4 + i / 4 + 1;
            if (transposed[i] != expected) throw failure("Transposed matrix differs at " + i);
            matrix.put(1 + i, i % 5 == 0 ? 1 : 0);
        }
        if (matrix.position() != 1 || matrix.limit() != 17) throw failure("Transposed upload changed buffer position or limit");
        GL20.glUniformMatrix4fv(matrixLocation, false, matrix);
    }

    private static int compile(int type, String source) {
        int shader = GL20.glCreateShader(type);
        GL20.glShaderSource(shader, source);
        GL20.glCompileShader(shader);
        if (GL20.glGetShaderi(shader, 0x8B81) != 1) throw failure("Shader compile failed: " + GL20.glGetShaderInfoLog(shader, 4096));
        return shader;
    }

    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
}
