package port.runtime;

import org.teavm.jso.JSBody;
import org.teavm.jso.typedarrays.Uint8Array;
import org.teavm.jso.typedarrays.Float32Array;
import org.teavm.jso.webgl.WebGL2RenderingContext;
import org.teavm.jso.webgl.WebGLShader;
import org.teavm.jso.webgl.WebGLProgram;
import org.teavm.jso.webgl.WebGLUniformLocation;
import org.teavm.jso.webgl.WebGLTexture;
import org.teavm.jso.webgl.WebGLFramebuffer;
import org.teavm.jso.webgl.WebGLActiveInfo;
import java.nio.ByteBuffer;
import java.nio.ReadOnlyBufferException;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.util.HashMap;
import java.util.ArrayList;
import java.util.regex.Pattern;

/** Real browser graphics backend for the explicitly supported OpenGL entry points. */
public final class BrowserGraphics {
    private static WebGL2RenderingContext context;
    private static int nextObject = 1;
    private static final HashMap<Integer, WebGLShader> shaders = new HashMap<>();
    private static final HashMap<Integer, WebGLProgram> programs = new HashMap<>();
    private static final ArrayList<WebGLUniformLocation> uniforms = new ArrayList<>();
    private static final HashMap<Integer, WebGLTexture> textures = new HashMap<>();
    private static final HashMap<Integer, WebGLFramebuffer> framebuffers = new HashMap<>();
    private static final HashMap<Integer, Integer> shaderTypes = new HashMap<>();
    private static final HashMap<Integer, ArrayList<UniformDefault>> shaderDefaults = new HashMap<>();
    private static final HashMap<Integer, ArrayList<Integer>> programShaders = new HashMap<>();
    private static final StringBuilder shaderDiagnostics = new StringBuilder();

    public static String shaderDiagnostics() { return shaderDiagnostics.toString(); }

    public static int glGenTextures() {
        initialize();
        WebGLTexture texture = context.createTexture();
        if (texture == null) return 0;
        int id = nextObject++;
        textures.put(id, texture);
        return id;
    }

    public static void glBindTexture(int target, int id) {
        initialize();
        context.bindTexture(target, texture(id));
    }

    public static void glDeleteTextures(int id) {
        initialize();
        WebGLTexture texture = textures.remove(id);
        if (texture != null) context.deleteTexture(texture);
    }

    public static void glTexParameteri(int target, int parameter, int value) {
        initialize();
        context.texParameteri(target, parameter, value);
    }

    /** Bounded RGBA8 transfer. Absolute reads preserve the caller's buffer state. */
    public static void glTexImage2D(int target, int level, int internalFormat, int width, int height,
            int border, int format, int type, ByteBuffer pixels) {
        initialize();
        requireRgba(format, type);
        if (internalFormat != 0x1908 && internalFormat != 0x8058)
            throw new UnsupportedOperationException("Only RGBA/RGBA8 texture storage is supported");
        int count = pixelCount(width, height);
        Uint8Array data = null;
        if (pixels != null) {
            if (pixels.remaining() < count) throw new IllegalArgumentException("Insufficient texture pixel bytes");
            data = new Uint8Array(count);
            for (int i = 0; i < count; i++) data.set(i, (short) (pixels.get(pixels.position() + i) & 255));
        }
        context.texImage2D(target, level, internalFormat, width, height, border, format, type, data);
    }

    /** Copies actual WebGL framebuffer bytes without advancing position or limit. */
    public static void glReadPixels(int x, int y, int width, int height, int format, int type, ByteBuffer pixels) {
        initialize();
        requireRgba(format, type);
        int count = pixelCount(width, height);
        if (pixels.isReadOnly()) throw new ReadOnlyBufferException();
        if (pixels.remaining() < count) throw new IllegalArgumentException("Insufficient readback pixel bytes");
        Uint8Array data = new Uint8Array(count);
        // An unsuccessful GL read leaves destination contents untouched.
        for (int i = 0; i < count; i++) data.set(i, (short) (pixels.get(pixels.position() + i) & 255));
        context.readPixels(x, y, width, height, format, type, data);
        for (int i = 0; i < count; i++) pixels.put(pixels.position() + i, (byte) data.get(i));
    }

