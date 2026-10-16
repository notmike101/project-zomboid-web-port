package probe;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedByInterruptException;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.FileLockInterruptionException;
import java.nio.channels.NonReadableChannelException;
import java.nio.channels.NonWritableChannelException;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.StandardOpenOption;

/** Owns temporary files only; exercises actual channel IO and lock lifecycles. */
public final class ChannelProbe {
    private static String currentCase;
    public static void main(String[] args) throws Exception {
        String[] ids = {"write-read", "buffer-window", "eof", "truncate", "read-only", "append",
                "invalid-options", "create-new", "shared-overlap", "separate-ranges", "close-locks",
                "lock-range", "interrupt-read", "interrupt-lock", "delete-on-close", "canonical-alias"};
        int[] expectedA = {4,2,-1,2,2,3,2,1,1,2,2,3,2,2,1,1};
        int[] expectedB = {1234,23,0,2,1,123,1,1,1,1,1,1,1,1,1,1};
        File marker = File.createTempFile("channel-probe-", ".dir");
        if (!marker.delete() || !marker.mkdir()) throw new AssertionError("Cannot create isolated directory");
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        try {
            for (int i = 0; i < ids.length; i++) {
                currentCase = ids[i];
                File file = new File(marker, "case-" + i);
                int a = 0, b = 0;
                try (FileChannel channel = FileChannel.open(file.toPath(), StandardOpenOption.CREATE_NEW,
                        StandardOpenOption.READ, StandardOpenOption.WRITE)) {
                    switch (i) {
                        case 0:
                            a = channel.write(ByteBuffer.wrap(new byte[]{1,2,3,4})); channel.position(0);
                            ByteBuffer dst = ByteBuffer.allocateDirect(4); check(channel.read(dst) == 4);
                            b = decimal(dst); break;
                        case 1:
                            ByteBuffer src = ByteBuffer.wrap(new byte[]{1,2,3,4}); src.position(1); src.limit(3);
                            a = channel.write(src); check(src.position() == 3 && src.limit() == 3);
                            channel.position(0); ByteBuffer window = ByteBuffer.allocate(4); window.position(1); window.limit(3);
                            check(channel.read(window) == 2 && window.position() == 3 && window.limit() == 3);
                            b = window.get(1)*10 + window.get(2); break;
                        case 2:
                            a = channel.read(ByteBuffer.allocate(1)); b = channel.read(ByteBuffer.allocate(0)); break;
                        case 3:
                            channel.write(ByteBuffer.wrap(new byte[]{1,2,3,4})); channel.truncate(2);
                            a = (int) channel.size(); b = (int) channel.position();
                            channel.truncate(20); check(channel.size() == 2); break;
                        case 4:
                            try (FileChannel read = FileChannel.open(file.toPath())) {
                                try { read.write(ByteBuffer.allocate(1)); } catch (NonWritableChannelException expected) { a++; }
                                try { read.tryLock(0,1,false); } catch (NonWritableChannelException expected) { a++; }
                                try (FileLock shared = read.tryLock(0,1,true)) { b = shared.isValid() ? 1 : 0; }
                            } break;
                        case 5:
                            channel.write(ByteBuffer.wrap(new byte[]{1,2}));
                            try (FileChannel append = FileChannel.open(file.toPath(), StandardOpenOption.APPEND)) {
                                append.position(0); check(append.position() == 2);
                                append.write(ByteBuffer.wrap(new byte[]{3})); a = (int) append.size();
                                try { append.read(ByteBuffer.allocate(1)); throw new AssertionError(); }
                                catch (NonReadableChannelException expected) { }
                            }
                            channel.position(0); ByteBuffer all = ByteBuffer.allocate(3); channel.read(all); b = decimal(all); break;
                        case 6:
                            try (FileChannel ignored = FileChannel.open(file.toPath(), StandardOpenOption.READ, StandardOpenOption.APPEND)) { throw new AssertionError(); }
                            catch (IllegalArgumentException expected) { a++; }
                            try (FileChannel ignored = FileChannel.open(file.toPath(), StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.APPEND)) { throw new AssertionError(); }
                            catch (IllegalArgumentException expected) { a++; }
                            b = channel.isOpen() ? 1 : 0; break;
                        case 7:
                            try (FileChannel ignored = FileChannel.open(file.toPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) { throw new AssertionError(); }
                            catch (FileAlreadyExistsException expected) { a = 1; } b = file.exists()?1:0; break;
                        case 8:
                            try (FileLock shared = channel.tryLock(0,10,true); FileChannel other = FileChannel.open(file.toPath())) {
                                check(shared.channel() == channel && shared.acquiredBy() == channel);
                                check(shared.overlaps(0,0) && !shared.overlaps(0,-1));
                                check(!shared.overlaps(Long.MAX_VALUE-1,10));
                                try { other.tryLock(1,1,true); } catch (OverlappingFileLockException expected) { a = 1; }
                                b = shared.overlaps(9,2) && !shared.overlaps(10,1) ? 1 : 0;
                            } break;
                        case 9:
                            try (FileLock first = channel.tryLock(0,2,false); FileLock second = channel.tryLock(2,2,false)) {
                                a = (first.isValid()?1:0)+(second.isValid()?1:0);
                                b = first.position()==0 && first.size()==2 && !first.isShared() ? 1 : 0;
                            } break;
                        case 10:
                            FileLock lock = channel.tryLock(); channel.close(); channel.close();
                            if (!lock.isValid()) a++;
                            try { lock.release(); } catch (ClosedChannelException expected) { a++; }
                            try (FileChannel other = FileChannel.open(file.toPath(), StandardOpenOption.WRITE); FileLock fresh = other.tryLock()) { b = fresh.isValid()?1:0; }
                            break;
                        case 11:
                            try { channel.tryLock(-1,1,false); } catch (IllegalArgumentException expected) { a++; }
                            try { channel.tryLock(0,-1,false); } catch (IllegalArgumentException expected) { a++; }
                            try { channel.tryLock(Long.MAX_VALUE,1,false); } catch (IllegalArgumentException expected) { a++; }
                            try (FileLock zero = channel.tryLock(2,0,false)) { b = zero.position()==2 && zero.size()==Long.MAX_VALUE-2?1:0; }
                            break;
                        case 12:
                            Thread.currentThread().interrupt();
                            try { channel.read(ByteBuffer.allocate(1)); } catch (ClosedByInterruptException expected) { a++; }
                            if (!channel.isOpen()) a++; b = Thread.interrupted()?1:0; break;
                        case 13:
                            Thread.currentThread().interrupt();
                            try { channel.lock(); } catch (FileLockInterruptionException expected) { a++; }
                            if (!channel.isOpen()) a++; b = Thread.interrupted()?1:0; break;
                        case 14:
                            File deleting = new File(marker,"delete-me");
                            try (FileChannel owned = FileChannel.open(deleting.toPath(), StandardOpenOption.CREATE_NEW,
                                    StandardOpenOption.WRITE, StandardOpenOption.DELETE_ON_CLOSE)) { a = owned.isOpen()?1:0; }
                            b = !deleting.exists()?1:0; break;
                        case 15:
                            try (FileLock original = channel.tryLock(); FileChannel alias = FileChannel.open(
                                    new File(marker,"./case-15").toPath(), StandardOpenOption.WRITE)) {
                                try { alias.tryLock(); } catch (OverlappingFileLockException expected) { a = 1; }
                                b = original.isValid()?1:0;
                            } break;
                        default: throw new AssertionError();
                    }
                } finally { Thread.interrupted(); if (file.exists() && !file.delete()) throw new AssertionError("Temporary file cleanup"); }
                if (a != expectedA[i] || b != expectedB[i]) throw new AssertionError(ids[i] + ": " + a + "," + b);
                if (i > 0) json.append(',');
                json.append("{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
                append(json,a); json.append(",\"contentHash\":"); append(json,b); json.append("}}");
            }
        } finally {
            File[] leftovers = marker.listFiles();
            if (leftovers != null) for (File file : leftovers) file.delete();
            if (!marker.delete()) throw new AssertionError("Temporary directory cleanup");
        }
        System.out.println(json.append("]}"));
    }
    private static int decimal(ByteBuffer bytes) { int value=0; for (int i=0;i<bytes.position();i++) value=value*10+bytes.get(i); return value; }
    private static void check(boolean condition) {
        if (!condition) {
            System.out.println("Channel contract failed: " + currentCase);
            throw new AssertionError("Channel contract: " + currentCase);
        }
    }
    private static void append(StringBuilder json,int value) {
        String bits=Integer.toHexString(value); json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for(int i=bits.length();i<8;i++)json.append('0'); json.append(bits).append("\"}");
    }
}
