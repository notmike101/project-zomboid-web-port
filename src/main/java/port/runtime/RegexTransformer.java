package port.runtime;

import java.util.ArrayList;
import java.util.function.Function;
import java.util.regex.Matcher;
import org.teavm.model.AccessLevel;
import org.teavm.model.ClassHolder;
import org.teavm.model.ClassHolderTransformerContext;
import org.teavm.model.FieldHolder;
import org.teavm.model.MethodDescriptor;
import org.teavm.model.MethodHolder;
import org.teavm.model.ValueType;
import org.teavm.model.emit.ProgramEmitter;
import org.teavm.model.emit.ValueEmitter;

/** Adds functional replacement and mutation tracking at JDK-equivalent state transitions. */
public final class RegexTransformer {
    public static void transform(ClassHolder cls, ClassHolderTransformerContext context) {
        if (!Boolean.getBoolean("port.regex") || !cls.getName().equals("java.util.regex.Matcher")) return;
        if (cls.getField("portRegexEpoch") != null) throw new IllegalStateException("Matcher epoch already exists");
        FieldHolder epoch = new FieldHolder("portRegexEpoch");
        epoch.setType(ValueType.INTEGER);
        epoch.setLevel(AccessLevel.PRIVATE);
        cls.addField(epoch);
        cls.getInterfaces().add(RegexSupport.Access.class.getName());
        MethodHolder getter = new MethodHolder(new MethodDescriptor("portRegexEpoch", int.class));
        getter.setLevel(AccessLevel.PUBLIC);
        cls.addMethod(getter);
        ProgramEmitter body = ProgramEmitter.create(getter, context.getHierarchy());
        body.var(0, Matcher.class).getField("portRegexEpoch", int.class).returnValue();
        int instrumented = 0;
        for (MethodHolder method : new ArrayList<>(cls.getMethods())) {
            String name = method.getName();
            boolean mutation = name.equals("reset") && method.parameterCount() == 0
                    || name.equals("region") || name.equals("usePattern") || name.equals("appendReplacement")
                    || name.equals("findAt") || name.equals("lookingAt") && method.parameterCount() == 2;
            if (mutation) { wrap(cls, method, context); instrumented++; }
        }
        if (instrumented != 6) throw new IllegalStateException("Matcher mutation methods changed: " + instrumented);
        MethodHolder parser = cls.getMethod(new MethodDescriptor("processReplacement", String.class, String.class));
        if (parser == null) throw new IllegalStateException("Matcher replacement parser changed");
        body = ProgramEmitter.create(parser, context.getHierarchy());
        body.invoke(RegexSupport.class, "expandReplacement", String.class,
                body.var(0, Matcher.class), body.var(1, String.class)).returnValue();
        MethodDescriptor descriptor = new MethodDescriptor("replaceAll", Function.class, String.class);
        if (cls.getMethod(descriptor) != null) throw new IllegalStateException("Functional replacement already exists");
        MethodHolder replacement = new MethodHolder(descriptor);
        replacement.setLevel(AccessLevel.PUBLIC);
        cls.addMethod(replacement);
        body = ProgramEmitter.create(replacement, context.getHierarchy());
        body.invoke(RegexSupport.class, "replaceAll", String.class,
                body.var(0, Matcher.class), body.var(1, Function.class)).returnValue();
    }

    private static void wrap(ClassHolder cls, MethodHolder method, ClassHolderTransformerContext context) {
        MethodHolder original = new MethodHolder(new MethodDescriptor("port$" + method.getName(), method.getDescriptor().getSignature()));
        original.setLevel(AccessLevel.PRIVATE);
        original.setProgram(method.getProgram());
        cls.addMethod(original);
        ProgramEmitter body = ProgramEmitter.create(method, context.getHierarchy());
        ValueEmitter[] arguments = new ValueEmitter[method.parameterCount()];
        for (int i = 0; i < arguments.length; i++) arguments[i] = body.var(i + 1, method.getParameterTypes()[i]);
        ValueEmitter result = body.var(0, Matcher.class).invokeSpecial(original.getReference(), arguments);
        // Exceptions from invalid arguments bypass this increment, as in the JDK.
        body.var(0, Matcher.class).setField("portRegexEpoch", body.var(0, Matcher.class).getField("portRegexEpoch", int.class).add(1));
        result.returnValue();
    }
}
