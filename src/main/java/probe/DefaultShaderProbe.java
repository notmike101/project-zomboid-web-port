package probe;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL20;
import port.runtime.BrowserAssets;
import port.runtime.BrowserGraphics;
import zombie.ZomboidFileSystem;
import zombie.core.DefaultShader;
import zombie.core.SceneShaderStore;
import zombie.core.opengl.ShaderProgram;

/** Browser-only original default shader loader/compiler and actual linked uniform state. */
public final class DefaultShaderProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        ZomboidFileSystem.instance.init();
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[");
        String[] paths = {"/media/shaders/default.vert", "/media/shaders/default.frag"};
        for (int i = 0; i < paths.length; i++) {
            File file = new File(paths[i]);
            byte[] bytes;
            try (FileInputStream input = new FileInputStream(file)) { bytes = input.readAllBytes(); }
            int hash = Arrays.hashCode(bytes);
            if (!file.isFile() || file.canWrite() || bytes.length == 0 || bytes.length != file.length()
                    || hash != BrowserAssets.contentHash(paths[i])) throw failure("Original shader asset differs: " + paths[i]);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(paths[i]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", bytes.length); json.append(','); integer(json, "contentHash", hash); json.append("}}");
        }

        var capabilities = org.lwjgl.opengl.GL.getCapabilities();
        if (capabilities != org.lwjglx.opengl.Display.capabilities || capabilities.OpenGL15 || capabilities.OpenGL30
                || capabilities.OpenGL33 || capabilities.GL_ARB_texture_compression
                || capabilities.glCreateShader != 0 || capabilities.glBindBuffer != 0
                || !zombie.core.Core.getInstance().getUseOpenGL21())
            throw failure("Browser capability descriptor claims unsupported desktop APIs");
        SceneShaderStore.initGlobalShader();
        DefaultShader shader = SceneShaderStore.defaultShader;
        if (shader == null || !shader.isCompiled() || shader.getID() <= 0
                || SceneShaderStore.defaultShaderId != shader.getID()) {
            diagnoseOriginalCompile(paths);
            throw failure("Original default shader did not compile");
        }
        ShaderProgram program = shader.getProgram();
        if (GL20.glGetAttribLocation(shader.getID(), "vPos") != 0
                || GL20.glGetAttribLocation(shader.getID(), "vUV") != 1
                || GL20.glGetAttribLocation(shader.getID(), "vCol") != 2
                || GL20.glGetAttribLocation(shader.getID(), "boneWeights") != -1
                || GL20.glGetAttribLocation(shader.getID(), "boneIDs") != -1)
            throw failure("Actual original shader attribute locations differ");
        String[] names = {"ModelViewProjection", "chunkDepth", "zDepth", "DIFFUSE", "useTexture"};
        int[] types = {0x8B5C, 0x1406, 0x1406, 0x8B5E, 0x1404};
        for (int i = 0; i < names.length; i++) {
            if (program.getUniform(names[i], types[i]) == null || GL20.glGetUniformLocation(shader.getID(), names[i]) == -1)
                throw failure("Original uniform metadata/lookup missing: " + names[i]);
        }
        int count = GL20.glGetProgrami(shader.getID(), GL20.GL_ACTIVE_UNIFORMS);
        if (count != names.length || BrowserGraphics.uniformScalar(shader.getID(), "useTexture") != 1
                || BrowserGraphics.uniformScalar(shader.getID(), "chunkDepth") != 0
                || BrowserGraphics.uniformScalar(shader.getID(), "zDepth") != 0
                || BrowserGraphics.uniformScalar(shader.getID(), "DIFFUSE") != 0 || GL11.glGetError() != 0)
            throw failure("Actual default shader uniform values or GL state differ");
        json.append(",{\"id\":\"original-default-shader\",\"inputs\":[],\"outputs\":{");
        integer(json, "uniformCount", count); json.append(','); integer(json, "useTexture", 1); json.append(',');
        integer(json, "chunkDepth", 0); json.append(','); integer(json, "zDepth", 0); json.append(',');
        integer(json, "diffuseUnit", 0); json.append(','); integer(json, "state", 7);
        System.out.println(json.append("}}],\"pass\":true}"));
    }

    private static void diagnoseOriginalCompile(String[] paths) {
        // Failure-only public entry points expose an exception otherwise caught
        // by SceneShaderStore. The original loader/compiler remains unchanged.
        zombie.debug.DebugLog.getInstance().setStdOut(System.out);
        zombie.debug.DebugLog.getInstance().setStdErr(System.out);
        zombie.debug.DebugLog.setLogEnabled(zombie.debug.DebugType.Shader, true);
        try { System.out.println("Original Core.getUseOpenGL21 result " + zombie.core.Core.getInstance().getUseOpenGL21()); }
        catch (Throwable error) { printFailure("Original Core.getUseOpenGL21", error); }
        for (String path : paths) {
            try (var reader = zombie.core.IndieFileLoader.getStreamReader(path.substring(1), false)) {
                char[] buffer = new char[128];
                System.out.println("Original IndieFileLoader read " + path + ": " + reader.read(buffer));
            } catch (Throwable error) { printFailure("Original IndieFileLoader " + path, error); }
        }
        try {
            ShaderProgram units = ShaderProgram.createShaderProgram("default", false, false, false);
            var vertex = units.addShader("media/shaders/default.vert", zombie.core.opengl.ShaderUnit.Type.Vert);
            var fragment = units.addShader("media/shaders/default.frag", zombie.core.opengl.ShaderUnit.Type.Frag);
            System.out.println("Original direct vertex ShaderUnit.compile result " + vertex.compile());
            System.out.println("Original direct fragment ShaderUnit.compile result " + fragment.compile());
        } catch (Throwable error) { printFailure("Original direct ShaderUnit.compile", error); }
        try {
            ShaderProgram diagnostic = ShaderProgram.createShaderProgram("default", false, false, true);
            System.out.println("Original direct compile status " + diagnostic.isCompiled() + " id " + diagnostic.getShaderID());
        } catch (Throwable error) { printFailure("Original direct ShaderProgram.compile", error); }
    }

    private static void printFailure(String stage, Throwable error) {
        System.out.println(stage + ": " + error.getClass().getName() + ": " + error.getMessage());
        Throwable cause = error.getCause();
        for (int i = 0; cause != null && cause != error && i < 5; i++, cause = cause.getCause())
            System.out.println("caused by " + cause.getClass().getName() + ": " + cause.getMessage());
        error.printStackTrace(System.out);
    }

    private static AssertionError failure(String message) {
        System.out.println("WebGL shader diagnostics: " + BrowserGraphics.shaderDiagnostics());
        dumpLogs(new File("/"), 0);
        System.out.println(message);
        return new AssertionError(message);
    }

    private static void dumpLogs(File directory, int depth) {
        if (depth > 7) return;
        File[] files = directory.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isDirectory()) { if (!file.getPath().equals("/media")) dumpLogs(file, depth + 1); }
            else if (file.getName().endsWith(".log") || file.getName().endsWith(".txt")) {
                try (FileInputStream input = new FileInputStream(file)) {
                    byte[] bytes = input.readAllBytes();
                    int start = Math.max(0, bytes.length - 8192);
                    System.out.println("Browser log " + file.getPath() + ": " + new String(bytes, start, bytes.length - start, java.nio.charset.StandardCharsets.UTF_8));
                } catch (Exception error) { System.out.println("Cannot inspect browser log " + file + ": " + error); }
            }
        }
    }

    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