    public static int glGenFramebuffers() {
        initialize();
        WebGLFramebuffer framebuffer = context.createFramebuffer();
        if (framebuffer == null) return 0;
        int id = nextObject++;
        framebuffers.put(id, framebuffer);
        return id;
    }

    public static void glBindFramebuffer(int target, int id) {
        initialize();
        context.bindFramebuffer(target, framebuffer(id));
    }

    public static void glDeleteFramebuffers(int id) {
        initialize();
        WebGLFramebuffer framebuffer = framebuffers.remove(id);
        if (framebuffer != null) context.deleteFramebuffer(framebuffer);
    }

    public static int glCheckFramebufferStatus(int target) {
        initialize();
        return context.checkFramebufferStatus(target);
    }

    public static void glFramebufferTexture2D(int target, int attachment, int textureTarget, int id, int level) {
        initialize();
        context.framebufferTexture2D(target, attachment, textureTarget, texture(id), level);
    }

    private static WebGLTexture texture(int id) {
        if (id == 0) return null;
        WebGLTexture value = textures.get(id);
        if (value == null) throw new IllegalArgumentException("Unknown texture handle: " + id);
        return value;
    }

    private static WebGLFramebuffer framebuffer(int id) {
        if (id == 0) return null;
        WebGLFramebuffer value = framebuffers.get(id);
        if (value == null) throw new IllegalArgumentException("Unknown framebuffer handle: " + id);
        return value;
    }

    private static void requireRgba(int format, int type) {
        if (format != 0x1908 || type != 0x1401)
            throw new UnsupportedOperationException("Only RGBA UNSIGNED_BYTE pixel transfers are supported");
    }

    private static int pixelCount(int width, int height) {
        // Negative sizes are forwarded to WebGL to produce its real INVALID_VALUE.
        if (width < 0 || height < 0) return 0;
        long pixels = (long) width * height;
        if (pixels > Integer.MAX_VALUE / 4) throw new IllegalArgumentException("Pixel transfer is too large");
        return (int) pixels * 4;
    }

    public static void initialize() {
        if (context == null) context = createContext();
        if (context.isContextLost()) throw new IllegalStateException("WebGL context is lost");
    }

    public static int getError() {
        initialize();
        return context.getError();
    }

    public static void enable(int capability) {
        initialize();
        context.enable(capability);
    }

    public static void disable(int capability) {
        initialize();
        context.disable(capability);
    }

    public static void clearColor(float red, float green, float blue, float alpha) {
        initialize();
        context.clearColor(red, green, blue, alpha);
    }

    public static void clear(int mask) {
        initialize();
        context.clear(mask);
    }

    public static int[] readPixel() {
        initialize();
        Uint8Array pixel = new Uint8Array(4);
        context.readPixels(0, 0, 1, 1, 0x1908, 0x1401, pixel);
        return new int[]{pixel.get(0), pixel.get(1), pixel.get(2), pixel.get(3)};
    }

    public static float[] clearState() {
        initialize();
        Float32Array values = (Float32Array) context.getParameter(0x0C22);
        return new float[]{values.get(0), values.get(1), values.get(2), values.get(3)};
    }

    public static int glCreateShader(int type) {
        initialize();
        WebGLShader shader = context.createShader(type);
        if (shader == null) return 0;
        int id = nextObject++;
        shaders.put(id, shader);
        shaderTypes.put(id, type);
        shaderDiagnostics.append("create shader ").append(id).append(" type ").append(type).append('\n');
        return id;
    }

    public static void glShaderSource(int id, CharSequence source) {
        try {
            String translated = translateShader(id, source.toString());
            shaderDiagnostics.append("shader source ").append(id).append(" originalHash ").append(source.toString().hashCode())
                    .append(" translatedHash ").append(translated.hashCode()).append('\n');
            context.shaderSource(shader(id), translated);
        } catch (RuntimeException failure) {
            shaderDiagnostics.append("shader translation failed ").append(id).append(' ').append(failure.toString()).append('\n');
            throw failure;
        }
    }
    public static void glCompileShader(int id) {
        context.compileShader(shader(id));
        shaderDiagnostics.append("compile ").append(id).append(" status ")
                .append(context.getShaderParameterb(shader(id), 0x8B81)).append(" log ")
                .append(context.getShaderInfoLog(shader(id))).append('\n');
    }
    public static String glGetShaderInfoLog(int id) { return context.getShaderInfoLog(shader(id)); }
    public static String glGetShaderInfoLog(int id, int maxLength) { return limitLog(glGetShaderInfoLog(id), maxLength); }
    public static int glGetShaderi(int id, int parameter) {
        if (parameter == 0x8B81 || parameter == 0x8B80) return context.getShaderParameterb(shader(id), parameter) ? 1 : 0;
        if (parameter == 0x8B84) return glGetShaderInfoLog(id).length() + 1;
        return context.getShaderParameteri(shader(id), parameter);
    }

