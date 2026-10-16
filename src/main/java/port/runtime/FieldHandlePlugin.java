package port.runtime;

import org.teavm.model.AccessLevel;
import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.ElementModifier;
import org.teavm.model.FieldHolder;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.instructions.ClassConstantInstruction;
import org.teavm.model.instructions.InvokeInstruction;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Lowers caller-sensitive lookup and reference-field signature-polymorphic modes. */
public final class FieldHandlePlugin implements TeaVMPlugin {
    private static final String METHODS = "java.lang.invoke.MethodHandles";
    private static final String LOOKUP = METHODS + "$Lookup";
    private static final String HANDLE = "java.lang.invoke.VarHandle";
    private static final ValueType CLASS = ValueType.object("java.lang.Class");
    private static final ValueType OBJECT = ValueType.object("java.lang.Object");
    private static final ValueType SUPPORT = ValueType.object(FieldHandleSupport.class.getName());

    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.fieldHandles")) return;
        host.add((cls, context) -> {
            captureCallers(cls);
            if (cls.getName().equals(METHODS)) {
                MethodHolder lookup = add(cls, new MethodDescriptor("lookup", CLASS, ValueType.object(LOOKUP)));
                lookup.getModifiers().add(ElementModifier.STATIC);
                ProgramEmitter body = ProgramEmitter.create(lookup, context.getHierarchy());
                body.construct(LOOKUP, body.var(1, CLASS)).returnValue();
            } else if (cls.getName().equals(LOOKUP)) {
                field(cls, "portCaller", CLASS);
                MethodHolder constructor = add(cls, new MethodDescriptor("<init>", CLASS, ValueType.VOID));
                ProgramEmitter body = ProgramEmitter.create(constructor, context.getHierarchy());
                body.var(0, ValueType.object(LOOKUP)).invokeSpecial(Object.class, "<init>");
                body.var(0, ValueType.object(LOOKUP)).setField("portCaller", body.var(1, CLASS));
                body.exit();
                MethodHolder find = add(cls, new MethodDescriptor("findVarHandle", CLASS,
                        ValueType.object("java.lang.String"), CLASS, ValueType.object(HANDLE)));
                body = ProgramEmitter.create(find, context.getHierarchy());
                var support = body.invoke(FieldHandleSupport.class, "find", FieldHandleSupport.class,
                        body.var(0, ValueType.object(LOOKUP)).getField("portCaller", CLASS),
                        body.var(1, CLASS), body.var(2, String.class), body.var(3, CLASS));
                body.construct(HANDLE, support).returnValue();
            } else if (cls.getName().equals(HANDLE)) {
                field(cls, "portField", SUPPORT);
                MethodHolder constructor = add(cls, new MethodDescriptor("<init>", SUPPORT, ValueType.VOID));
                ProgramEmitter body = ProgramEmitter.create(constructor, context.getHierarchy());
                body.var(0, ValueType.object(HANDLE)).invokeSpecial(Object.class, "<init>");
                body.var(0, ValueType.object(HANDLE)).setField("portField", body.var(1, SUPPORT));
                body.exit();
                for (String receiver : new String[]{"java.lang.Object", "zombie.util.LazyValue", "probe.FieldHandleProbe$Holder"}) {
                    addModes(cls, context, ValueType.object(receiver));
                }
            }
        });
    }

    private static void captureCallers(ClassHolder cls) {
        // Compiler intrinsic: lookup capability belongs to the class containing the call, never its target field.
        MethodReference lookup = new MethodReference(METHODS, "lookup", ValueType.object(LOOKUP));
        for (MethodHolder method : cls.getMethods()) {
            var program = method.getProgram();
            if (program == null) continue;
            for (int i = 0; i < program.basicBlockCount(); i++) {
                for (var instruction : program.basicBlockAt(i)) {
                    if (!(instruction instanceof InvokeInstruction call) || !call.getMethod().equals(lookup)) continue;
                    var caller = program.createVariable();
                    ClassConstantInstruction constant = new ClassConstantInstruction();
                    constant.setConstant(ValueType.object(cls.getName()));
                    constant.setReceiver(caller);
                    constant.setLocation(call.getLocation());
                    call.insertPrevious(constant);
                    call.setMethod(new MethodReference(METHODS, "lookup", CLASS, ValueType.object(LOOKUP)));
                    call.setArguments(caller);
                }
            }
        }
    }

    private static void addModes(ClassHolder cls, ClassHolderTransformerContext context, ValueType receiver) {
        MethodHolder read = add(cls, new MethodDescriptor("getVolatile", receiver, OBJECT));
        ProgramEmitter body = ProgramEmitter.create(read, context.getHierarchy());
        body.var(0, ValueType.object(HANDLE)).getField("portField", SUPPORT)
                .invokeVirtual("getVolatile", Object.class, body.var(1, receiver).cast(Object.class)).returnValue();
        MethodHolder exchange = add(cls, new MethodDescriptor("compareAndExchange", receiver, OBJECT, OBJECT, OBJECT));
        body = ProgramEmitter.create(exchange, context.getHierarchy());
        body.var(0, ValueType.object(HANDLE)).getField("portField", SUPPORT)
                .invokeVirtual("compareAndExchange", Object.class, body.var(1, receiver).cast(Object.class),
                        body.var(2, Object.class), body.var(3, Object.class)).returnValue();
    }
    private static MethodHolder add(ClassHolder cls, MethodDescriptor descriptor) {
        if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Field handle API already exists: " + descriptor);
        MethodHolder method = new MethodHolder(descriptor);
        method.setLevel(AccessLevel.PUBLIC);
        cls.addMethod(method);
        return method;
    }
    private static void field(ClassHolder cls, String name, ValueType type) {
        if (cls.getField(name) != null) throw new IllegalStateException("Field handle storage already exists");
        FieldHolder field = new FieldHolder(name);
        field.setType(type);
        field.setLevel(AccessLevel.PRIVATE);
        cls.addField(field);
    }
}
