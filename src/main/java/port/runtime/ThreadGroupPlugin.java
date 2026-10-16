package port.runtime;

import org.teavm.model.AccessLevel;
import org.teavm.model.ElementModifier;
import org.teavm.model.FieldHolder;
import org.teavm.model.FieldReference;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.instructions.ExitInstruction;
import org.teavm.model.instructions.InvocationType;
import org.teavm.model.instructions.InvokeInstruction;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Adds group identity to TeaVM's actual cooperative Thread constructors and lifecycle. */
public final class ThreadGroupPlugin implements TeaVMPlugin {
    private static final String FIELD = "portThreadGroup";
    private static final ValueType GROUP = ValueType.object("java.lang.ThreadGroup");
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.threadGroups")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals(ThreadGroupSupport.class.getName())) {
                for (var method : cls.getMethods()) {
                    if (!method.getModifiers().contains(ElementModifier.NATIVE)) continue;
                    method.getModifiers().remove(ElementModifier.NATIVE);
                    ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
                    switch (method.getName()) {
                        case "rawGroup": body.var(1, Thread.class).getField(FIELD, GROUP).returnValue(); break;
                        case "setGroup": body.var(1, Thread.class).setField(FIELD, body.var(2, GROUP)); body.exit(); break;
                        case "rootGroup": body.getField(new FieldReference("java.lang.ThreadGroup", "MAIN"), GROUP).returnValue(); break;
                        default: throw new IllegalStateException("Unknown thread group bridge");
                    }
                }
                return;
            }
            if (!cls.getName().equals("java.lang.Thread")) return;
            if (cls.getField(FIELD) != null) throw new IllegalStateException("Thread group field already exists");
            FieldHolder field = new FieldHolder(FIELD);
            field.setLevel(AccessLevel.PRIVATE);
            field.setType(GROUP);
            cls.addField(field);
            var constructor = cls.getMethod(new MethodDescriptor("<init>", Runnable.class, String.class, void.class));
            if (constructor == null || constructor.getProgram() == null) throw new IllegalStateException("TeaVM Thread constructor changed");
            int returns = 0;
            var program = constructor.getProgram();
            for (int block = 0; block < program.basicBlockCount(); block++) {
                for (var instruction : program.basicBlockAt(block)) {
                    if (!(instruction instanceof ExitInstruction)) continue;
                    InvokeInstruction inherit = new InvokeInstruction();
                    inherit.setType(InvocationType.SPECIAL);
                    inherit.setMethod(new MethodReference(ThreadGroupSupport.class, "inherit", Thread.class, void.class));
                    inherit.setArguments(program.variableAt(0));
                    instruction.insertPrevious(inherit);
                    returns++;
                }
            }
            if (returns == 0) throw new IllegalStateException("Thread constructor has no return");
            MethodDescriptor descriptor = new MethodDescriptor("<init>", ThreadGroup.class, Runnable.class, void.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Thread group constructor already exists");
            MethodHolder grouped = new MethodHolder(descriptor);
            grouped.setLevel(AccessLevel.PUBLIC);
            cls.addMethod(grouped);
            var body = ProgramEmitter.create(grouped, context.getHierarchy());
            body.var(0, Thread.class).invokeSpecial("<init>", body.var(2, Runnable.class));
            body.invoke(ThreadGroupSupport.class, "assign", body.var(0, Thread.class), body.var(1, GROUP));
            body.exit();
            MethodHolder getter = new MethodHolder(new MethodDescriptor("getThreadGroup", ThreadGroup.class));
            if (cls.getMethod(getter.getDescriptor()) != null) throw new IllegalStateException("Thread group accessor already exists");
            getter.setLevel(AccessLevel.PUBLIC);
            getter.getModifiers().add(ElementModifier.FINAL);
            cls.addMethod(getter);
            body = ProgramEmitter.create(getter, context.getHierarchy());
            body.invoke(ThreadGroupSupport.class, "groupOf", ThreadGroup.class, body.var(0, Thread.class)).returnValue();
        });
    }
}
