package port.runtime;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;
import java.util.Objects;
import org.teavm.jso.JSBody;

/** Resource URLs for the one immutable game archive configured by the browser host. */
public final class ResourceSupport {
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
}
