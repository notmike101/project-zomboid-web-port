import org.lwjgl.opengl.GL11;

public final class TextureEnvQualification {

    static native void report(int checks);

    static native void unchanged();

    static int checks;

    static void check(boolean value) {
        if (!value) throw new AssertionError("Texture env check" + checks);
        checks++;
    }

    public static void main(String[] args) {
        GL11.glTexEnvi(8960, 8704, 8448);
        check(GL11.glGetError() == 0);
        unchanged();
        for (int[] v : new int[][] {
            { 0, 8704, 8448 },
            { 8960, 0, 8448 },
            { 8960, 8704, 0 },
        }) {
            GL11.glTexEnvi(v[0], v[1], v[2]);
            check(GL11.glGetError() == 1280);
            unchanged();
        }
        for (int mode : new int[] { 260, 8449, 3042, 7681, 34160 }) {
            boolean caught = false,
                finished = false;
            try {
                GL11.glTexEnvi(8960, 8704, mode);
            } catch (UnsupportedOperationException expected) {
                caught = true;
            } finally {
                finished = true;
            }
            check(caught && finished);
            check(GL11.glGetError() == 0);
            unchanged();
        }
        for (int[] v : new int[][] {
            { 8960, 34161, 8448 },
            { 34048, 34049, 0 },
            { 34913, 34914, 1 },
        }) {
            boolean caught = false;
            try {
                GL11.glTexEnvi(v[0], v[1], v[2]);
            } catch (UnsupportedOperationException expected) {
                caught = true;
            }
            check(caught);
            unchanged();
        }
        GL11.glTexEnvi(8960, 8704, 8448);
        check(GL11.glGetError() == 0);
        unchanged();
        report(checks);
    }
}
