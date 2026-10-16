package port.runtime;

import java.io.OutputStream;
import java.io.PrintStream;
import org.teavm.model.AccessLevel;
import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.FieldHolder;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;

/** Repairs TeaVM 0.16's inverted close guard and closed-stream error inspection. */
public final class PrintStreamTransformer {
    public static void transform(ClassHolder cls, ClassHolderTransformerContext context) {
        if (!cls.getName().equals("java.io.PrintStream")) return;
        if (cls.getField("errorState") == null || cls.getField("portClosing") != null) {
            throw new IllegalStateException("PrintStream fields changed; reassess lifecycle repair");
        }
        FieldHolder closing = new FieldHolder("portClosing");
        closing.setType(ValueType.BOOLEAN);
        closing.setLevel(AccessLevel.PRIVATE);
        cls.addField(closing);
        cls.getInterfaces().add(PrintStreamSupport.Access.class.getName());
        accessors(cls, context, "portOutput", "out", OutputStream.class);
        accessors(cls, context, "portError", "errorState", boolean.class);
        accessors(cls, context, "portClosing", "portClosing", boolean.class);
        MethodHolder close = cls.getMethod(new MethodDescriptor("close", void.class));
        MethodHolder check = cls.getMethod(new MethodDescriptor("checkError", boolean.class));
        if (close == null || check == null) throw new IllegalStateException("PrintStream lifecycle API changed");
        ProgramEmitter closeBody = ProgramEmitter.create(close, context.getHierarchy());
        closeBody.invoke(PrintStreamSupport.class, "close", closeBody.var(0, PrintStream.class));
        closeBody.exit();
        ProgramEmitter checkBody = ProgramEmitter.create(check, context.getHierarchy());
        checkBody.invoke(PrintStreamSupport.class, "checkError", boolean.class,
                checkBody.var(0, PrintStream.class)).returnValue();
    }

    private static void accessors(ClassHolder cls, ClassHolderTransformerContext context,
            String methodName, String fieldName, Class<?> type) {
        MethodHolder getter = new MethodHolder(new MethodDescriptor(methodName, type));
        getter.setLevel(AccessLevel.PUBLIC);
        cls.addMethod(getter);
        ProgramEmitter getBody = ProgramEmitter.create(getter, context.getHierarchy());
        getBody.var(0, PrintStream.class).getField(fieldName, type).returnValue();
        MethodHolder setter = new MethodHolder(new MethodDescriptor(methodName, type, void.class));
        setter.setLevel(AccessLevel.PUBLIC);
        cls.addMethod(setter);
        ProgramEmitter setBody = ProgramEmitter.create(setter, context.getHierarchy());
        setBody.var(0, PrintStream.class).setField(fieldName, setBody.var(1, type));
        setBody.exit();
    }
}
