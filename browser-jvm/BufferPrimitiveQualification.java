import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HexFormat;

public final class BufferPrimitiveQualification {
    public static native void report(String value);
    private static boolean browser;
    public static final class ShortField { public short value; }
    private static void emit(String value) { if (browser) report(value); else System.out.println(value); }
    private static String hex(ByteBuffer buffer, int count) {
        byte[] bytes = new byte[count]; for (int i = 0; i < count; i++) bytes[i] = buffer.get(i);
        return HexFormat.of().formatHex(bytes);
    }
    public static void main(String[] args) {
        browser = args.length == 0;
        try {
            for (boolean direct : new boolean[]{false, true}) for (int index = 0; index < 9; index++) {
                ByteBuffer b = direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32);
                b.putShort(index, (short)0x1234);
                emit("{\"progress\":\"primitive\",\"kind\":\"short-index\",\"direct\":" + direct + ",\"index\":" + index
                        + ",\"read\":" + b.getShort(index) + ",\"wire\":\"" + hex(b, 12) + "\"}");
            }
            for (boolean direct : new boolean[]{false, true}) {
                ByteBuffer b = direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32);
                b.putChar(0, 'A'); b.putInt(4, 0x12345678); b.putLong(8, 0x123456789abcdef0L);
                emit("{\"progress\":\"primitive\",\"kind\":\"other\",\"direct\":" + direct + ",\"char\":" + (int)b.getChar(0)
                        + ",\"int\":" + b.getInt(4) + ",\"long\":\"" + Long.toHexString(b.getLong(8))
                        + "\",\"wire\":\"" + hex(b, 16) + "\"}");
            }
            for (boolean direct : new boolean[]{false, true}) for (int position : new int[]{0, 3}) for (int mode = 0; mode < 3; mode++) {
                ByteBuffer buffer = direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32);
                if (mode == 2) buffer.order(ByteOrder.BIG_ENDIAN);
                buffer.position(position);
                if (mode == 1) buffer.putShort((short)Integer.parseInt("7")); else buffer.putShort((short)7);
                emit("{\"progress\":\"primitive\",\"kind\":\"default\",\"direct\":" + direct
                        + ",\"position\":" + position + ",\"mode\":" + mode + ",\"read\":" + buffer.getShort(position)
                        + ",\"order\":\"" + buffer.order() + "\",\"wire\":\"" + hex(buffer, 9) + "\"}");
            }
            for (int value : new int[]{7, -1, 0x1234, 32767}) {
                short small = (short)value;
                emit("{\"progress\":\"primitive\",\"kind\":\"reverse\",\"input\":" + value
                        + ",\"short\":" + small + ",\"reverse\":" + Short.reverseBytes(small) + "}");
                for (boolean direct : new boolean[]{false, true}) for (ByteOrder order : new ByteOrder[]{ByteOrder.BIG_ENDIAN, ByteOrder.LITTLE_ENDIAN}) {
                    for (boolean absolute : new boolean[]{false, true}) {
                        ByteBuffer buffer = (direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32)).order(order);
                        buffer.position(3);
                        if (absolute) buffer.putShort(5, small); else buffer.putShort(small);
                        int index = absolute ? 5 : 3;
                        emit("{\"progress\":\"primitive\",\"kind\":\"short\",\"input\":" + value + ",\"direct\":" + direct
                                + ",\"order\":\"" + order + "\",\"absolute\":" + absolute + ",\"position\":" + buffer.position()
                                + ",\"read\":" + buffer.getShort(index) + ",\"wire\":\"" + hex(buffer, 9) + "\"}");
                    }
                    ByteBuffer control = (direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32)).order(order);
                    control.put(new byte[]{0x12, 0x34});
                    emit("{\"progress\":\"primitive\",\"kind\":\"byte-array\",\"direct\":" + direct + ",\"order\":\"" + order
                            + "\",\"read\":" + control.getShort(0) + ",\"wire\":\"" + hex(control, 2) + "\"}");
                }
            }
            for (boolean direct : new boolean[]{false, true}) for (ByteOrder order : new ByteOrder[]{ByteOrder.BIG_ENDIAN, ByteOrder.LITTLE_ENDIAN}) {
                for (int value : new int[]{-1, 0x1234, 32767}) for (int view = 0; view < 4; view++) {
                    ByteBuffer base = (direct ? ByteBuffer.allocateDirect(32) : ByteBuffer.allocate(32)).order(order);
                    ByteBuffer target = base;
                    if (view == 1) { base.position(4); target = base.slice().order(order); }
                    if (view == 2) target = base.duplicate().order(order);
                    if (view == 3 && !direct) target = ByteBuffer.wrap(base.array(), 4, 24).slice().order(order);
                    target.putShort(2, (short)value); target.putChar(6, (char)value);
                    emit("{\"progress\":\"primitive\",\"kind\":\"views\",\"direct\":" + direct + ",\"order\":\"" + order
                        + "\",\"view\":" + view + ",\"value\":" + value + ",\"short\":" + target.getShort(2) + ",\"char\":" + (int)target.getChar(6)
                        + ",\"wire\":\"" + hex(base, 16) + "\"}");
                }
                ByteBuffer small = (direct ? ByteBuffer.allocateDirect(4) : ByteBuffer.allocate(4)).order(order);
                small.position(3); String overflow = "none", bounds = "none", readonly = "none";
                try { small.putShort((short)1); } catch (Throwable e) { overflow = e.getClass().getName(); }
                try { small.putChar(3, 'A'); } catch (Throwable e) { bounds = e.getClass().getName(); }
                try { small.asReadOnlyBuffer().putShort(0, (short)1); } catch (Throwable e) { readonly = e.getClass().getName(); }
                emit("{\"progress\":\"primitive\",\"kind\":\"exceptions\",\"direct\":" + direct + ",\"order\":\"" + order
                    + "\",\"position\":" + small.position() + ",\"overflow\":\"" + overflow + "\",\"bounds\":\"" + bounds + "\",\"readonly\":\"" + readonly
                    + "\",\"wire\":\"" + hex(small, 4) + "\"}");
                short[] shorts = new short[4];
                Class<?> unsafeClass = Class.forName("sun.misc.Unsafe");
                var singleton = unsafeClass.getDeclaredField("theUnsafe"); singleton.setAccessible(true);
                Object unsafe = singleton.get(null);
                var putShort = unsafeClass.getMethod("putShort", Object.class, long.class, short.class);
                int base = (Integer)unsafeClass.getMethod("arrayBaseOffset", Class.class).invoke(unsafe, short[].class);
                putShort.invoke(unsafe, shorts, (long)base + 2, (short)0x1234);
                ShortField field = new ShortField();
                long fieldOffset = (Long)unsafeClass.getMethod("objectFieldOffset", java.lang.reflect.Field.class)
                        .invoke(unsafe, ShortField.class.getField("value"));
                putShort.invoke(unsafe, field, fieldOffset, (short)-1234);
                emit("{\"progress\":\"primitive\",\"kind\":\"short-array\",\"value\":" + shorts[1] + ",\"field\":" + field.value + "}");
            }
            emit("{\"pass\":true}");
        } catch(Throwable error) { error.printStackTrace(); emit("{\"pass\":false,\"error\":\"" + error.getClass().getName() + "\"}"); }
    }
}

