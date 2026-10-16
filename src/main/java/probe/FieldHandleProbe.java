package probe;

import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;

/** Standard-library field access contracts. This probe loads no original game classes. */
public final class FieldHandleProbe {
    public static final class Holder {
        private volatile Object value;
        public Holder(Object value) { this.value = value; }
        public static VarHandle findHandle() throws ReflectiveOperationException {
            return findHandle("value", Object.class);
        }
        public static VarHandle findHandle(String name, Class<?> type) throws ReflectiveOperationException {
            return MethodHandles.lookup().findVarHandle(Holder.class, name, type);
        }
    }

    public static void main(String[] args) throws ReflectiveOperationException {
        String[] names = {"initial-read", "exchange-success", "failed-identity-witness", "null-exchange",
                "field-type-mismatch", "missing-field", "null-receiver", "foreign-private-access"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            Object first = new String("equal");
            Object second = new Object();
            Holder holder = new Holder(first);
            VarHandle handle = Holder.findHandle();
            int checks = 0;
            int witnessCode = -1;
            switch (i) {
                case 0: {
                    Object witness = handle.getVolatile(holder);
                    checks += require(witness == first);
                    witnessCode = identity(witness, first, second);
                    break;
                }
                case 1: {
                    Object witness = handle.compareAndExchange(holder, first, second);
                    checks += require(witness == first);
                    checks += require((Object) handle.getVolatile(holder) == second);
                    witnessCode = identity(witness, first, second);
                    break;
                }
                case 2: {
                    Object equalButDistinct = new String("equal");
                    checks += require(first.equals(equalButDistinct) && first != equalButDistinct);
                    Object witness = handle.compareAndExchange(holder, equalButDistinct, second);
                    checks += require(witness == first);
                    checks += require((Object) handle.getVolatile(holder) == first);
                    witnessCode = identity(witness, first, second);
                    break;
                }
                case 3: {
                    holder = new Holder(null);
                    Object witness = handle.compareAndExchange(holder, (Object) null, first);
                    checks += require(witness == null);
                    checks += require((Object) handle.getVolatile(holder) == first);
                    witness = handle.compareAndExchange(holder, first, (Object) null);
                    checks += require(witness == first);
                    checks += require((Object) handle.getVolatile(holder) == null);
                    witnessCode = identity(witness, first, second);
                    break;
                }
                case 4:
                    try {
                        Holder.findHandle("value", String.class);
                        throw new AssertionError("Incorrect field type accepted");
                    } catch (NoSuchFieldException expected) { checks++; }
                    break;
                case 5:
                    try {
                        Holder.findHandle("missing", Object.class);
                        throw new AssertionError("Missing field accepted");
                    } catch (NoSuchFieldException expected) { checks++; }
                    break;
                case 6:
                    try {
                        Object ignored = handle.getVolatile((Holder) null);
                        throw new AssertionError("Null read receiver accepted: " + ignored);
                    } catch (NullPointerException expected) { checks++; }
                    try {
                        Object ignored = handle.compareAndExchange((Holder) null, first, second);
                        throw new AssertionError("Null exchange receiver accepted: " + ignored);
                    } catch (NullPointerException expected) { checks++; }
                    break;
                default:
                    try {
                        MethodHandles.lookup().findVarHandle(ForeignFieldHolder.class, "value", Object.class);
                        throw new AssertionError("Foreign private field accepted");
                    } catch (IllegalAccessException expected) { checks++; }
            }
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"checks\":");
            append(json, checks);
            json.append(",\"witnessIdentity\":");
            append(json, witnessCode);
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static int require(boolean condition) {
        if (!condition) throw new AssertionError("Field-handle contract differs");
        return 1;
    }

    private static int identity(Object value, Object first, Object second) {
        if (value == null) return 0;
        if (value == first) return 1;
        if (value == second) return 2;
        throw new AssertionError("Unknown witness identity");
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}

final class ForeignFieldHolder {
    private volatile Object value;
}
