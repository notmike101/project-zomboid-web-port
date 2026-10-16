package port.runtime;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Objects;
import org.teavm.jso.JSBody;

/** Resource URLs for the one immutable game archive configured by the browser host. */
public final class ResourceSupport {
    public static URL getClassResource(Class<?> owner, String name) {
        Objects.requireNonNull(name);
        if (name.startsWith("/")) return getResource(name.substring(1));
        while (owner.isArray()) owner = owner.getComponentType();
        String className = owner.getName();
        int separator = className.lastIndexOf('.');
        if (separator >= 0) name = className.substring(0, separator + 1).replace('.', '/') + name;
        return getResource(name);
    }
    public static String getSpecificationVersion(Package pkg) { return manifestVersion(pkg.getName(), ""); }
    public static String getImplementationVersion(Package pkg) { return manifestVersion(pkg.getName(), "Implementation-Version:"); }
    public static URL getResource(String name) {
        String location = locate(Objects.requireNonNull(name));
        if (location == null) return null;
        try { return new URL(location); }
        catch (MalformedURLException failure) { throw new IllegalStateException("Invalid resource host URL", failure); }
    }
    public static Enumeration<URL> getResources(String name) {
        URL resource = getResource(name);
        return Collections.enumeration(resource == null ? Collections.emptyList() : Collections.singletonList(resource));
    }
    @JSBody(params = "name", script = """
            if (!(window.portResources instanceof Set)) throw new Error('Resource host is not installed');
            return window.portResources.has(name) ? new URL('/classpath?name=' + encodeURIComponent(name), location.href).href : null;
            """)
    private static native String locate(String name);
    @JSBody(params = {"name", "prefix"}, script = """
            if (!(window.portPackageMetadata instanceof Map)) throw new Error('Package metadata host is not installed');
            if (!window.portArchivePackages.has(name)) return null;
            const metadata = window.portPackageMetadata;
            return metadata.has(prefix + name) ? metadata.get(prefix + name) : metadata.has(prefix) ? metadata.get(prefix) : null;
            """)
    private static native String manifestVersion(String name, String prefix);
}
