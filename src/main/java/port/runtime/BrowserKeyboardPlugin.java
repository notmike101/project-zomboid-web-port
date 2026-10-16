package port.runtime;

import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Bounded third-party keyboard/window binding; desktop window creation stays unsupported. */
public final class BrowserKeyboardPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.browserKeyboard")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals("org.lwjglx.opengl.Display$Window")) {
                MethodDescriptor descriptor = new MethodDescriptor("<clinit>", ValueType.VOID);
                if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Display.Window initializer changed");
                MethodHolder method = new MethodHolder(descriptor);
                method.getModifiers().add(ElementModifier.STATIC);
                cls.addMethod(method);
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                body.setField(cls.getName(), "handle", body.invoke(BrowserKeyboard.class, "windowHandle", long.class));
                body.exit();
            } else if (cls.getName().equals("org.lwjglx.opengl.Display")) {
                MethodHolder method = cls.getMethod(new MethodDescriptor("isCreated", boolean.class));
                if (method == null) throw new IllegalStateException("Display.isCreated changed");
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                body.invoke(BrowserKeyboard.class, "isCreated", boolean.class).returnValue();
            } else if (cls.getName().equals("org.lwjgl.glfw.GLFW")) {
                MethodHolder initializer = cls.getMethod(new MethodDescriptor("<clinit>", ValueType.VOID));
                MethodHolder query = cls.getMethod(new MethodDescriptor("glfwGetKey", long.class, int.class, int.class));
                if (initializer == null || query == null) throw new IllegalStateException("GLFW keyboard API changed");
                ProgramEmitter init = ProgramEmitter.create(initializer, context.getHierarchy());
                init.invoke(BrowserKeyboard.class, "initialize"); init.exit();
                query.getModifiers().remove(ElementModifier.NATIVE);
                ProgramEmitter body = ProgramEmitter.create(query, context.getHierarchy());
                body.invoke(BrowserKeyboard.class, "getKey", int.class, body.var(1,long.class), body.var(2,int.class)).returnValue();
            }
        });
    }
}
