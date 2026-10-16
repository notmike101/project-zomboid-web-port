package probe;

import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import org.joml.Matrix4f;
import org.lwjgl.opengl.GL11;
import org.teavm.classlib.impl.nio.Buffers;
import port.runtime.BrowserAssets;
import port.runtime.BrowserGraphics;
import zombie.ZomboidFileSystem;
import zombie.core.Core;
import zombie.core.SceneShaderStore;
import zombie.core.SpriteRenderer;
import zombie.core.VBO.GLVertexBufferObject;
import zombie.core.sprite.SpriteRenderState;
import zombie.core.textures.ImageData;
import zombie.core.textures.MipMapLevel;
import zombie.core.textures.Texture;
import zombie.core.textures.TextureID;

/** Browser-only original Texture.render queue, frame handoff and SpriteRenderer indexed submission. */
public final class SpriteRendererProbe {
    private static final String IMAGE = "/media/ui/avatarBackgroundWhite.png";
    private static final int SURFACE = 128;
    private static final int OFFSET = 16;
    private static String phase = "assets";

    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        ZomboidFileSystem.instance.init();
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[");
        String[] paths = {IMAGE, "/media/shaders/default.vert", "/media/shaders/default.frag"};
        for (int i = 0; i < paths.length; i++) {
            byte[] bytes;
            try (FileInputStream input = new FileInputStream(paths[i])) { bytes = input.readAllBytes(); }
            if (bytes.length == 0 || Arrays.hashCode(bytes) != BrowserAssets.contentHash(paths[i]))
                throw failure("Mounted original asset differs: " + paths[i]);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(paths[i]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", bytes.length); json.append(','); integer(json, "contentHash", Arrays.hashCode(bytes));
            json.append("}}");
        }
        ImageData image;
        try (FileInputStream input = new FileInputStream(IMAGE)) { image = new ImageData(input, false); }
        MipMapLevel level = image.getData();
        int width = image.getWidth(), height = image.getHeight(), widthHw = image.getWidthHW();
        if (width != 96 || height != 96 || widthHw != 128 || image.getHeightHW() != 128)
            throw failure("Original image dimensions differ");
        ByteBuffer original = level.getBuffer();
        byte[] expected = new byte[original.remaining()];
        for (int i = 0; i < expected.length; i++) expected[i] = original.get(original.position() + i);
        Texture texture = null;
        TextureID textureId = null;
        ByteBuffer readback = null;
        Core core = Core.getInstance();
        boolean projectionPushed = false, modelViewPushed = false;
        String completed;
        try {
            phase = "original-texture";
            // This original constructor uploads the actual ImageData and transitions its asset to READY.
            textureId = new TextureID(image);
            texture = new Texture(textureId, IMAGE);
            if (!texture.isReady() || texture.getWidth() != width || texture.getHeight() != height
                    || texture.getWidthHW() != widthHw || texture.getID() <= 0 || !level.isDisposed())
                throw failure("Original Texture constructor/upload did not produce a ready image");
            textureId.setMinFilter(GL11.GL_NEAREST);
            textureId.setMagFilter(GL11.GL_NEAREST);
            phase = "original-shader-and-vbos";
            SceneShaderStore.initGlobalShader();
            if (SceneShaderStore.defaultShader == null || !SceneShaderStore.defaultShader.isCompiled())
                throw failure("Original default shader did not compile");
            GLVertexBufferObject.init();
            SpriteRenderer renderer = SpriteRenderer.instance;
            renderer.create();
            // Public engine matrix-stack APIs provide the bounded surface projection. No player/camera mutation.
            Matrix4f projection = core.projectionMatrixStack.alloc().setOrtho2D(0, SURFACE, SURFACE, 0);
            core.projectionMatrixStack.push(projection); projectionPushed = true;
            core.modelViewMatrixStack.push(core.modelViewMatrixStack.alloc().identity()); modelViewPushed = true;
            int[] surface = BrowserGraphics.drawingBufferSize();
            if (surface[0] != SURFACE || surface[1] != SURFACE)
                throw failure("Actual framebuffer must be 128x128: " + surface[0] + "x" + surface[1]);
            GL11.glViewport(0, 0, SURFACE, SURFACE);
            GL11.glClearColor(0, 0, 0, 1);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
            phase = "original-texture-render-queue";
            renderer.clearSprites();
            SpriteRenderState populated = renderer.getPopulatingState();
            renderer.StartShader(SceneShaderStore.defaultShaderId, -1);
            texture.render(OFFSET, OFFSET, width, height, 1, 1, 1, 1, null);
            int queued = populated.numSprites;
            if (queued != 2) throw failure("Expected original shader command and one original texture sprite: " + queued);
            phase = "original-frame-handoff";
            renderer.pushFrameDown();
            if (renderer.states.getReady() != populated || renderer.getPopulatingState() == populated)
                throw failure("Original ready-state handoff differs");
            SpriteRenderState acquired = renderer.acquireStateForRendering(() -> false);
            if (acquired != populated || renderer.getRenderingState() != populated || renderer.states.getReady() != null)
                throw failure("Original rendering-state acquisition differs");
            phase = "original-frame-submission";
            renderer.postRender();
            if (!populated.isRendered() || populated.isRendering())
                throw failure("Original frame did not finish rendering");
            phase = "actual-framebuffer-verification";
            readback = ByteBuffer.allocateDirect(SURFACE * SURFACE * 4);
            GL11.glReadPixels(0, 0, SURFACE, SURFACE, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, readback);
            if (readback.position() != 0 || readback.limit() != readback.capacity() || GL11.glGetError() != 0)
                throw failure("Original indexed draw/readback produced a GL error or changed buffer state");
            byte[] actual = new byte[readback.capacity()];
            int visible = 0;
            for (int y = 0; y < SURFACE; y++) for (int x = 0; x < SURFACE; x++) {
                int sourceY = SURFACE - 1 - y - OFFSET;
                boolean inside = x >= OFFSET && x < OFFSET + width && sourceY >= 0 && sourceY < height;
                for (int channel = 0; channel < 4; channel++) {
                    int index = (y * SURFACE + x) * 4 + channel;
                    int wanted = inside ? expected[(sourceY * widthHw + x - OFFSET) * 4 + channel] & 255 : channel == 3 ? 255 : 0;
                    actual[index] = readback.get(index);
                    if ((actual[index] & 255) != wanted)
                        throw failure("Original sprite framebuffer mismatch at " + x + "," + y + " channel " + channel
                                + ": " + (actual[index] & 255) + " != " + wanted);
                }
                if (inside) visible++;
            }
            json.append(",{\"id\":\"original-sprite-frame-lifecycle\",\"inputs\":[],\"outputs\":{");
            integer(json, "queuedSprites", queued); json.append(','); integer(json, "populatingIndex", renderer.getMainStateIndex());
            json.append(','); integer(json, "renderingIndex", renderer.getRenderStateIndex()); json.append(','); integer(json, "rendered", 1);
            json.append("}},{\"id\":\"original-texture-visible-sprite\",\"inputs\":[],\"outputs\":{");
            integer(json, "width", SURFACE); json.append(','); integer(json, "height", SURFACE); json.append(',');
            integer(json, "pixelHash", Arrays.hashCode(actual)); json.append(','); integer(json, "visiblePixels", visible);
            completed = json.append("}}],\"pass\":true}").toString();
        } catch (Throwable error) {
            System.out.println("Sprite renderer failure at " + phase + ": " + error);
            error.printStackTrace(System.out);
            throw error;
        } finally {
            if (modelViewPushed) core.modelViewMatrixStack.pop();
            if (projectionPushed) core.projectionMatrixStack.pop();
            if (textureId != null && textureId.getID() > 0) GL11.glDeleteTextures(textureId.getID());
            if (readback != null) Buffers.free(readback);
            if (!level.isDisposed()) image.dispose();
            // Asset wrappers and original static ring buffers live until owned worker/context teardown.
            // Texture.destroy requires a fully initialized original RenderThread, which this probe does not claim.
        }
        System.out.println(completed);
    }

    private static AssertionError failure(String message) { return new AssertionError(message); }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
