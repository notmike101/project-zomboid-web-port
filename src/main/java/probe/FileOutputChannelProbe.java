package probe;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.FileChannel;
import java.nio.channels.NonReadableChannelException;
import java.util.Arrays;

/** Shared stream/channel position and ownership on newly owned temporary files. */
public final class FileOutputChannelProbe {
    public static void main(String[] args) throws Exception {
        String[] ids = {"identity-and-shared-write", "shared-cursor", "truncate", "append-after-seek",
                "stream-closes-channel", "channel-closes-stream", "channel-after-close", "write-only-and-window"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int index = 0; index < ids.length; index++) {
            File file = File.createTempFile("output-channel-", ".tmp");
            int checks = 0;
            int hash;
            try {
                if (index == 3) try (var seed = new FileOutputStream(file)) { seed.write(new byte[]{1,2,3}); }
                try (FileOutputStream output = new FileOutputStream(file, index == 3)) {
                    if (index == 6) output.close();
                    FileChannel channel = output.getChannel();
                    if (channel != output.getChannel()) throw new AssertionError("Channel identity differs");
                    if (index == 0) {
                        output.write(1); channel.write(ByteBuffer.wrap(new byte[]{2,3})); output.write(4);
                        require(channel.position() == 4); checks = 1;
                    } else if (index == 1) {
                        output.write(new byte[]{1,2,3,4}); channel.position(1); output.write(9);
                        channel.write(ByteBuffer.wrap(new byte[]{8})); require(channel.position() == 3); checks = 1;
                    } else if (index == 2) {
                        output.write(new byte[]{1,2,3,4}); channel.truncate(2); output.write(7);
                        require(channel.position() == 3 && channel.size() == 3); checks = 1;
                    } else if (index == 3) {
                        channel.position(0); output.write(new byte[0]); require(channel.position() == 3);
                        require(channel.write(ByteBuffer.allocate(0)) == 0 && channel.position() == 3);
                        output.write(4); require(channel.position() == 4);
                        channel.position(1); channel.write(ByteBuffer.wrap(new byte[]{5}));
                        require(channel.position() == 5); checks = 1;
                    } else if (index == 4) {
                        output.write(6); output.close(); require(!channel.isOpen());
                        try { channel.write(ByteBuffer.wrap(new byte[]{9})); throw new AssertionError("Closed channel writable"); }
                        catch (ClosedChannelException expected) { checks = 1; }
                    } else if (index == 5) {
                        output.write(7); channel.close(); require(!channel.isOpen());
                        try { output.write(9); throw new AssertionError("Closed stream writable"); }
                        catch (IOException expected) { checks = 1; }
                    } else if (index == 6) {
                        require(!channel.isOpen());
                        try { channel.position(); throw new AssertionError("Closed stream exposed open channel"); }
                        catch (ClosedChannelException expected) { checks = 1; }
                    } else {
                        try { channel.read(ByteBuffer.allocate(1)); throw new AssertionError("Output channel readable"); }
                        catch (NonReadableChannelException expected) { checks = 1; }
                        ByteBuffer source = ByteBuffer.wrap(new byte[]{1,2,3,4}); source.position(1).limit(3);
                        require(channel.write(source) == 2 && source.position() == 3 && channel.position() == 2);
                    }
                }
                byte[] bytes;
                try (FileInputStream input = new FileInputStream(file)) { bytes = input.readAllBytes(); }
                byte[][] expected = {{1,2,3,4}, {1,9,8,4}, {1,2,7}, {1,2,3,4,5}, {6}, {7}, {}, {2,3}};
                require(Arrays.equals(bytes, expected[index]));
                hash = Arrays.hashCode(bytes);
            } catch (Exception failure) {
                System.out.println(ids[index] + ": " + failure); throw failure;
            } finally { if (!file.delete()) throw new IOException("Cannot remove owned output-channel file"); }
            if (index != 0) json.append(',');
            json.append("{\"id\":\"").append(ids[index]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "checks", checks); json.append(','); integer(json, "contentHash", hash); json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static void require(boolean condition) { if (!condition) throw new AssertionError("Output stream/channel contract differs"); }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
