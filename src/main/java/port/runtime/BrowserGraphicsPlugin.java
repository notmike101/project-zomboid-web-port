package port.runtime;

import org.teavm.model.ElementModifier;
import org.teavm.model.AccessLevel;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.emit.ValueEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Opt-in browser bindings. Unsupported third-party methods keep their original implementation. */
public final class BrowserGraphicsPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.webgl")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals(BrowserCapabilities.class.getName())) {
                MethodHolder method = required(cls.getMethod(new MethodDescriptor("createDescriptor",
                        ValueType.object("org.lwjgl.opengl.GLCapabilities"))), "createDescriptor");
                method.getModifiers().remove(ElementModifier.NATIVE);
                ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                body.construct("org.lwjgl.opengl.GLCapabilities").returnValue();
            } else if (cls.getName().equals("org.lwjgl.opengl.GLCapabilities")) {
                // The browser never publishes desktop native function addresses or
                // claims a complete desktop version. Missing selected APIs still fail.
                MethodHolder constructor = new MethodHolder(new MethodDescriptor("<init>", ValueType.VOID));
                if (cls.getMethod(constructor.getDescriptor()) != null) throw new IllegalStateException("Vendor capabilities constructor changed");
                constructor.setLevel(AccessLevel.PUBLIC);
                cls.addMethod(constructor);
                ProgramEmitter body = ProgramEmitter.create(constructor, context.getHierarchy());
                body.var(0, ValueType.object(cls.getName())).invokeSpecial(Object.class, "<init>");
                body.exit();
            } else if (cls.getName().equals("org.lwjglx.opengl.Display")) {
                MethodHolder original = required(cls.getMethod(new MethodDescriptor("<clinit>", ValueType.VOID)), "Display.<clinit>");
                cls.removeMethod(original);
                MethodHolder defaults = new MethodHolder(new MethodDescriptor("portInitializeDefaults", ValueType.VOID));
                defaults.getModifiers().add(ElementModifier.STATIC);
                defaults.setLevel(AccessLevel.PRIVATE);
                defaults.setProgram(original.getProgram());
                cls.addMethod(defaults);
                MethodHolder initializer = new MethodHolder(new MethodDescriptor("<clinit>", ValueType.VOID));
                initializer.getModifiers().add(ElementModifier.STATIC);
                cls.addMethod(initializer);
                ProgramEmitter body = ProgramEmitter.create(initializer, context.getHierarchy());
                body.invoke(new MethodReference(cls.getName(), defaults.getDescriptor()));
                body.setField(cls.getName(), "capabilities", body.invoke(BrowserCapabilities.class, "get", org.lwjgl.opengl.GLCapabilities.class));
                body.exit();
            } else if (cls.getName().equals("org.lwjgl.opengl.GL")) {
                for (String name : new String[]{"<clinit>", "initialize"}) {
                    MethodHolder method = required(cls.getMethod(new MethodDescriptor(name, ValueType.VOID)), name);
                    ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                    body.invoke(BrowserCapabilities.class, "get", org.lwjgl.opengl.GLCapabilities.class);
                    body.exit();
                }
                MethodHolder capabilities = required(cls.getMethod(new MethodDescriptor("getCapabilities",
                        ValueType.object("org.lwjgl.opengl.GLCapabilities"))), "GL.getCapabilities");
                ProgramEmitter body = ProgramEmitter.create(capabilities, context.getHierarchy());
                body.invoke(BrowserCapabilities.class, "get", org.lwjgl.opengl.GLCapabilities.class).returnValue();
            } else if (cls.getName().equals("org.lwjgl.opengl.GL20C")) {
                for (MethodDescriptor descriptor : new MethodDescriptor[]{
                    new MethodDescriptor("glCreateShader", ValueType.INTEGER, ValueType.INTEGER),
                    new MethodDescriptor("glShaderSource", ValueType.INTEGER, ValueType.object("java.lang.CharSequence"), ValueType.VOID),
                    new MethodDescriptor("glCompileShader", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glGetShaderi", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER),
                    new MethodDescriptor("glGetShaderInfoLog", ValueType.INTEGER, ValueType.INTEGER, ValueType.object("java.lang.String")),
                    new MethodDescriptor("glCreateProgram", ValueType.INTEGER),
                    new MethodDescriptor("glAttachShader", ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glBindAttribLocation", ValueType.INTEGER, ValueType.INTEGER, ValueType.object("java.lang.CharSequence"), ValueType.VOID),
                    new MethodDescriptor("glGetAttribLocation", ValueType.INTEGER, ValueType.object("java.lang.CharSequence"), ValueType.INTEGER),
                    new MethodDescriptor("glDetachShader", ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glValidateProgram", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glGetActiveUniform", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.object("java.nio.IntBuffer"), ValueType.object("java.nio.IntBuffer"), ValueType.object("java.lang.String")),
                    new MethodDescriptor("glLinkProgram", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glGetProgrami", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER),
                    new MethodDescriptor("glGetProgramInfoLog", ValueType.INTEGER, ValueType.INTEGER, ValueType.object("java.lang.String")),
                    new MethodDescriptor("glUseProgram", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glGetUniformLocation", ValueType.INTEGER, ValueType.object("java.lang.CharSequence"), ValueType.INTEGER),
                    new MethodDescriptor("glUniform4f", ValueType.INTEGER, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.VOID),
                    new MethodDescriptor("glUniform1i", ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glUniform1f", ValueType.INTEGER, ValueType.FLOAT, ValueType.VOID),
                    new MethodDescriptor("glUniform2f", ValueType.INTEGER, ValueType.FLOAT, ValueType.FLOAT, ValueType.VOID),
                    new MethodDescriptor("glUniform3f", ValueType.INTEGER, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.VOID),
                    new MethodDescriptor("glUniform1iv", ValueType.INTEGER, ValueType.arrayOf(ValueType.INTEGER), ValueType.VOID),
                    new MethodDescriptor("glUniform1fv", ValueType.INTEGER, ValueType.arrayOf(ValueType.FLOAT), ValueType.VOID),
                    new MethodDescriptor("glUniform2fv", ValueType.INTEGER, ValueType.object("java.nio.FloatBuffer"), ValueType.VOID),
                    new MethodDescriptor("glUniform3fv", ValueType.INTEGER, ValueType.object("java.nio.FloatBuffer"), ValueType.VOID),
                    new MethodDescriptor("glUniform4fv", ValueType.INTEGER, ValueType.object("java.nio.FloatBuffer"), ValueType.VOID),
                    new MethodDescriptor("glUniformMatrix3fv", ValueType.INTEGER, ValueType.BOOLEAN, ValueType.object("java.nio.FloatBuffer"), ValueType.VOID),
                    new MethodDescriptor("glUniformMatrix4fv", ValueType.INTEGER, ValueType.BOOLEAN, ValueType.object("java.nio.FloatBuffer"), ValueType.VOID),
                    new MethodDescriptor("glDeleteShader", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glDeleteProgram", ValueType.INTEGER, ValueType.VOID)
                }) {
                    MethodHolder method = required(cls.getMethod(descriptor), descriptor.toString());
                    method.getModifiers().remove(ElementModifier.NATIVE);
                    ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                    ValueEmitter[] arguments = new ValueEmitter[descriptor.parameterCount()];
                    for (int i = 0; i < arguments.length; i++) arguments[i] = body.var(i + 1, descriptor.parameterType(i));
                    ValueEmitter result = body.invoke(new MethodReference(BrowserGraphics.class.getName(), descriptor), arguments);
                    if (descriptor.getResultType() == ValueType.VOID) body.exit();
                    else result.returnValue();
                }
            } else if (cls.getName().equals("org.lwjgl.opengl.GL30C")) {
                for (MethodDescriptor descriptor : new MethodDescriptor[]{
                    new MethodDescriptor("glGenFramebuffers", ValueType.INTEGER),
                    new MethodDescriptor("glBindFramebuffer", ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glDeleteFramebuffers", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glCheckFramebufferStatus", ValueType.INTEGER, ValueType.INTEGER),
                    new MethodDescriptor("glFramebufferTexture2D", ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID)
                }) redirect(required(cls.getMethod(descriptor), descriptor.toString()), context.getHierarchy());
            } else if (cls.getName().equals("org.lwjgl.opengl.GL11C")) {
                for (MethodDescriptor descriptor : new MethodDescriptor[]{
                    new MethodDescriptor("glGenTextures", ValueType.INTEGER),
                    new MethodDescriptor("glBindTexture", ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glDeleteTextures", ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glTexParameteri", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID),
                    new MethodDescriptor("glTexImage2D", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.object("java.nio.ByteBuffer"), ValueType.VOID),
                    new MethodDescriptor("glReadPixels", ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER,
                            ValueType.object("java.nio.ByteBuffer"), ValueType.VOID)
                }) redirect(required(cls.getMethod(descriptor), descriptor.toString()), context.getHierarchy());
                for (String name : new String[]{"glGetError", "glEnable", "glDisable", "glClear", "glClearColor", "glDrawArrays"}) {
                    MethodDescriptor descriptor = switch (name) {
                        case "glGetError" -> new MethodDescriptor(name, ValueType.INTEGER);
                        case "glClearColor" -> new MethodDescriptor(name, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.VOID);
                        case "glDrawArrays" -> new MethodDescriptor(name, ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID);
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
                        case "glDrawArrays" -> { body.invoke(BrowserGraphics.class, "glDrawArrays", body.var(1, int.class), body.var(2, int.class), body.var(3, int.class)); body.exit(); }
                        case "glClearColor" -> {
                            body.invoke(BrowserGraphics.class, "clearColor", body.var(1, float.class), body.var(2, float.class), body.var(3, float.class), body.var(4, float.class));
                            body.exit();
                        }
                    }
                }
            }
        });
    }

    private static void redirect(MethodHolder method, org.teavm.model.ClassHierarchy hierarchy) {
        MethodDescriptor descriptor = method.getDescriptor();
        method.getModifiers().remove(ElementModifier.NATIVE);
        ProgramEmitter body = ProgramEmitter.create(method, hierarchy);
        ValueEmitter[] arguments = new ValueEmitter[descriptor.parameterCount()];
        for (int i = 0; i < arguments.length; i++) arguments[i] = body.var(i + 1, descriptor.parameterType(i));
        ValueEmitter result = body.invoke(new MethodReference(BrowserGraphics.class.getName(), descriptor), arguments);
        if (descriptor.getResultType() == ValueType.VOID) body.exit();
        else result.returnValue();
    }

    private static MethodHolder required(MethodHolder method, String name) {
        if (method == null) throw new IllegalStateException("LWJGL method changed: " + name);
        return method;
    }
}
