package port.runtime;

import org.teavm.jso.JSBody;
import org.teavm.jso.typedarrays.Uint8Array;
import org.teavm.jso.typedarrays.Float32Array;
import org.teavm.jso.webgl.WebGL2RenderingContext;

/** Real browser graphics backend for the explicitly supported OpenGL entry points. */
public final class BrowserGraphics {
    private static WebGL2RenderingContext context;

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

    @JSBody(script = """
            let canvas = document.getElementById('graphics-canvas');
            if (!canvas) {
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
