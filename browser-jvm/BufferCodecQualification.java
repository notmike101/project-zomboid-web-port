import java.nio.ByteBuffer;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import se.krka.kahlua.j2se.KahluaTableImpl;
import zombie.core.network.ByteBufferReader;
import zombie.core.network.ByteBufferWriter;

/** Bounded synthetic original-code wire comparison; no Lua, game or server startup. */
public final class BufferCodecQualification {
    public static native void report(String json);
    private static boolean browser;
    private static void emit(String value) { if (browser) report(value); else System.out.println(value); }
    private static String quote(String value) {
        if (value == null) return "null";
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
                .replace("\r", "\\r").replace("\t", "\\t").replace("\u0000", "\\u0000") + "\"";
    }
    public static void main(String[] args) {
        browser = args.length == 0;
        try {
            for (boolean direct : new boolean[]{false, true}) {
                ByteBuffer buffer = direct ? ByteBuffer.allocateDirect(4096) : ByteBuffer.allocate(4096);
                var writer = new ByteBufferWriter(buffer);
                var reader = new ByteBufferReader(buffer);
                buffer.putShort((short)7);
                emit("{\"progress\":\"codec\",\"kind\":\"short\",\"direct\":" + direct + ",\"value\":" + buffer.getShort(0)
                        + ",\"wire\":" + quote(HexFormat.of().formatHex(new byte[]{buffer.get(0), buffer.get(1)})) + "}");
                var encoder = java.nio.charset.StandardCharsets.UTF_8.newEncoder();
                var chars = java.nio.CharBuffer.wrap("farming".toCharArray());
                var output = ByteBuffer.allocate(128);
                var coding = encoder.encode(chars, output, true);
                emit("{\"progress\":\"codec\",\"kind\":\"encoder\",\"position\":" + output.position()
                        + ",\"chars\":" + chars.position() + ",\"result\":" + quote(coding.toString()) + "}");
                for (String text : new String[]{null, "", "farming", "_objects", "hoursElapsed", "caf\u00e9\u03a9", "astral\uD83D\uDE03", "embedded\u0000nul"}) {
                    buffer.clear(); writer.putUTF(text); int end = buffer.position();
                    byte[] bytes = new byte[end]; buffer.duplicate().flip().get(bytes);
                    buffer.flip(); String decoded = reader.getUTF();
                    emit("{\"progress\":\"codec\",\"direct\":" + direct + ",\"kind\":\"utf\",\"text\":" + quote(text)
                            + ",\"wire\":" + quote(HexFormat.of().formatHex(bytes)) + ",\"written\":" + end
                            + ",\"read\":" + buffer.position() + ",\"decoded\":" + quote(decoded) + "}");
                    if (!(text == null ? "" : text).equals(decoded) || buffer.position() != end) throw new AssertionError("Original UTF roundtrip differs");
                }
                var table = new KahluaTableImpl(new LinkedHashMap<>());
                table.rawset("hoursElapsed", 0.0);
                table.rawset("_objects", new KahluaTableImpl(new LinkedHashMap<>()));
                buffer.clear(); zombie.network.TableNetworkUtils.save(table, writer); int end = buffer.position();
                byte[] bytes = new byte[end]; buffer.duplicate().flip().get(bytes);
                emit("{\"progress\":\"codec\",\"direct\":" + direct + ",\"kind\":\"table\",\"wire\":"
                        + quote(HexFormat.of().formatHex(bytes)) + ",\"written\":" + end + "}");
                buffer.flip(); var copy = new KahluaTableImpl(new LinkedHashMap<>());
                zombie.network.TableNetworkUtils.load(copy, reader);
                if (!Double.valueOf(0).equals(copy.rawget("hoursElapsed")) || buffer.position() != end)
                    throw new AssertionError("Original table roundtrip differs");
            }
            for (boolean direct : new boolean[]{false, true}) for (boolean sliced : new boolean[]{false, true}) {
                ByteBuffer base = direct ? ByteBuffer.allocateDirect(128) : ByteBuffer.allocate(128);
                base.position(4); ByteBuffer target = sliced ? base.slice() : base;
                int start = target.position(); var writer = new ByteBufferWriter(target);
                writer.putUTF("offset\u03a9"); int end = target.position();
                byte[] bytes = new byte[end-start]; var view = target.duplicate(); view.position(start).limit(end); view.get(bytes);
                target.position(start); String decoded = new ByteBufferReader(target).getUTF();
                if (!"offset\u03a9".equals(decoded) || target.position()!=end) throw new AssertionError("Original offset UTF differs");
                emit("{\"progress\":\"codec\",\"kind\":\"offset\",\"direct\":" + direct + ",\"slice\":" + sliced
                    + ",\"start\":" + start + ",\"end\":" + end + ",\"wire\":" + quote(HexFormat.of().formatHex(bytes)) + "}");
            }
            emit("{\"pass\":true}");
        } catch (Throwable error) { error.printStackTrace(); emit("{\"pass\":false,\"error\":" + quote(error.toString()) + "}"); }
    }
}

