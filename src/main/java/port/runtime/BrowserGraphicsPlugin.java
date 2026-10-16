package port.runtime;

import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Opt-in browser bindings. Unsupported third-party methods keep their original implementation. */
public final class BrowserGraphicsPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.webgl")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals("org.lwjgl.opengl.GL")) {
                for (String name : new String[]{"<clinit>", "initialize"}) {
                    MethodHolder method = required(cls.getMethod(new MethodDescriptor(name, ValueType.VOID)), name);
                    ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                    body.invoke(BrowserGraphics.class, "initialize");
                    body.exit();
                }
            } else if (cls.getName().equals("org.lwjgl.opengl.GL11C")) {
                for (String name : new String[]{"glGetError", "glEnable", "glDisable", "glClear", "glClearColor"}) {
                    MethodDescriptor descriptor = switch (name) {
                        case "glGetError" -> new MethodDescriptor(name, ValueType.INTEGER);
                        case "glClearColor" -> new MethodDescriptor(name, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.VOID);
                        default -> new MethodDescriptor(name, ValueType.INTEGER, ValueType.VOID);
                    };
                    MethodHolder method = required(cls.getMethod(descriptor), name);
                    method.getModifiers().remove(ElementModifier.NATIVE);
                    ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                    switch (name) {
                        case "glGetError" -> body.invoke(BrowserGraphics.class, "getError", int.class).returnValue();
                        case "glEnable" -> { body.invoke(BrowserGraphics.class, "enable", body.var(1, int.class)); body.exit(); }
                        case "glDisable" -> { body.invoke(BrowserGraphics.class, "disable", body.var(1, int.class)); body.exit(); }
                        case "glClear" -> { body.invoke(BrowserGraphics.class, "clear", body.var(1, int.class)); body.exit(); }
                        case "glClearColor" -> {
                            body.invoke(BrowserGraphics.class, "clearColor", body.var(1, float.class), body.var(2, float.class), body.var(3, float.class), body.var(4, float.class));
                            body.exit();
                        }
                    }
                }
            }
        });
    }

    private static MethodHolder required(MethodHolder method, String name) {
        if (method == null) throw new IllegalStateException("LWJGL method changed: " + name);
        return method;
    }
}
