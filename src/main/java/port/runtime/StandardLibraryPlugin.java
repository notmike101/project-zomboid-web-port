package port.runtime;

import java.io.File;
import java.io.Reader;
import java.io.PrintStream;
import java.io.OutputStream;
import java.io.Writer;
import java.nio.file.Path;
import org.teavm.model.AccessLevel;
import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Extends only missing standard-library methods. Original game classes are untouched. */
public final class StandardLibraryPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        host.add((cls, context) -> {
            RegexTransformer.transform(cls, context);
            PrintStreamTransformer.transform(cls, context);
            if (cls.getName().equals("java.nio.file.impl.DefaultPath")) {
                ValueType type = ValueType.object("java.nio.file.impl.DefaultPath");
                MethodHolder normalize = cls.getMethod(new MethodDescriptor("normalize", type));
                if (normalize == null) throw new IllegalStateException("DefaultPath.normalize changed; reassess the compatibility fix.");
                ProgramEmitter body = ProgramEmitter.create(normalize, context.getHierarchy());
                body.invoke(PathSupport.class, "normalize", Path.class, body.var(0, Path.class)).cast(type).returnValue();
                MethodHolder resolve = cls.getMethod(new MethodDescriptor("resolve", ValueType.object("java.nio.file.Path"), ValueType.object("java.nio.file.Path")));
                if (resolve == null) throw new IllegalStateException("DefaultPath.resolve changed; reassess the compatibility fix.");
                ProgramEmitter resolver = ProgramEmitter.create(resolve, context.getHierarchy());
                resolver.invoke(PathSupport.class, "resolvePath", Path.class, resolver.var(0, Path.class), resolver.var(1, Path.class)).returnValue();
                return;
            }
            MethodDescriptor descriptor;
            switch (cls.getName()) {
                case "java.lang.Math": descriptor = new MethodDescriptor("fma", ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT, ValueType.FLOAT); break;
                case "java.lang.Thread": descriptor = new MethodDescriptor("onSpinWait", ValueType.VOID); break;
                case "java.lang.String": descriptor = new MethodDescriptor("<init>", ValueType.arrayOf(ValueType.BYTE), ValueType.INTEGER, ValueType.INTEGER, ValueType.INTEGER, ValueType.VOID); break;
                case "java.io.PrintStream": descriptor = new MethodDescriptor("<init>", ValueType.object("java.io.File"), ValueType.VOID); break;
                case "java.io.Reader": descriptor = new MethodDescriptor("transferTo", ValueType.object("java.io.Writer"), ValueType.LONG); break;
                case "java.io.File": descriptor = new MethodDescriptor("toPath", ValueType.object("java.nio.file.Path")); break;
                case "java.nio.file.Path": descriptor = new MethodDescriptor("resolve", ValueType.object("java.lang.String"), ValueType.arrayOf(ValueType.object("java.lang.String")), ValueType.object("java.nio.file.Path")); break;
                default: return;
            }
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException(descriptor + " already exists. Reassess the compatibility extension.");
            MethodHolder method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            if (cls.getName().equals("java.lang.Math") || cls.getName().equals("java.lang.Thread")) method.getModifiers().add(ElementModifier.STATIC);
            cls.addMethod(method);
            ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
            switch (cls.getName()) {
                case "java.lang.Math": body.invoke(FmaSupport.class, "fma", float.class, body.var(1, float.class), body.var(2, float.class), body.var(3, float.class)).returnValue(); break;
                case "java.lang.Thread":
                    // A cooperative scheduler needs a scheduling hint instead of a CPU spin instruction.
                    body.invoke(Thread.class, "yield");
                    body.exit();
                    break;
                case "java.lang.String":
                    body.var(0, String.class).invokeSpecial("<init>", body.invoke(LegacyStringSupport.class, "fromBytes", String.class,
                            body.var(1, byte[].class), body.var(2, int.class), body.var(3, int.class), body.var(4, int.class)));
                    body.exit();
                    break;
                case "java.io.PrintStream":
                    body.var(0, PrintStream.class).invokeSpecial("<init>", body.invoke(PrintStreamSupport.class, "open", OutputStream.class, body.var(1, File.class)));
                    body.exit();
                    break;
                case "java.io.Reader": body.invoke(ReaderSupport.class, "transferTo", long.class, body.var(0, Reader.class), body.var(1, Writer.class)).returnValue(); break;
                case "java.io.File": body.invoke(PathSupport.class, "toPath", Path.class, body.var(0, File.class)).returnValue(); break;
                case "java.nio.file.Path": body.invoke(PathSupport.class, "resolve", Path.class, body.var(0, Path.class), body.var(1, String.class), body.var(2, String[].class)).returnValue(); break;
            }
        });
    }
}
