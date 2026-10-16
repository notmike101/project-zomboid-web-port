package port.runtime;

import java.lang.reflect.Array;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import org.teavm.jso.JSBody;

/** Reads genuine class-file signatures supplied by the metadata extraction tool. */
public final class GenericTypeSupport {
    public static Type superclass(Class<?> type) {
        if (type.isPrimitive() || type.isInterface() || type == Object.class) return null;
        if (type.isArray()) return Object.class;
        String signature = required("C|" + type.getName());
        if (signature.isEmpty()) return type.getSuperclass();
        Parser parser = new Parser(signature, type, null);
        parser.skipFormals();
        return parser.type();
    }

    public static Type[] exceptionTypes(Method method) {
        StringBuilder key = new StringBuilder(method.getDeclaringClass().getName()).append('#').append(method.getName()).append('(');
        for (Class<?> parameter : method.getParameterTypes()) descriptor(key, parameter);
        key.append(')'); descriptor(key, method.getReturnType());
        String signature = required("M|" + key);
        List<Type> exceptions = new ArrayList<>();
        if (!signature.isEmpty()) {
            Parser parser = new Parser(signature, method.getDeclaringClass(), method);
            parser.skipFormals();
            parser.expect('(');
            while (parser.peek() != ')') parser.skipType();
            parser.expect(')'); parser.skipType();
            while (!parser.end()) {
                parser.expect('^');
                exceptions.add(parser.type());
            }
            if (!exceptions.isEmpty()) return exceptions.toArray(new Type[0]);
        }
        // A verified absent generic throws clause uses its actual Exceptions attribute.
        Parser raw = new Parser(required("E|" + key), method.getDeclaringClass(), method);
        while (!raw.end()) exceptions.add(raw.type());
        return exceptions.toArray(new Type[0]);
    }

    private static String required(String key) {
        String value = metadata(key);
        if (value == null) throw new UnsupportedOperationException("Generic signature metadata is not mounted: " + key);
        return value;
    }
    @JSBody(params = "key", script = "const map=globalThis.portGenericMetadata; return map && Object.prototype.hasOwnProperty.call(map,key) ? map[key] : null;")
    private static native String metadata(String key);

    private static void descriptor(StringBuilder target, Class<?> type) {
        if (type.isArray()) target.append(type.getName().replace('.', '/'));
        else if (!type.isPrimitive()) target.append('L').append(type.getName().replace('.', '/')).append(';');
        else target.append(type == void.class ? 'V' : type == boolean.class ? 'Z' : type == byte.class ? 'B'
                : type == char.class ? 'C' : type == short.class ? 'S' : type == int.class ? 'I'
                : type == long.class ? 'J' : type == float.class ? 'F' : 'D');
    }

    private static final class Parser {
        final String signature;
        final Class<?> declaration;
        final Method method;
        int cursor;
        Parser(String signature, Class<?> declaration, Method method) { this.signature = signature; this.declaration = declaration; this.method = method; }
        boolean end() { return cursor == signature.length(); }
        char peek() { if (end()) throw invalid(); return signature.charAt(cursor); }
        void expect(char expected) { if (peek() != expected) throw invalid(); cursor++; }
        IllegalStateException invalid() { return new IllegalStateException("Invalid mounted generic signature at " + cursor); }
        void skipFormals() {
            if (end() || peek() != '<') return;
            cursor++;
            while (peek() != '>') {
                while (peek() != ':') cursor++;
                cursor++;
                if (peek() != ':') skipType();
                while (peek() == ':') { cursor++; skipType(); }
            }
            cursor++;
        }
        void skipType() {
            char kind = peek(); cursor++;
            if (kind == '[' || kind == '+' || kind == '-') { skipType(); return; }
            if (kind == 'T') { while (peek() != ';') cursor++; cursor++; return; }
            if (kind != 'L') return;
            while (true) {
                char c = peek(); cursor++;
                if (c == ';') return;
                if (c == '<') {
                    while (peek() != '>') skipType();
                    cursor++;
                }
            }
        }
        Type type() {
            char kind = peek(); cursor++;
            switch (kind) {
                case 'B': return byte.class; case 'C': return char.class; case 'D': return double.class;
                case 'F': return float.class; case 'I': return int.class; case 'J': return long.class;
                case 'S': return short.class; case 'Z': return boolean.class; case 'V': return void.class;
                case '[':
                    Type component = type();
                    return component instanceof Class<?> ? Array.newInstance((Class<?>) component, 0).getClass() : new ArrayType(component);
                case 'T':
                    int begin = cursor;
                    while (peek() != ';') cursor++;
                    String name = signature.substring(begin, cursor++);
                    if (method != null) for (TypeVariable<?> variable : method.getTypeParameters()) if (variable.getName().equals(name)) return variable;
                    for (Class<?> owner = declaration; owner != null; owner = owner.getDeclaringClass()) {
                        for (TypeVariable<?> variable : owner.getTypeParameters()) if (variable.getName().equals(name)) return variable;
                    }
                    throw new IllegalStateException("Generic variable declaration not retained: " + name);
                case 'L': return classType();
                default: throw invalid();
            }
        }
        private Type classType() {
            String binary = "";
            Type owner = null;
            while (true) {
                int begin = cursor;
                while (peek() != '<' && peek() != ';' && peek() != '.') cursor++;
                String segment = signature.substring(begin, cursor).replace('/', '.');
                binary = binary.isEmpty() ? segment : binary + "$" + segment;
                Class<?> raw;
                try { raw = Class.forName(binary, false, declaration.getClassLoader()); }
                catch (ClassNotFoundException missing) {
                    throw new UnsupportedOperationException("Generic type not retained: " + binary, missing);
                }
                List<Type> arguments = new ArrayList<>();
                if (peek() == '<') {
                    cursor++;
                    while (peek() != '>') {
                        char bound = peek();
                        if (bound == '*') { cursor++; arguments.add(new Wildcard(new Type[]{Object.class}, new Type[0])); }
                        else if (bound == '+' || bound == '-') {
                            cursor++; Type type = type();
                            arguments.add(bound == '+' ? new Wildcard(new Type[]{type}, new Type[0]) : new Wildcard(new Type[]{Object.class}, new Type[]{type}));
                        } else arguments.add(type());
                    }
                    cursor++;
                }
                Type enclosing = owner == null ? raw.getDeclaringClass() : owner;
                Type result = arguments.isEmpty() && !(enclosing instanceof ParameterizedType) ? raw
                        : new Parameterized(raw, enclosing, arguments.toArray(new Type[0]));
                char delimiter = peek(); cursor++;
                if (delimiter == ';') return result;
                if (delimiter != '.') throw invalid();
                owner = result;
            }
        }
    }

