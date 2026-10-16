package probe;

import org.lwjgl.util.vector.Vector4f;
import zombie.core.rendering.ShaderParameter;

/** Compile-only qualification. Never run before qualifying the original initialization closure. */
public final class ShaderParameterBoundaryProbe {
    public static void main(String[] args) {
        ShaderParameter color = new ShaderParameter("color", new Vector4f(0.25f, 0.5f, 0.75f, 1));
        ShaderParameter scale = new ShaderParameter("scale", 0.75f);
        Vector4f value = color.GetVector4();
        System.out.println(value.x + value.y + value.z + value.w + scale.GetFloat());
    }
}
