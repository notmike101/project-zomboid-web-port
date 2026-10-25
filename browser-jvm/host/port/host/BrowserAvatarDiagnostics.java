package port.host;

import java.lang.reflect.Field;
import java.util.Collection;
import java.util.IdentityHashMap;
import zombie.core.skinnedmodel.advancedanimation.AnimatedModel;
import zombie.core.skinnedmodel.model.ModelInstance;
import zombie.ui.UI3DModel;

/** Read-only preview checkpoint; call on the original UI owner between completed frames. */
public final class BrowserAvatarDiagnostics {
    private BrowserAvatarDiagnostics() { }

    public static String snapshot(UI3DModel preview) throws ReflectiveOperationException {
        if (preview == null) throw new IllegalArgumentException("Original UI3DModel required");
        AnimatedModel animated = (AnimatedModel) field(preview, "animatedModel");
        var player = animated.getAnimationPlayer();
        var root = animated.getModelInstance();
        StringBuilder out = new StringBuilder("avatar visible=").append(preview.isVisible())
                .append(" bounds=").append(preview.getAbsoluteX()).append(',').append(preview.getAbsoluteY())
                .append(',').append(preview.getWidth()).append(',').append(preview.getHeight())
                .append(" animationReady=").append(player != null && player.isReady())
                .append(" readyToRender=").append(player != null && root != null && animated.isReadyToRender())
                .append(" rendered=").append(animated.isRendered());
        var creator = field(animated, "textureCreator");
        out.append(" textureCreatorRendered=").append(creator == null ? "absent"
                : ((zombie.core.skinnedmodel.model.ModelInstanceTextureCreator) creator).isRendered());
        Object[] states = (Object[]) field(animated, "stateInfos");
        for (int i = 0; i < states.length; i++) {
            Object state = states[i];
            out.append("\nstate[").append(i).append("] modelsReady=").append(field(state, "modelsReady"))
                    .append(" instData=").append(((Collection<?>) field(state, "instData")).size())
                    .append(" readyData=").append(((Collection<?>) field(state, "readyData")).size())
                    .append(" textureCreatorPresent=").append(field(state, "textureCreator") != null);
        }
        models(root, "root", out, new IdentityHashMap<>());
        return out.toString();
    }

    private static void models(ModelInstance instance, String path, StringBuilder out,
            IdentityHashMap<ModelInstance, Boolean> seen) {
        out.append('\n').append(path);
        if (instance == null) { out.append(" absent"); return; }
        if (seen.put(instance, Boolean.TRUE) != null) { out.append(" alreadyObserved"); return; }
        var model = instance.model;
        if (model == null) { out.append(" modelAbsent"); }
        else {
            var mesh = model.mesh;
            out.append(" model=").append(model.getPath()).append(" state=").append(model.getState())
                    .append(" mesh=").append(mesh == null ? "absent" : mesh.getPath())
                    .append(" meshState=").append(mesh == null ? "absent" : mesh.getState())
                    .append(" vboPresent=").append(mesh != null && mesh.vb != null)
                    .append(" textureReady=").append(instance.tex != null && instance.tex.isReady());
        }
        for (int i = 0; i < instance.sub.size(); i++) models(instance.sub.get(i), path + '/' + i, out, seen);
    }

    private static Object field(Object target, String name) throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }
}