    public static int glCreateProgram() {
        initialize();
        WebGLProgram program = context.createProgram();
        if (program == null) return 0;
        int id = nextObject++;
        programs.put(id, program);
        shaderDiagnostics.append("create program ").append(id).append('\n');
        return id;
    }

    public static void glAttachShader(int program, int shader) {
        context.attachShader(program(program), shader(shader));
        programShaders.computeIfAbsent(program, ignored -> new ArrayList<>()).add(shader);
    }
    public static void glLinkProgram(int id) {
        WebGLProgram program = program(id);
        context.linkProgram(program);
        shaderDiagnostics.append("link ").append(id).append(" status ")
                .append(context.getProgramParameterb(program, 0x8B82)).append(" log ")
                .append(context.getProgramInfoLog(program)).append('\n');
        if (!context.getProgramParameterb(program, 0x8B82)) return;
        WebGLProgram previous = (WebGLProgram) context.getParameter(0x8B8D);
        context.useProgram(program);
        try {
            ArrayList<Integer> attached = programShaders.get(id);
            if (attached != null) for (int shader : attached) {
                ArrayList<UniformDefault> defaults = shaderDefaults.get(shader);
                if (defaults != null) for (UniformDefault value : defaults) {
                    WebGLUniformLocation location = context.getUniformLocation(program, value.name);
                    if (location == null) continue;
                    if (value.integer) context.uniform1i(location, (int) value.value);
                    else context.uniform1f(location, (float) value.value);
                }
            }
        } finally { context.useProgram(previous); }
    }

    /** Platform dialect adaptation only; shader expressions and original control flow remain intact. */
    private static String translateShader(int id, String source) {
        ArrayList<UniformDefault> defaults = new ArrayList<>();
        shaderDefaults.put(id, defaults);
        var version = Pattern.compile("(?m)^\\s*#version\\s+(330(?:\\s+core)?|120)\\s*$").matcher(source);
        if (!version.find()) return source;
        boolean legacy = version.group(1).equals("120");
        source = source.substring(0, version.start()) + "#version 300 es\nprecision highp float;\nprecision highp int;\n"
                + source.substring(version.end());
        var initializers = Pattern.compile("(?m)^(\\s*uniform\\s+(float|int)\\s+([A-Za-z_][A-Za-z_0-9]*)\\s*)=\\s*([^;]+);").matcher(source);
        StringBuilder translated = new StringBuilder();
        int start = 0;
        while (initializers.find()) {
            String literal = initializers.group(4).trim();
            boolean integer = initializers.group(2).equals("int");
            String numeric = integer ? "[+-]?[0-9]+" : "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?";
            if (!literal.matches(numeric)) throw new UnsupportedOperationException("Unsupported shader uniform initializer: " + literal);
            double value;
            try {
                if (integer) value = Integer.parseInt(literal);
                else value = Float.parseFloat(literal);
            }
            catch (NumberFormatException failure) { throw new UnsupportedOperationException("Out-of-range shader uniform initializer: " + literal, failure); }
            if (!Double.isFinite(value)) throw new UnsupportedOperationException("Non-finite shader uniform initializer");
            defaults.add(new UniformDefault(initializers.group(3), integer, value));
            translated.append(source, start, initializers.start()).append(initializers.group(1)).append(';');
            start = initializers.end();
        }
        translated.append(source, start, source.length());
        source = translated.toString().replaceAll("\\btexture2D\\b", "texture");
        if (legacy) {
            if (shaderTypes.get(id) == 0x8B31) {
                source = source.replaceAll("(?m)^(\\s*)attribute\\b", "$1in");
                source = source.replaceAll("(?m)^(\\s*)varying\\b", "$1out");
            } else if (shaderTypes.get(id) == 0x8B30) {
                source = source.replaceAll("(?m)^(\\s*)varying\\b", "$1in");
            } else throw new UnsupportedOperationException("Unsupported legacy GLSL shader stage");
        }
        if (source.matches("(?s).*\\bgl_FragColor\\b.*")) {
            if (shaderTypes.get(id) != 0x8B30) throw new UnsupportedOperationException("Fragment output used outside fragment shader");
            source = source.replaceAll("\\bgl_FragColor\\b", "portFragmentOutput");
            int header = source.indexOf('\n');
            source = source.substring(0, header + 1) + "layout(location=0) out highp vec4 portFragmentOutput;\n" + source.substring(header + 1);
        }
        return source;
    }

