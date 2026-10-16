package port.runtime;

import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.model.instructions.ConstructArrayInstruction;
import org.teavm.model.instructions.ExitInstruction;
import org.teavm.model.instructions.IntegerConstantInstruction;
import org.teavm.model.instructions.InvocationType;
import org.teavm.model.instructions.InvokeInstruction;
import org.teavm.model.instructions.SwitchInstruction;
import org.teavm.model.instructions.SwitchTableEntry;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Repairs the empty-input/no-progress contract of pinned TeaVM's real jzlib-backed Inflater. */
public final class InflaterPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.inflater")) return;
        host.add((cls, context) -> {
            if (!cls.getName().equals("java.util.zip.Inflater")) return;
            // jzlib rejects a null next_in as Z_STREAM_ERROR, even when available input is zero.
            // Give construction/reset a legitimate empty input buffer instead of masking that error.
            for (var descriptor : new MethodDescriptor[]{
                    new MethodDescriptor("<init>", boolean.class, void.class),
                    new MethodDescriptor("reset", void.class)}) {
                var method = cls.getMethod(descriptor);
                if (method == null || method.getProgram() == null) throw new IllegalStateException("Pinned Inflater lifecycle changed");
                var program = method.getProgram();
                int exits = 0;
                for (int index = 0; index < program.basicBlockCount(); index++) {
                    for (var instruction : program.basicBlockAt(index)) {
                        if (!(instruction instanceof ExitInstruction)) continue;
                        var size = program.createVariable();
                        var zero = new IntegerConstantInstruction(); zero.setReceiver(size); zero.setConstant(0);
                        var bytes = program.createVariable();
                        var array = new ConstructArrayInstruction(); array.setReceiver(bytes); array.setSize(size); array.setItemType(ValueType.BYTE);
                        var input = new InvokeInstruction();
                        input.setType(InvocationType.SPECIAL);
                        input.setMethod(new MethodReference(java.util.zip.Inflater.class, "setInput", byte[].class, void.class));
                        input.setInstance(program.variableAt(0)); input.setArguments(bytes);
                        instruction.insertPrevious(zero); instruction.insertPrevious(array); instruction.insertPrevious(input);
                        exits++;
                    }
                }
                if (exits == 0) throw new IllegalStateException("Inflater lifecycle has no return");
            }
            var method = cls.getMethod(new MethodDescriptor("inflate", byte[].class, int.class, int.class, int.class));
            if (method == null || method.getProgram() == null) throw new IllegalStateException("Pinned Inflater inflate changed");
            int switches = 0;
            var program = method.getProgram();
            for (int index = 0; index < program.basicBlockCount(); index++) {
                for (var instruction : program.basicBlockAt(index)) {
                    if (!(instruction instanceof SwitchInstruction)) continue;
                    SwitchInstruction status = (SwitchInstruction) instruction;
                    if (status.getEntries().size() != 3) throw new IllegalStateException("Pinned Inflater status switch changed");
                    var ok = status.getEntries().stream().filter(entry -> entry.getCondition() == 0).findFirst().orElseThrow();
                    if (status.getEntries().stream().noneMatch(entry -> entry.getCondition() == 1)
                            || status.getEntries().stream().noneMatch(entry -> entry.getCondition() == 2))
                        throw new IllegalStateException("Pinned Inflater status cases changed");
                    SwitchTableEntry noProgress = new SwitchTableEntry();
                    noProgress.setCondition(-5); // jzlib Z_BUF_ERROR means no progress; malformed input remains Z_DATA_ERROR.
                    noProgress.setTarget(ok.getTarget());
                    status.getEntries().add(noProgress);
                    switches++;
                }
            }
            if (switches != 1) throw new IllegalStateException("Expected one pinned Inflater status switch");
        });
    }
}