    private static final class Parameterized implements ParameterizedType {
        private final Class<?> raw;
        private final Type owner;
        private final Type[] arguments;
        Parameterized(Class<?> raw, Type owner, Type[] arguments) { this.raw = raw; this.owner = owner; this.arguments = arguments; }
        @Override public Type[] getActualTypeArguments() { return arguments.clone(); }
        @Override public Type getRawType() { return raw; }
        @Override public Type getOwnerType() { return owner; }
        @Override public boolean equals(Object value) {
            if (!(value instanceof ParameterizedType)) return false;
            ParameterizedType other = (ParameterizedType) value;
            return raw.equals(other.getRawType()) && Objects.equals(owner, other.getOwnerType()) && Arrays.equals(arguments, other.getActualTypeArguments());
        }
        @Override public int hashCode() { return Arrays.hashCode(arguments) ^ Objects.hashCode(owner) ^ raw.hashCode(); }
        @Override public String toString() {
            StringBuilder name = new StringBuilder(owner == null ? raw.getName() : owner.getTypeName() + "$" + raw.getName().substring(raw.getDeclaringClass().getName().length() + 1));
            if (arguments.length != 0) {
                name.append('<');
                for (int i = 0; i < arguments.length; i++) { if (i != 0) name.append(", "); name.append(arguments[i].getTypeName()); }
                name.append('>');
            }
            return name.toString();
        }
    }
    private static final class ArrayType implements GenericArrayType {
        private final Type component;
        ArrayType(Type component) { this.component = component; }
        @Override public Type getGenericComponentType() { return component; }
        @Override public boolean equals(Object other) { return other instanceof GenericArrayType && component.equals(((GenericArrayType) other).getGenericComponentType()); }
        @Override public int hashCode() { return component.hashCode(); }
        @Override public String toString() { return component.getTypeName() + "[]"; }
    }
    private static final class Wildcard implements WildcardType {
        private final Type[] upper;
        private final Type[] lower;
        Wildcard(Type[] upper, Type[] lower) { this.upper = upper; this.lower = lower; }
        @Override public Type[] getUpperBounds() { return upper.clone(); }
        @Override public Type[] getLowerBounds() { return lower.clone(); }
        @Override public boolean equals(Object other) {
            return other instanceof WildcardType && Arrays.equals(upper, ((WildcardType) other).getUpperBounds())
                    && Arrays.equals(lower, ((WildcardType) other).getLowerBounds());
        }
        @Override public int hashCode() { return Arrays.hashCode(upper) ^ Arrays.hashCode(lower); }
        @Override public String toString() {
            return lower.length != 0 ? "? super " + lower[0].getTypeName() : upper[0] == Object.class ? "?" : "? extends " + upper[0].getTypeName();
        }
    }
}
