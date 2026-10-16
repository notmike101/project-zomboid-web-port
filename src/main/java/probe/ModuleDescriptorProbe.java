package probe;

import java.lang.reflect.Modifier;

/** Class-token compatibility only; does not call or claim Java module-system operations. */
public final class ModuleDescriptorProbe {
    public static void main(String[] args) {
        Class<?> type = Module.class;
        int checks = (type == Module.class ? 1 : 0)
                | (Module[].class.getComponentType() == type ? 2 : 0)
                | (type.getSuperclass() == Object.class ? 4 : 0)
                | (Modifier.isFinal(type.getModifiers()) ? 8 : 0)
                | (!type.isArray() && !type.isPrimitive() && !type.isInterface() ? 16 : 0);
        if (checks != 31 || !type.getName().equals("java.lang.Module")) throw new AssertionError("Module class token differs");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[{\"id\":\"module-class-token\",\"inputs\":[],\"outputs\":{");
        integer(json, "checks", checks); json.append(',');
        integer(json, "nameHash", type.getName().hashCode());
        System.out.println(json.append("}}]}"));
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
