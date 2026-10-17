import java.nio.IntBuffer;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL11C;
import org.lwjgl.opengl.GL30;
import zombie.iso.fboRenderChunk.FBORenderChunk;
import zombie.core.opengl.RenderThread;
import zombie.core.textures.TextureID;

/** Original vendor depth ABI and original chunk-FBO mipmap lifecycle, on tiny owned data. */
public final class DepthMipmapQualification {
    private static native boolean depth(double near, double far);
    private static native boolean depthPixels(int red);
    private static native boolean mipPixels(int texture, boolean blue);
    private static native void report(String result);
    private static int checks;

    private static void check(boolean value, String label) {
        if (!value) throw new AssertionError(label);
        checks++;
    }

    public static void main(String[] args) {
        FBORenderChunk chunk = null;
        Throwable failure = null;
        String stage = "desktop-depth-range";
        try {
            GL11.glDepthRange(-10, 10);
            check(depth(0, 1), "Original Core -10,10 clamps to full depth range");
            GL11.glDepthRange(0.125, 0.375);
            check(depth(0.125, 0.375), "Finite ordered depth endpoints");
            check(depthPixels(64), "Actual lower depth mapping pixels");
            GL11C.glDepthRange(0.625, 0.875);
            check(depthPixels(191), "Actual core vendor upper depth mapping pixels");
            GL11.glDepthRange(0.5, 0.5);
            check(depth(0.5, 0.5), "Equal depth endpoints");
            GL11.glDepthRange(2, 1.5);
            check(depth(1, 1), "Desktop clamping precedes effective order validation");
            GL11.glDepthRange(-1, -2);
            check(depth(0, 0), "Both negative endpoints collapse at zero");
            GL11.glDepthRange(0.25, 0.75);
            int caught = 0, completed = 0;
            for (double[] range : new double[][] {{0.75, 0.25}, {Double.NaN, 1}, {0, Double.POSITIVE_INFINITY}}) {
                try {
                    GL11.glDepthRange(range[0], range[1]);
                } catch (UnsupportedOperationException expected) {
                    caught++;
                } finally {
                    completed++;
                }
                check(depth(0.25, 0.75), "Unsupported range preserves actual depth state");
            }
            check(caught == 3 && completed == 3, "Depth rejection reaches Java catch and finally");
            check(GL11.glGetError() == 0, "Rejected desktop ranges invent no GL error");
            GL11.glDepthRange(0, 1);
            stage = "original-chunk-fbo";
            chunk = new FBORenderChunk();
            chunk.w = 4;
            chunk.h = 4;
            chunk.preInit();
            chunk.beginRenderThread(true);
            check(chunk.isInit && chunk.fbo != null, "Original chunk created its real FBO");
            GL11.glDisable(3089);
            GL11.glClearColor(254f / 255f, 0, 0, 1);
            GL11.glClear(16384);
            GL11.glEnable(3089);
            GL11.glScissor(0, 2, 4, 2);
            GL11.glClearColor(0, 254f / 255f, 0, 1);
            GL11.glClear(16384);
            GL11.glDisable(3089);
            chunk.endRenderThread();
            check(mipPixels(chunk.tex.getID(), false), "Original endRenderThread generated exact mip levels");
            check(GL11.glGetError() == 0, "Original FBO and mipmap path has no error");
            chunk.beginRenderThread(false);
            GL11.glClearColor(0, 0, 1, 1);
            GL11.glClear(16384);
            chunk.endRenderThread();
            check(mipPixels(chunk.tex.getID(), true), "Original redraw regenerates mip levels");
            stage = "texture-delete-buffer";
            int temporary = GL11.glGenTextures();
            GL11.glBindTexture(3553, temporary);
            IntBuffer names = IntBuffer.wrap(new int[] {1234567, 0, temporary, temporary, 7654321});
            names.position(1);
            names.limit(4);
            IntBuffer slice = names.slice().asReadOnlyBuffer();
            GL11.glDeleteTextures(slice);
            check(slice.position() == 0 && slice.limit() == 3 && names.position() == 1 && names.limit() == 4,
                "Read-only nonzero slice delete preserves all buffer states");
            check(slice.get(0) == 0 && slice.get(1) == temporary && slice.get(2) == temporary,
                "Texture deletion preserves input names including zero and duplicates");
            stage = "mipmap-error-validation";
            GL30.glGenerateMipmap(0x7fffffff);
            check(GL11.glGetError() == 1280, "Invalid mipmap target retains driver INVALID_ENUM");
        } catch (Throwable error) {
            failure = error;
        } finally {
            try {
                if (chunk != null && chunk.fbo != null) {
                    chunk.fbo.destroy();
                    var flush = RenderThread.class.getDeclaredMethod("flushInvokeQueue");
                    flush.setAccessible(true);
                    flush.invoke(null);
                    check(TextureID.deleteTextureIDS.position() == 0, "Original render queue drained owned texture deletions");
                }
                GL11.glDepthRange(0, 1);
            } catch (Throwable error) {
                if (failure == null) failure = error;
            }
        }
        report("{\"pass\":" + (failure == null) + ",\"checks\":" + checks +
            ",\"stage\":\"" + stage + "\",\"errorClass\":\"" +
            (failure == null ? "" : failure.getClass().getName()) + "\"}");
    }
}
