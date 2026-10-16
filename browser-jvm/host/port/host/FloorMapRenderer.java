package port.host;

import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import zombie.characters.IsoPlayer;
import zombie.core.Core;
import zombie.core.SceneShaderStore;
import zombie.core.SpriteRenderer;
import zombie.core.textures.Texture;
import zombie.iso.IsoCell;
import zombie.iso.IsoDirections;
import zombie.iso.IsoGridSquare;
import zombie.iso.IsoUtils;

/** Floor-only presentation over original world/player state; no world mutation. */
public final class FloorMapRenderer {
    private FloorMapRenderer() { }

    /** Caller prepares the original default shader and SpriteRenderer once on the render thread. */
    public static int draw(IsoCell cell, IsoPlayer player, int width, int height, boolean clear) {
        if (player == null || cell == null || player.getCurrentSquare() == null) {
            throw new IllegalArgumentException("Expected genuine loaded player and square");
        }
        float x = player.getX(), y = player.getY(), z = player.getZ();
        float cameraX = IsoUtils.XToScreen(x, y, z, 0);
        float cameraY = IsoUtils.YToScreen(x, y, z, 0);
        int scale = Core.tileScale;
        if (scale <= 0 || width <= 0 || height <= 0) throw new IllegalArgumentException("Invalid surface");
        Core core = Core.getInstance();
        SpriteRenderer renderer = SpriteRenderer.instance;
        core.projectionMatrixStack.push(core.projectionMatrixStack.alloc().setOrtho2D(0, width, height, 0));
        core.modelViewMatrixStack.push(core.modelViewMatrixStack.alloc().identity());
        int drawn = 0;
        try {
            GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, 0);
            GL11.glViewport(0, 0, width, height);
            GL11.glDisable(GL11.GL_DEPTH_TEST);
            GL11.glDisable(GL11.GL_CULL_FACE);
            GL11.glEnable(GL11.GL_BLEND);
            GL11.glBlendFunc(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA);
            if (clear) {
                GL11.glClearColor(0, 0, 0, 1);
                GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
            }
            renderer.clearSprites();
            renderer.StartShader(SceneShaderStore.defaultShaderId, -1);
            int centerX = (int) Math.floor(x), centerY = (int) Math.floor(y);
            int level = (int) Math.floor(z);
            // Painter order for the actual local floor set; absent/unloaded squares stay absent.
            for (int sum = -16; sum <= 16; sum++) {
                for (int dx = -8; dx <= 8; dx++) {
                    int dy = sum - dx;
                    if (dy < -8 || dy > 8) continue;
                    IsoGridSquare square = cell.getGridSquare(centerX + dx, centerY + dy, level);
                    if (square == null || square.getFloor() == null) continue;
                    var sprite = square.getFloor().getSprite();
                    if (sprite == null) throw new AssertionError("Floor has no original sprite");
                    Texture texture = sprite.getTextureForCurrentFrame(IsoDirections.N);
                    if (texture == null || !texture.isReady()) {
                        throw new AssertionError("Floor texture is not ready: " + square.getFloor().getSpriteName());
                    }
                    float projectedX = IsoUtils.XToScreen(square.getX(), square.getY(), square.getZ(), 0);
                    float projectedY = IsoUtils.YToScreen(square.getX(), square.getY(), square.getZ(), 0);
                    // The installed 1x atlas has a 64x128 original tile canvas. Honor its trim metadata.
                    float left = width * .5f + projectedX - cameraX - 32 * scale
                            + texture.getOffsetX() * scale;
                    float top = height * .5f + projectedY - cameraY - 96 * scale
                            + texture.getOffsetY() * scale;
                    renderer.render(texture, left, top, texture.getWidth() * scale,
                            texture.getHeight() * scale, 1, 1, 1, 1, null);
                    drawn++;
                }
            }
            renderer.pushFrameDown();
            renderer.acquireStateForRendering(() -> false);
            renderer.postRender();
            if (GL11.glGetError() != 0 || drawn == 0) throw new AssertionError("Original floor draw failed");
        } finally {
            core.modelViewMatrixStack.pop();
            core.projectionMatrixStack.pop();
        }
        if (Float.floatToRawIntBits(player.getX()) != Float.floatToRawIntBits(x)
                || Float.floatToRawIntBits(player.getY()) != Float.floatToRawIntBits(y)
                || Float.floatToRawIntBits(player.getZ()) != Float.floatToRawIntBits(z)) {
            throw new AssertionError("Presentation changed original player position");
        }
        return drawn;
    }
}
