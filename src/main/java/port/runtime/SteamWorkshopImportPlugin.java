package port.runtime;

import org.teavm.model.AnnotationHolder;
import org.teavm.model.AnnotationValue;
import org.teavm.model.ElementModifier;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.ValueType;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Declares the original JNI boundary; the browser host reports unavailable Steam integration. */
public final class SteamWorkshopImportPlugin implements TeaVMPlugin {
    @Override public void install(TeaVMHost host) {
        if (!Boolean.getBoolean("port.nativeCapabilities")) return;
        host.add((cls, context) -> {
            if (!cls.getName().equals("zombie.core.znet.SteamWorkshop")) return;
            var method = cls.getMethod(new MethodDescriptor("n_GetInstalledItemFolders",
                    ValueType.arrayOf(ValueType.object("java.lang.String"))));
            if (method == null || !method.hasModifier(ElementModifier.NATIVE))
                throw new IllegalStateException("Steam Workshop native signature changed");
            var annotation = new AnnotationHolder("org.teavm.interop.Import");
            annotation.getValues().put("module", new AnnotationValue("portNative"));
            annotation.getValues().put("name", new AnnotationValue("steamWorkshopFolders"));
            method.getAnnotations().add(annotation);
        });
    }
}
