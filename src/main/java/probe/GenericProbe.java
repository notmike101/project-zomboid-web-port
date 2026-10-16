package probe;

import java.io.IOException;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.List;

/** Genuine Signature attributes, parameterized parents, and generic thrown declarations. */
public final class GenericProbe {
    public static class Base<T> { }
    public static class Concrete extends Base<List<? extends Number>> { }
    public static class Variable<T> extends Base<List<? super T[]>> { }
    public static class Plain { }
    public static class Throws {
        public <E extends Exception> void generic() throws E, IOException { }
        public void concrete() throws IOException { }
        public <T> T noThrows(T value) { return value; }
    }

    public static void main(String[] args) throws Exception {
        String[] names = {"parameterized-parent", "wildcard-upper", "variable-array", "wildcard-lower",
                "generic-throws", "concrete-throws", "verified-no-throws", "plain-parent"};
        String[] expected = {"probe.GenericProbe$Base<java.util.List<? extends java.lang.Number>>", "java.lang.Number",
                "T[]", "? super T[]", "E,java.io.IOException", "java.io.IOException", "", "java.lang.Object"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            String result;
            if (i <= 1) {
                Type parent = Concrete.class.getGenericSuperclass();
                if (!(parent instanceof ParameterizedType)) throw new AssertionError("Erased parent returned");
                ParameterizedType outer = (ParameterizedType) parent;
                if (outer.getRawType() != Base.class || outer.getOwnerType() != GenericProbe.class) throw new AssertionError("Parent owner/raw differs");
                ParameterizedType list = (ParameterizedType) outer.getActualTypeArguments()[0];
                WildcardType wildcard = (WildcardType) list.getActualTypeArguments()[0];
                if (list.getRawType() != List.class || wildcard.getLowerBounds().length != 0 || wildcard.getUpperBounds()[0] != Number.class) throw new AssertionError("Upper wildcard differs");
                Type[] copy = outer.getActualTypeArguments(); copy[0] = String.class;
                if (outer.getActualTypeArguments()[0] == String.class || !parent.equals(Concrete.class.getGenericSuperclass())) throw new AssertionError("Generic types are not defensive/equal");
                result = i == 0 ? parent.getTypeName() : wildcard.getUpperBounds()[0].getTypeName();
            } else if (i <= 3) {
                ParameterizedType parent = (ParameterizedType) Variable.class.getGenericSuperclass();
                ParameterizedType list = (ParameterizedType) parent.getActualTypeArguments()[0];
                WildcardType wildcard = (WildcardType) list.getActualTypeArguments()[0];
                GenericArrayType array = (GenericArrayType) wildcard.getLowerBounds()[0];
                TypeVariable<?> variable = (TypeVariable<?>) array.getGenericComponentType();
                if (!variable.getName().equals("T") || variable.getGenericDeclaration() != Variable.class
                        || !variable.equals(Variable.class.getTypeParameters()[0])) throw new AssertionError("Variable declaration lost");
                result = i == 2 ? array.getTypeName() : wildcard.getTypeName();
            } else if (i <= 6) {
                Method method = i == 4 ? Throws.class.getDeclaredMethod("generic") : i == 5 ? Throws.class.getDeclaredMethod("concrete")
                        : Throws.class.getDeclaredMethod("noThrows", Object.class);
                Type[] exceptions = method.getGenericExceptionTypes();
                if (i == 4 && (!(exceptions[0] instanceof TypeVariable<?>) || !((TypeVariable<?>) exceptions[0]).getGenericDeclaration().equals(method)
                        || exceptions[1] != IOException.class)) throw new AssertionError("Generic throws erased");
                StringBuilder values = new StringBuilder();
                for (Type exception : exceptions) { if (values.length() != 0) values.append(','); values.append(exception.getTypeName()); }
                result = values.toString();
                if (exceptions.length != 0) { exceptions[0] = String.class; if (method.getGenericExceptionTypes()[0] == String.class) throw new AssertionError("Exception array not defensive"); }
            } else {
                if (Object.class.getGenericSuperclass() != null || int.class.getGenericSuperclass() != null || List.class.getGenericSuperclass() != null) throw new AssertionError("Root/interface parent differs");
                result = Plain.class.getGenericSuperclass().getTypeName();
            }
            if (!result.equals(expected[i])) throw new AssertionError(names[i] + ":" + result);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"length\":");
            append(json, result.length()); json.append(",\"hash\":"); append(json, result.hashCode()); json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
