package port.runtime;

import java.io.Closeable;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.channels.FileChannel;
import org.teavm.model.AccessLevel;
import org.teavm.model.ElementModifier;
import org.teavm.model.FieldHolder;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.instructions.ExitInstruction;
import org.teavm.model.instructions.InvocationType;
import org.teavm.model.instructions.InvokeInstruction;
import org.teavm.runtime.fs.VirtualFileAccessor;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Adds real shared-position/channel ownership to stock pathname-backed FileOutputStream. */
public final class FileOutputChannelPlugin implements TeaVMPlugin {
    private static final String FIELD = "portOutputChannelState";
    private static final ValueType STATE = ValueType.object(FileOutputChannelSupport.State.class.getName());
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.outputChannels")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals(FileOutputChannelSupport.class.getName())) {
                for (var method : cls.getMethods()) {
                    if (!method.getModifiers().contains(ElementModifier.NATIVE)) continue;
                    method.getModifiers().remove(ElementModifier.NATIVE);
                    var body = ProgramEmitter.create(method, context.getHierarchy());
                    switch (method.getName()) {
                        case "state": body.var(1, FileOutputStream.class).getField(FIELD, STATE).returnValue(); break;
                        case "setState": body.var(1, FileOutputStream.class).setField(FIELD, body.var(2, STATE)); body.exit(); break;
                        case "accessor": body.var(1, FileOutputStream.class).getField("accessor", VirtualFileAccessor.class).returnValue(); break;
                        case "create": body.construct("java.nio.channels.FileChannel", body.var(1, VirtualFileAccessor.class),
                                body.var(2, File.class), body.var(3, boolean.class), body.var(4, Closeable.class)).returnValue(); break;
                        default: throw new IllegalStateException("Unknown output-channel bridge");
                    }
                }
                return;
            }
            if (!cls.getName().equals("java.io.FileOutputStream")) return;
            if (cls.getField(FIELD) != null) throw new IllegalStateException("Output channel state already exists");
            FieldHolder field = new FieldHolder(FIELD); field.setType(STATE); field.setLevel(AccessLevel.PRIVATE); cls.addField(field);
            var constructor = cls.getMethod(new MethodDescriptor("<init>", File.class, boolean.class, void.class));
            if (constructor == null || constructor.getProgram() == null) throw new IllegalStateException("Stock output stream constructor changed");
            var program = constructor.getProgram();
            for (int block = 0; block < program.basicBlockCount(); block++) {
                for (var instruction : program.basicBlockAt(block)) {
                    if (!(instruction instanceof ExitInstruction)) continue;
                    var initialize = new InvokeInstruction(); initialize.setType(InvocationType.SPECIAL);
                    initialize.setMethod(new MethodReference(FileOutputChannelSupport.class, "initialize", FileOutputStream.class, File.class, boolean.class, void.class));
                    initialize.setArguments(program.variableAt(0), program.variableAt(1), program.variableAt(2));
                    instruction.insertPrevious(initialize);
                }
            }
            var close = cls.getMethod(new MethodDescriptor("close", void.class));
            if (close == null || close.getProgram() == null) throw new IllegalStateException("Stock output stream close changed");
            var hook = new InvokeInstruction(); hook.setType(InvocationType.SPECIAL);
            hook.setMethod(new MethodReference(FileOutputChannelSupport.class, "closeAttached", FileOutputStream.class, void.class));
            hook.setArguments(close.getProgram().variableAt(0));
            close.getProgram().basicBlockAt(0).getFirstInstruction().insertPrevious(hook);
            for (var method : cls.getMethods()) {
                if (!method.getName().equals("write") || method.getProgram() == null) continue;
                program = method.getProgram();
                for (int block = 0; block < program.basicBlockCount(); block++) {
                    for (var instruction : program.basicBlockAt(block)) {
                        if (!(instruction instanceof InvokeInstruction)) continue;
                        var invoke = (InvokeInstruction) instruction;
                        if (!invoke.getMethod().getClassName().equals(VirtualFileAccessor.class.getName()) || !invoke.getMethod().getName().equals("write")) continue;
                        var prepare = new InvokeInstruction(); prepare.setType(InvocationType.SPECIAL);
                        prepare.setMethod(new MethodReference(FileOutputChannelSupport.class, "prepareWrite", FileOutputStream.class, int.class, void.class));
                        prepare.setArguments(program.variableAt(0), invoke.getArguments().get(2)); instruction.insertPrevious(prepare);
                    }
                }
            }
            var descriptor = new MethodDescriptor("getChannel", FileChannel.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Output channel accessor already exists");
            MethodHolder getter = new MethodHolder(descriptor); getter.setLevel(AccessLevel.PUBLIC); cls.addMethod(getter);
            var body = ProgramEmitter.create(getter, context.getHierarchy());
            body.invoke(FileOutputChannelSupport.class, "getChannel", FileChannel.class, body.var(0, FileOutputStream.class)).returnValue();
        });
    }
}
