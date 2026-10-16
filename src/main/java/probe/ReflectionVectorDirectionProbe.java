package probe;

import java.io.File;
import java.io.FileInputStream;
import java.util.Arrays;
import port.runtime.BrowserAssets;
import se.krka.kahlua.converter.KahluaConverterManager;
import se.krka.kahlua.j2se.J2SEPlatform;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaThread;
import se.krka.kahlua.vm.KahluaUtil;
import zombie.Lua.KahluaNumberConverter;
import zombie.Lua.LuaManager;
import zombie.core.GameVersion;
import zombie.iso.IsoDirections;
import zombie.iso.Vector2;

/** Browser-only bounded original Lua exposure, never a full LuaManager initialization claim. */
public final class ReflectionVectorDirectionProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        File library = new File("./stdlib.lua");
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(library)) { bytes = input.readAllBytes(); }
        int fileHash = Arrays.hashCode(bytes);
        if (!library.isFile() || library.canWrite() || bytes.length == 0 || library.length() != bytes.length
                || fileHash != BrowserAssets.contentHash("/stdlib.lua")) throw failure("Original stdlib mount differs");

        metadata(GameVersion.class, 11, 1, 1, 4);
        metadata(Vector2.class, 38, 3, 3, 2);
        metadata(IsoDirections.class, 28, 0, 1, 15);
        J2SEPlatform platform = J2SEPlatform.getInstance();
        KahluaTable environment = platform.newEnvironment();
        KahluaThread thread = KahluaUtil.getWorkerThread(platform, environment);
        thread.debugOwnerThread = Thread.currentThread();
        KahluaConverterManager manager = new KahluaConverterManager();
        KahluaNumberConverter.install(manager);
        LuaManager.Exposer exposer = new LuaManager.Exposer(manager, platform, environment);
        Class<?>[] classes = {GameVersion.class, Vector2.class, IsoDirections.class};
        // Register the complete explicit domain before exposing its connected types.
        for (Class<?> type : classes) exposer.setExposed(type);
        for (Class<?> type : classes) {
            exposer.exposeLikeJava(type, environment);
            if (!exposer.isExposed(type) || !(environment.rawget(type.getSimpleName()) instanceof KahluaTable))
                throw failure("Original exposer did not publish " + type.getName());
        }
        String[] ids = {"original-version-constructor", "original-vector-normalize-scale",
                "original-vector-direction-enum", "original-vector-copy-zero"};
        String[] sources = {
            "local v=GameVersion.new(42,21,''); assert(v:toString()=='42.21'); batchVersion=v; return v:getInt()",
            "local v=Vector2.new(0,4); assert(v:getLength()==4 and v:getLengthSquared()==16); "
                + "local old=v:normalize(); assert(old==4 and v:getX()==0 and v:getY()==1); "
                + "v:scale(3); assert(v:getX()==0 and v:getY()==3 and v:getLength()==3); "
                + "batchVector=v; return old*100+v:getLengthSquared()",
            "local axis=Vector2.new(1,0); local d=IsoDirections.fromAngle(axis); "
                + "assert(d==IsoDirections.E and d:equals(IsoDirections.valueOf('E'))); "
                + "assert(d:Rot180()==IsoDirections.W and d:isCardinal() and not d:isDiagonal()); "
                + "local v=d:ToVector(); assert(v:getX()==1 and v:getY()==0); "
                + "batchDirection=d; batchDirectionVector=v; return d:ordinal()*100+d:dx()*10+d:dy()",
            "local copy=Vector2.new(batchVector); assert(copy:getX()==0 and copy:getY()==3); "
                + "local zero=Vector2.new(); assert(zero:normalize()==0 and zero:getLengthSquared()==0); "
                + "batchCopy=copy; batchZero=zero; return copy:getLengthSquared()"
        };
        int[] expected = {42021, 409, 610, 9};
        int[] expectedHash = {4221, 0x40400000, 31, 3};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-reflection-exposure\",\"cases\":[{\"id\":\"/stdlib.lua\",\"inputs\":[],\"outputs\":{");
        integer(json, "size", bytes.length); json.append(','); integer(json, "contentHash", fileHash); json.append("}}");
        for (int i = 0; i < sources.length; i++) {
            Object[] results = thread.pcall(LuaCompiler.loadstring(sources[i], ids[i], environment), new Object[0]);
            if (results.length != 2 || !Boolean.TRUE.equals(results[0]) || !(results[1] instanceof Number)
                    || ((Number) results[1]).doubleValue() != expected[i])
                throw failure("Original Lua object operation differs: " + ids[i] + ": " + Arrays.toString(results));
            int hash;
            if (i == 0) {
                if (!(environment.rawget("batchVersion") instanceof GameVersion version)) throw failure("Wrong original version type");
                hash = version.getMajor() * 100 + version.getMinor();
            } else if (i == 1) {
                if (!(environment.rawget("batchVector") instanceof Vector2 vector)) throw failure("Wrong original vector type");
                if (Float.floatToRawIntBits(vector.x) != 0 || Float.floatToRawIntBits(vector.y) != 0x40400000)
                    throw failure("Original normalized/scaled vector bits differ");
                hash = Float.floatToRawIntBits(vector.x) ^ Float.floatToRawIntBits(vector.y);
            } else if (i == 2) {
                if (environment.rawget("batchDirection") != IsoDirections.E
                        || !(environment.rawget("batchDirectionVector") instanceof Vector2 vector)
                        || Float.floatToRawIntBits(vector.x) != 0x3f800000 || Float.floatToRawIntBits(vector.y) != 0)
                    throw failure("Original direction identity or vector bits differ");
                hash = IsoDirections.E.dx() * 31 + IsoDirections.E.dy();
            } else {
                if (!(environment.rawget("batchCopy") instanceof Vector2 copy)
                        || !(environment.rawget("batchZero") instanceof Vector2 zero)
                        || copy == environment.rawget("batchVector")
                        || Float.floatToRawIntBits(copy.x) != 0 || Float.floatToRawIntBits(copy.y) != 0x40400000
                        || Float.floatToRawIntBits(zero.x) != 0 || Float.floatToRawIntBits(zero.y) != 0)
                    throw failure("Original copy identity or zero vector bits differ");
                hash = copy.floorX() * 31 + copy.floorY();
            }
            if (hash != expectedHash[i]) throw failure("Original Java object state differs: " + hash);
            json.append(",{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "measure", ((Number) results[1]).intValue()); json.append(','); integer(json, "contentHash", hash); json.append("}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static void metadata(Class<?> type, int methods, int publicConstructors, int declaredConstructors, int fields) {
        if (type.getDeclaredMethods().length != methods || type.getConstructors().length != publicConstructors
                || type.getDeclaredConstructors().length != declaredConstructors || type.getDeclaredFields().length != fields)
            throw failure("Original declared metadata incomplete: " + type.getName());
    }
    private static AssertionError failure(String message) { System.out.println(message); return new AssertionError(message); }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
