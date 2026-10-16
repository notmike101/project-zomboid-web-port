package probe;

import java.net.URL;
import java.util.Arrays;
import java.util.NoSuchElementException;

/** Reads only resources in the installed archive, never native libraries or game saves. */
public final class ResourceProbe {
    public static void main(String[] args) throws Exception {
        ClassLoader loader = ResourceProbe.class.getClassLoader();
        String[] names = {"properties", "manifest", "enumeration", "missing", "leading-slash", "null-resource", "null-resources", "exhausted", "archive-package", "adapter-package", "archive-implementation", "adapter-implementation", "class-absolute", "class-relative", "class-array-relative", "class-missing", "class-null", "class-adapter-absolute"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for(int i=0;i<names.length;i++) {
            int size=0, hash=0;
            if(i<3) {
                String name=i==1?"META-INF/MANIFEST.MF":"imgui/imgui-java.properties";
                URL url=loader.getResource(name);
                if(url==null) throw new AssertionError("Resource absent");
                byte[] bytes;
                try(var stream=url.openStream()) { bytes=stream.readAllBytes(); }
                if(bytes.length==0) throw new AssertionError("Empty resource");
                size=bytes.length; hash=Arrays.hashCode(bytes);
                if(i==2) {
                    var enumeration=loader.getResources(name);
                    if(!enumeration.hasMoreElements()) throw new AssertionError("Missing enumeration result");
                    try(var stream=enumeration.nextElement().openStream()) { if(!Arrays.equals(bytes,stream.readAllBytes())) throw new AssertionError("Resource contents differ"); }
                    if(enumeration.hasMoreElements()) throw new AssertionError("Unexpected duplicate resource");
                }
            } else if(i==3 || i==4) {
                String name=i==3?"port-intentionally-missing-resource-2026":"/imgui/imgui-java.properties";
                if(loader.getResource(name)!=null || loader.getResources(name).hasMoreElements()) throw new AssertionError("Invalid resource present");
                size=1;
            } else if(i==5 || i==6) {
                try { if(i==5) loader.getResource(null); else loader.getResources(null); throw new AssertionError("Null name accepted"); }
                catch(NullPointerException expected) { size=1; }
            } else if (i==7) {
                var enumeration=loader.getResources("port-intentionally-missing-resource-2026");
                try { enumeration.nextElement(); throw new AssertionError("Exhausted enumeration accepted"); }
                catch(NoSuchElementException expected) { size=1; }
            } else if(i<12) {
                Package pkg = (i==8 || i==10) ? org.lwjgl.Version.class.getPackage() : ResourceProbe.class.getPackage();
                String version = i<10 ? pkg.getSpecificationVersion() : pkg.getImplementationVersion();
                size = version == null ? -1 : version.length();
                hash = version == null ? 0 : version.hashCode();
            } else if(i==15) {
                if(imgui.ImColor.class.getResource("port-intentionally-missing-resource-2026")!=null) throw new AssertionError("Missing class resource present");
                size=1;
            } else if(i==16) {
                try { imgui.ImColor.class.getResource(null); throw new AssertionError("Null class resource accepted"); }
                catch(NullPointerException expected) { size=1; }
            } else {
                URL url = i==12 ? org.lwjgl.Version.class.getResource("/imgui/imgui-java.properties")
                        : i==13 ? imgui.ImColor.class.getResource("imgui-java.properties")
                        : i==14 ? imgui.ImColor[][].class.getResource("imgui-java.properties")
                        : ResourceProbe.class.getResource("/imgui/imgui-java.properties");
                if(url==null) throw new AssertionError("Class resource absent");
                byte[] bytes;
                try(var stream=url.openStream()) { bytes=stream.readAllBytes(); }
                if(bytes.length==0) throw new AssertionError("Empty class resource");
                size=bytes.length; hash=Arrays.hashCode(bytes);
            }
            if(i!=0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"size\":"); append(json,size);
            json.append(",\"contentHash\":");append(json,hash);json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static void append(StringBuilder json,int value) {
        String bits=Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for(int i=bits.length();i<8;i++)json.append('0');
        json.append(bits).append("\"}");
    }
}
