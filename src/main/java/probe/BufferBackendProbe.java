package probe;

import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.util.Arrays;
import org.lwjgl.opengl.ARBVertexBufferObject;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL15;
import org.lwjgl.opengl.GL30;
import org.teavm.classlib.impl.nio.Buffers;

/** Browser-only real GPU storage and owned CPU mapping qualification. */
public final class BufferBackendProbe {
    public static void main(String[] args) {
        int id = ARBVertexBufferObject.glGenBuffersARB();
        ByteBuffer readback = ByteBuffer.allocateDirect(68);
        try {
            ARBVertexBufferObject.glBindBufferARB(GL15.GL_ARRAY_BUFFER, id);
            ARBVertexBufferObject.glBufferDataARB(GL15.GL_ARRAY_BUFFER, 64L, GL15.GL_STREAM_DRAW);
            if (id <= 0 || !ARBVertexBufferObject.glIsBufferARB(id)
                    || ARBVertexBufferObject.glGetBufferParameteriARB(GL15.GL_ARRAY_BUFFER, GL15.GL_BUFFER_SIZE) != 64)
                throw fail("Real GPU buffer allocation/query differs");
            ByteBuffer mapping = ARBVertexBufferObject.glMapBufferARB(GL15.GL_ARRAY_BUFFER, GL15.GL_WRITE_ONLY, 64L, null);
            byte[] expected = new byte[64];
            for (int i = 0; i < 64; i++) { expected[i] = (byte) (i * 37 + 11); mapping.put(i, expected[i]); }
            mapping.position(7).limit(13);
            if (!ARBVertexBufferObject.glUnmapBufferARB(GL15.GL_ARRAY_BUFFER)) throw fail("Write mapping did not upload");
            ByteBuffer reading = ARBVertexBufferObject.glMapBufferARB(GL15.GL_ARRAY_BUFFER, GL15.GL_READ_ONLY, 64L, mapping);
            if (!reading.isReadOnly()) throw fail("Read-only mapping exposes writes");
            for (int i = 0; i < 64; i++) if (reading.get(i) != expected[i]) throw fail("Actual GPU map-read bytes differ");
            if (!GL15.glUnmapBuffer(GL15.GL_ARRAY_BUFFER)) throw fail("Read mapping did not close");
            int firstHash = Arrays.hashCode(expected);

            ByteBuffer range = GL30.glMapBufferRange(GL15.GL_ARRAY_BUFFER, 8L, 8L, 0x26, null);
            for (int i = 0; i < 8; i++) { expected[8 + i] = (byte) (90 + i); range.put(i, expected[8 + i]); }
            range.position(2).limit(4);
            if (!GL15.glUnmapBuffer(GL15.GL_ARRAY_BUFFER)) throw fail("Range mapping did not upload");
            for (int i = 0; i < readback.capacity(); i++) readback.put(i, (byte) 0x5A);
            readback.position(2).limit(66);
            GL15.glGetBufferSubData(GL15.GL_ARRAY_BUFFER, 0L, readback);
            if (readback.position() != 2 || readback.limit() != 66 || readback.get(0) != 0x5A || readback.get(1) != 0x5A)
                throw fail("GPU readback changed buffer state or prefix");
            for (int i = 0; i < 64; i++) if (readback.get(i + 2) != expected[i]) throw fail("GPU range upload/readback differs");
            readback.clear();
            if (readback.get(66) != 0x5A || readback.get(67) != 0x5A) throw fail("GPU readback changed suffix");
            IntBuffer query = IntBuffer.allocate(3); query.position(1).limit(2);
            GL15.glGetBufferParameteriv(GL15.GL_ARRAY_BUFFER, GL15.GL_BUFFER_SIZE, query);
            if (query.position() != 1 || query.limit() != 2 || query.get(1) != 64) throw fail("Buffer metadata destination state differs");
            if (GL30.glMapBufferRange(GL15.GL_ARRAY_BUFFER, 60L, 8L, 2, null) != null || GL11.glGetError() != GL11.GL_INVALID_VALUE)
                throw fail("Out-of-bounds mapping did not reject");
            ByteBuffer live = GL15.glMapBuffer(GL15.GL_ARRAY_BUFFER, GL15.GL_WRITE_ONLY, 64L, null);
            if (live == null || GL15.glMapBuffer(GL15.GL_ARRAY_BUFFER, GL15.GL_WRITE_ONLY, 64L, null) != null
                    || GL11.glGetError() != GL11.GL_INVALID_OPERATION || !GL15.glUnmapBuffer(GL15.GL_ARRAY_BUFFER))
                throw fail("Exclusive mapping state differs");
            if (GL11.glGetError() != 0) throw fail("Unexpected buffer GL error");
            ARBVertexBufferObject.glDeleteBuffersARB(id);
            if (GL15.glIsBuffer(id) || GL11.glGetInteger(GL15.GL_ARRAY_BUFFER_BINDING) != 0)
                throw fail("Actual buffer deletion/binding cleanup differs");

            StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-core\",\"cases\":[{\"id\":\"arb-owned-buffer\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", 64); json.append(','); integer(json, "pixelHash", firstHash); json.append(',');
            integer(json, "checks", 4); json.append(','); integer(json, "state", 7);
            json.append("}},{\"id\":\"gpu-range-upload\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", 8); json.append(','); integer(json, "pixelHash", Arrays.hashCode(expected)); json.append(',');
            integer(json, "checks", 6); json.append(','); integer(json, "state", 7);
            System.out.println(json.append("}}],\"pass\":true}"));
        } finally {
            GL15.glDeleteBuffers(id);
            Buffers.free(readback);
        }
    }

    private static AssertionError fail(String message) { System.out.println(message); return new AssertionError(message); }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
