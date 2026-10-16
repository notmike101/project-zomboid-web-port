package port.runtime;

import java.util.concurrent.TimeUnit;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Corrects TeaVM 0.16's overflowing integer timeout conversions. */
public final class TimeUnitPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        host.add((cls, context) -> {
            if (!cls.getName().equals("java.util.concurrent.TimeUnit")) return;
            String[] names = {"toNanos", "toMicros", "toMillis", "toSeconds", "toMinutes", "toHours", "toDays", "convert"};
            TimeUnit[] targets = TimeUnit.values();
            for (int i = 0; i < names.length; i++) {
                boolean general = i == 7;
                var descriptor = general ? new MethodDescriptor(names[i], long.class, TimeUnit.class, long.class)
                        : new MethodDescriptor(names[i], long.class, long.class);
                var method = cls.getMethod(descriptor);
                if (method == null) throw new IllegalStateException("TimeUnit conversion changed: " + descriptor);
                var body = ProgramEmitter.create(method, context.getHierarchy());
                var target = general ? body.var(0, TimeUnit.class) : body.getField(TimeUnit.class, targets[i].name(), TimeUnit.class);
                var source = general ? body.var(2, TimeUnit.class) : body.var(0, TimeUnit.class);
                body.invoke(TimeUnitSupport.class, "convert", long.class, target, body.var(1, long.class), source).returnValue();
            }
        });
    }
}