    private static final class UniformDefault {
        final String name;
        final boolean integer;
        final double value;
        UniformDefault(String name, boolean integer, double value) {
            this.name = name; this.integer = integer; this.value = value;
        }
    }
    public static String glGetProgramInfoLog(int id) { return context.getProgramInfoLog(program(id)); }
    public static String glGetProgramInfoLog(int id, int maxLength) { return limitLog(glGetProgramInfoLog(id), maxLength); }
    public static void glBindAttribLocation(int id, int index, CharSequence name) {
        context.bindAttribLocation(program(id), index, name.toString());
    }
    public static int glGetAttribLocation(int id, CharSequence name) {
        return context.getAttribLocation(program(id), name.toString());
    }
    public static void glDetachShader(int id, int shader) {
        context.detachShader(program(id), shader(shader));
        ArrayList<Integer> attached = programShaders.get(id);
        if (attached != null) attached.remove(Integer.valueOf(shader));
    }
    public static void glValidateProgram(int id) {
        context.validateProgram(program(id));
        shaderDiagnostics.append("validate ").append(id).append(" status ")
                .append(context.getProgramParameterb(program(id), 0x8B83)).append(" log ")
                .append(context.getProgramInfoLog(program(id))).append('\n');
    }
    public static String glGetActiveUniform(int id, int index, int maxLength, IntBuffer size, IntBuffer type) {
        if (maxLength < 0) throw new IllegalArgumentException("Negative uniform name length");
        if (size != null && size.remaining() < 1 || type != null && type.remaining() < 1)
            throw new IllegalArgumentException("Uniform metadata buffer is empty");
        WebGLActiveInfo info = context.getActiveUniform(program(id), index);
        if (info == null) return "";
        if (size != null) size.put(size.position(), info.getSize());
        if (type != null) type.put(type.position(), info.getType());
        String name = info.getName();
        return name.substring(0, Math.min(name.length(), Math.max(0, maxLength - 1)));
    }

    public static double uniformScalar(int id, String name) {
        WebGLProgram program = program(id);
        WebGLUniformLocation location = context.getUniformLocation(program, name);
        if (location == null) throw new IllegalArgumentException("Uniform not active: " + name);
        return scalarUniform(context, program, location);
    }

    @JSBody(params = {"gl", "program", "location"}, script = "const value=gl.getUniform(program,location); if(typeof value!=='number')throw new Error('Uniform is not scalar'); return value;")
    private static native double scalarUniform(WebGL2RenderingContext gl, WebGLProgram program, WebGLUniformLocation location);
    public static int glGetProgrami(int id, int parameter) {
        if (parameter == 0x8B82 || parameter == 0x8B83 || parameter == 0x8B80) return context.getProgramParameterb(program(id), parameter) ? 1 : 0;
        if (parameter == 0x8B84) return glGetProgramInfoLog(id).length() + 1;
        return context.getProgramParameteri(program(id), parameter);
    }

    public static void glUseProgram(int id) { context.useProgram(id == 0 ? null : program(id)); }
    public static int glGetUniformLocation(int id, CharSequence name) {
        WebGLUniformLocation location = context.getUniformLocation(program(id), name.toString());
        if (location == null) return -1;
        uniforms.add(location);
        return uniforms.size();
    }

    public static void glUniform4f(int location, float x, float y, float z, float w) {
        context.uniform4f(uniform(location), x, y, z, w);
    }

