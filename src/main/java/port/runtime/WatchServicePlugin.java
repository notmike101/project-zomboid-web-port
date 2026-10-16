package port.runtime;

import java.nio.file.FileSystem;
import java.nio.file.WatchService;
import java.nio.file.Path;
import java.nio.file.WatchKey;
import java.nio.file.WatchEvent;
import org.teavm.model.AccessLevel;
import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Connects the default virtual filesystem to an actual polling watcher. */
public final class WatchServicePlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.watchService")) return;
        host.add((cls, context) -> {
            if (cls.getName().equals("java.nio.file.Path")) cls.getInterfaces().add("java.nio.file.Watchable");
            if (cls.getName().equals("java.nio.file.Watchable")) {
                for (MethodHolder method : cls.getMethods()) {
                    if (!method.getName().equals("register")) continue;
                    method.getModifiers().remove(ElementModifier.ABSTRACT);
                    ProgramEmitter bridge = ProgramEmitter.create(method, context.getHierarchy());
                    if (method.parameterCount() == 2) {
                        bridge.invoke(PollingWatchService.class, "register", WatchKey.class, bridge.var(0, Path.class),
                                bridge.var(1, WatchService.class), bridge.var(2, WatchEvent.Kind[].class)).returnValue();
                    } else {
                        bridge.invoke(PollingWatchService.class, "register", WatchKey.class, bridge.var(0, Path.class),
                                bridge.var(1, WatchService.class), bridge.var(2, WatchEvent.Kind[].class),
                                bridge.var(3, WatchEvent.Modifier[].class)).returnValue();
                    }
                }
            }
            if (!cls.getName().equals("java.nio.file.FileSystem")) return;
            MethodDescriptor descriptor = new MethodDescriptor("newWatchService", WatchService.class);
            if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Watch service API already exists");
            MethodHolder method = new MethodHolder(descriptor);
            method.setLevel(AccessLevel.PUBLIC);
            cls.addMethod(method);
            ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
            body.invoke(PollingWatchService.class, "create", WatchService.class,
                    body.var(0, FileSystem.class)).returnValue();
        });
    }
}
