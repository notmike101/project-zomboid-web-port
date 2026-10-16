package port.runtime;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.teavm.classlib.ReflectionContext;
import org.teavm.classlib.ReflectionSupplier;
import org.teavm.dependency.AbstractDependencyListener;
import org.teavm.dependency.DependencyAgent;
import org.teavm.model.AccessLevel;
import org.teavm.model.ClassReaderSource;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodReference;
import org.teavm.model.ValueType;
import org.teavm.vm.spi.TeaVMHost;
import org.teavm.vm.spi.TeaVMPlugin;

/** Compiler-side opt-in retention from a parse-only original API manifest, never a runtime API substitute. */
public final class ManifestReflectionMetadata implements ReflectionSupplier, TeaVMPlugin {
    private static Manifest manifest;
    private static synchronized Manifest configured() {
        String property = System.getProperty("port.reflectionManifest");
        if (property == null || property.isBlank()) return null;
        Path path = Path.of(property).toAbsolutePath().normalize();
        if (manifest == null || !manifest.path.equals(path)) manifest = new Manifest(path);
        return manifest;
    }
    @Override public void install(TeaVMHost host) {
        Manifest data = configured();
        if (data == null) return;
        host.add(new AbstractDependencyListener() {
            @Override public void started(DependencyAgent agent) {
                data.validateAll(agent.getClassSource());
                var getName = agent.linkMethod(new MethodReference(Class.class,"getName",String.class));
                getName.use();
                getName.getVariable(0).propagate(agent.getType(ValueType.object("java.lang.Class")));
                var lookup = agent.linkMethod(new MethodReference(Class.class,"forName",String.class,Class.class));
                lookup.use();
                lookup.getResult().propagate(agent.getType(ValueType.object("java.lang.Class")));
                for (String name : data.classes.keySet()) {
                    if (!data.availableClasses.contains(name)) continue;
                    agent.linkClass(name);
                    var type = agent.getType(ValueType.object(name));
                    getName.getVariable(0).getClassValueNode().propagate(type);
                    lookup.getResult().getClassValueNode().propagate(type);
                }
            }
            @Override public void complete() { data.writeDiagnostics(); }
        });
    }
    @Override public boolean isClassFoundByName(ReflectionContext context,String className) {
        Manifest data=configured();
        if(data==null || !data.classes.containsKey(className))return false;
        data.validate(className,context.getClassSource());
        return data.availableClasses.contains(className);
    }
    @Override public Collection<MethodDescriptor> getAccessibleMethods(ReflectionContext context,String className) {
        Manifest data=configured();
        if(data==null || !data.classes.containsKey(className))return Collections.emptyList();
        data.validate(className,context.getClassSource());
        return data.classes.get(className).retainedMethods;
    }
    @Override public Collection<String> getAccessibleFields(ReflectionContext context,String className) {
        Manifest data=configured();
        if(data==null || !data.classes.containsKey(className))return Collections.emptyList();
        data.validate(className,context.getClassSource());
        return data.classes.get(className).retainedFields;
    }
    private static final class Request {
        boolean jdk;
        final Set<MethodDescriptor> methods=new LinkedHashSet<>();
        final Set<String> fields=new LinkedHashSet<>();
        final Set<MethodDescriptor> retainedMethods=new LinkedHashSet<>();
        final Set<String> retainedFields=new LinkedHashSet<>();
    }
    private static final class Manifest {
        final Path path;
        final Map<String,Request> classes=new TreeMap<>();
        final Set<String> validated=new LinkedHashSet<>(),availableClasses=new LinkedHashSet<>();
        final ArrayList<String> skipped=new ArrayList<>(),visibilityDifferences=new ArrayList<>();
        String failure;
        Manifest(Path path) {
            this.path=path;
            try {
                int lineNumber=0;
                for(String line:Files.readAllLines(path)) {
                    lineNumber++;
                    if(line.isBlank() || line.startsWith("#"))continue;
                    String[] parts=line.split("\t",-1);
                    if(parts.length<2 || parts[1].isBlank())throw new IllegalArgumentException("Malformed manifest line "+lineNumber);
                    switch(parts[0]) {
                        case "C":
                            if(parts.length!=2)throw new IllegalArgumentException("Malformed C record at "+lineNumber);
                            classes.computeIfAbsent(parts[1],name->new Request());break;
                        case "J":
                            if(parts.length!=2)throw new IllegalArgumentException("Malformed J record at "+lineNumber);
                            request(parts[1],lineNumber).jdk=true;break;
                        case "M":
                            if(parts.length!=3)throw new IllegalArgumentException("Malformed M record at "+lineNumber);
                            MethodDescriptor descriptor=MethodDescriptor.parseIfPossible(parts[2]);
                            if(descriptor==null || descriptor.getName().equals("<clinit>"))throw new IllegalArgumentException("Invalid method at "+lineNumber);
                            request(parts[1],lineNumber).methods.add(descriptor);break;
                        case "F":
                            if(parts.length!=3 || parts[2].isBlank())throw new IllegalArgumentException("Malformed F record at "+lineNumber);
                            request(parts[1],lineNumber).fields.add(parts[2]);break;
                        default:throw new IllegalArgumentException("Unknown manifest record at "+lineNumber);
                    }
                }
                if(classes.isEmpty())throw new IllegalArgumentException("Empty reflection manifest");
            } catch(IOException error) {throw new IllegalStateException("Cannot read reflection manifest "+path,error);}
        }
        private Request request(String name,int line) {
            Request request=classes.get(name);
            if(request==null)throw new IllegalArgumentException("Member/origin record before C at line "+line);
            return request;
        }
        synchronized void validateAll(ClassReaderSource source) {
            try {for(String name:classes.keySet())validate(name,source);}
            finally {writeDiagnostics();}
        }
        synchronized void validate(String name,ClassReaderSource source) {
            if(failure!=null)throw new IllegalStateException(failure);
            if(validated.contains(name))return;
            Request request=classes.get(name);
            var cls=source.get(name);
            if(cls==null) {
                absent(request,name,"class",name);
                validated.add(name);return;
            }
            availableClasses.add(name);
            for(MethodDescriptor descriptor:request.methods) {
                var method=cls.getMethod(descriptor);
                if(method==null)absent(request,name,"method",descriptor.toString());
                else {
                    request.retainedMethods.add(descriptor);
                    if(request.jdk && method.getLevel()!=AccessLevel.PUBLIC)
                        visibilityDifferences.add(name+"\tM\t"+descriptor+"\t"+method.getLevel());
                }
            }
            for(String field:request.fields) {
                var target=cls.getField(field);
                if(target==null)absent(request,name,"field",field);
                else {
                    request.retainedFields.add(field);
                    if(request.jdk && target.getLevel()!=AccessLevel.PUBLIC)
                        visibilityDifferences.add(name+"\tF\t"+field+"\t"+target.getLevel());
                }
            }
            validated.add(name);
        }
        private void absent(Request request,String name,String kind,String member) {
            if(request.jdk)skipped.add(name+"\t"+kind+"\t"+member);
            else {
                failure="Original reflection manifest "+kind+" missing: "+name+"#"+member;
                writeDiagnostics();throw new IllegalStateException(failure);
            }
        }
        synchronized void writeDiagnostics() {
            int methods=0,fields=0,jdk=0;
            for(Request request:classes.values()) {methods+=request.retainedMethods.size();fields+=request.retainedFields.size();if(request.jdk)jdk++;}
            Map<String,Object> report=new LinkedHashMap<>();
            report.put("scope","full requested original members; manifest-listed original public JDK API subset only");
            report.put("requestedClasses",classes.size());report.put("jdkClasses",jdk);
            report.put("validatedClasses",validated.size());report.put("availableClasses",availableClasses.size());
            report.put("retainedMethods",methods);report.put("retainedFields",fields);
            report.put("skippedJdkApiCount",skipped.size());report.put("skippedJdkApis",skipped);
            report.put("jdkVisibilityDifferenceCount",visibilityDifferences.size());report.put("jdkVisibilityDifferences",visibilityDifferences);
            report.put("originalMemberFailure",failure);
            StringBuilder json=new StringBuilder("{");boolean first=true;
            for(var entry:report.entrySet()) {if(!first)json.append(',');first=false;quote(json,entry.getKey());json.append(':');value(json,entry.getValue());}
            try {Files.writeString(Path.of(path+".diagnostics.json"),json.append("}\n"));}
            catch(IOException error) {throw new IllegalStateException("Cannot write reflection manifest diagnostics",error);}
        }
        private static void value(StringBuilder json,Object value) {
            if(value==null)json.append("null");
            else if(value instanceof Collection<?> values) {json.append('[');boolean first=true;for(Object item:values){if(!first)json.append(',');first=false;value(json,item);}json.append(']');}
            else if(value instanceof String text)quote(json,text);
            else json.append(value);
        }
        private static void quote(StringBuilder json,String text) {
            json.append('"');for(int i=0;i<text.length();i++){char ch=text.charAt(i);if(ch=='"'||ch=='\\')json.append('\\').append(ch);else if(ch=='\t')json.append("\\t");else if(ch=='\n')json.append("\\n");else if(ch=='\r')json.append("\\r");else json.append(ch);}json.append('"');
        }
    }
}