    public static void glUniform1i(int location, int value) { context.uniform1i(uniform(location), value); }
    public static void glUniform1f(int location, float value) { context.uniform1f(uniform(location), value); }
    public static void glUniform2f(int location, float x, float y) { context.uniform2f(uniform(location), x, y); }
    public static void glUniform3f(int location, float x, float y, float z) { context.uniform3f(uniform(location), x, y, z); }
    public static void glUniform1iv(int location, int[] values) {
        if (location != -1) context.uniform1iv(uniform(location), values);
    }
    public static void glUniform1fv(int location, float[] values) {
        if (location != -1) context.uniform1fv(uniform(location), values);
    }
    public static void glUniform2fv(int location, FloatBuffer values) {
        if (location != -1) context.uniform2fv(uniform(location), remaining(values, 2));
    }
    public static void glUniform3fv(int location, FloatBuffer values) {
        if (location != -1) context.uniform3fv(uniform(location), remaining(values, 3));
    }
    public static void glUniform4fv(int location, FloatBuffer values) {
        if (location != -1) context.uniform4fv(uniform(location), remaining(values, 4));
    }

    public static void glUniformMatrix4fv(int location, boolean transpose, FloatBuffer values) {
        if (location != -1) context.uniformMatrix4fv(uniform(location), false, matrix(values, transpose, 4));
    }

    public static void glUniformMatrix3fv(int location, boolean transpose, FloatBuffer values) {
        if (location != -1) context.uniformMatrix3fv(uniform(location), false, matrix(values, transpose, 3));
    }

    private static float[] remaining(FloatBuffer values, int width) {
        float[] result = new float[(values.remaining() / width) * width];
        for (int i = 0; i < result.length; i++) result[i] = values.get(values.position() + i);
        return result;
    }

    private static float[] matrix(FloatBuffer values, boolean transpose, int width) {
        int size = width * width;
        float[] result = remaining(values, size);
        if (transpose) {
            for (int start = 0; start < result.length; start += size) {
                for (int row = 0; row < width; row++) {
                    for (int column = row + 1; column < width; column++) {
                        int a = start + row * width + column;
                        int b = start + column * width + row;
                        float value = result[a]; result[a] = result[b]; result[b] = value;
                    }
                }
            }
        }
        return result;
    }

    public static void glDeleteShader(int id) { if (id != 0) context.deleteShader(shader(id)); }
    public static void glDeleteProgram(int id) { if (id != 0) context.deleteProgram(program(id)); }
    public static void glDrawArrays(int mode, int first, int count) { context.drawArrays(mode, first, count); }

    public static float[] uniformState(int program, int location) {
        Float32Array values = (Float32Array) context.getUniform(program(program), uniform(location));
        float[] result = new float[values.getLength()];
        for (int i = 0; i < result.length; i++) result[i] = values.get(i);
        return result;
    }

    private static WebGLShader shader(int id) {
        WebGLShader shader = shaders.get(id);
        if (shader == null) throw new IllegalArgumentException("Unknown shader handle: " + id);
        return shader;
    }

    private static WebGLProgram program(int id) {
        WebGLProgram program = programs.get(id);
        if (program == null) throw new IllegalArgumentException("Unknown program handle: " + id);
        return program;
    }

    private static WebGLUniformLocation uniform(int location) {
        if (location == -1) return null;
        if (location < 1 || location > uniforms.size()) throw new IllegalArgumentException("Unknown uniform handle: " + location);
        return uniforms.get(location - 1);
    }

    private static String limitLog(String log, int maxLength) {
        if (maxLength < 0) throw new IllegalArgumentException("Negative log length");
        return log.substring(0, Math.min(log.length(), Math.max(0, maxLength - 1)));
    }

    @JSBody(script = """
            let canvas = globalThis.portGraphicsCanvas;
            if (!canvas && typeof document !== 'undefined') canvas = document.getElementById('graphics-canvas');
            if (!canvas) {
                if (typeof document === 'undefined') throw new Error('Worker graphics canvas is not installed');
                canvas = document.createElement('canvas');
                canvas.id = 'graphics-canvas';
                canvas.width = canvas.height = 96;
                canvas.setAttribute('aria-label', 'Original Color rendered through WebGL2');
                document.body.appendChild(canvas);
            }
            const gl = canvas.getContext('webgl2', {
                alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true
            });
            if (!gl) throw new Error('WebGL2 context creation failed');
            return gl;
            """)
    private static native WebGL2RenderingContext createContext();
}
