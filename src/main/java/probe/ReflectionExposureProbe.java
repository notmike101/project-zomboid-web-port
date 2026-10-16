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

/** Browser-only original reflection/exposer probe; compile-only qualification must precede execution. */
public final class ReflectionExposureProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        File library = new File("./stdlib.lua");
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(library)) { bytes = input.readAllBytes(); }
        int fileHash = Arrays.hashCode(bytes);
        if (!library.isFile() || library.canWrite() || bytes.length == 0 || library.length() != bytes.length
                || fileHash != BrowserAssets.contentHash("/stdlib.lua")) throw failure("Original standard-library mount differs");

        J2SEPlatform platform = J2SEPlatform.getInstance();
        KahluaTable environment = platform.newEnvironment();
        KahluaThread thread = KahluaUtil.getWorkerThread(platform, environment);
        thread.debugOwnerThread = Thread.currentThread();
        KahluaConverterManager manager = new KahluaConverterManager();
        KahluaNumberConverter.install(manager);
        // Retain and enumerate the entire inspected class API, rather than accepting
        // an empty reflection table as successful exposure.
        if (GameVersion.class.getDeclaredMethods().length != 11 || GameVersion.class.getConstructors().length != 1)
            throw failure("Original GameVersion reflection metadata incomplete");
        LuaManager.Exposer exposer = new LuaManager.Exposer(manager, platform, environment);
        exposer.setExposed(GameVersion.class);
        exposer.exposeLikeJava(GameVersion.class, environment);
        if (!exposer.isExposed(GameVersion.class) || !(environment.rawget("GameVersion") instanceof KahluaTable))
            throw failure("Original exposer did not publish GameVersion");
        String[] sources = {
            "local v=GameVersion.new(42,21,''); "
                + "assert(v:getMajor()==42 and v:getMinor()==21 and v:getSuffix()=='' and v:toString()=='42.21'); "
                + "reflectionConstructed=v; return v:getInt()",
            "local old=GameVersion.parse('42.20'); local v=GameVersion.parse('42.21'); "
                + "assert(v:isGreaterThan(old) and v:isGreaterThanOrEqualTo(old)); "
                + "assert(old:isLessThan(v) and old:isLessThanOrEqualTo(v)); "
                + "assert(v:equals(reflectionConstructed)); reflectionParsed=v; return v:getMajor()*100+v:getMinor()"
        };
        String[] ids = {"original-reflective-constructor", "original-reflective-static-instance"};
        int[] expected = {42021,4221};
        int[] expectedHash = {4221,49558447};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-reflection-exposure\",\"cases\":[{\"id\":\"/stdlib.lua\",\"inputs\":[],\"outputs\":{");
        integer(json,"size",bytes.length); json.append(','); integer(json,"contentHash",fileHash); json.append("}}");
        for (int i=0;i<sources.length;i++) {
            Object[] results = thread.pcall(LuaCompiler.loadstring(sources[i],ids[i],environment),new Object[0]);
            if (results.length != 2 || !Boolean.TRUE.equals(results[0]) || !(results[1] instanceof Number)
                    || ((Number)results[1]).doubleValue() != expected[i])
                throw failure("Original reflective Lua call differs: " + ids[i] + ": " + Arrays.toString(results));
            Object object = environment.rawget(i == 0 ? "reflectionConstructed" : "reflectionParsed");
            if (!(object instanceof GameVersion)) throw failure("Original constructor/parse returned wrong Java type");
            GameVersion version = (GameVersion)object;
            int hash = i == 0 ? version.getMajor()*100+version.getMinor() : version.toString().hashCode();
            if (hash != expectedHash[i]) throw failure("Original reflective object state differs: " + hash);
            json.append(",{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{");
            integer(json,"measure",((Number)results[1]).intValue()); json.append(','); integer(json,"contentHash",hash); json.append("}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static AssertionError failure(String message) { System.out.println(message); return new AssertionError(message); }
    private static void integer(StringBuilder json,String name,int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits=Integer.toHexString(value);
        for(int i=bits.length();i<8;i++)json.append('0'); json.append(bits).append("\"}");
    }
}
