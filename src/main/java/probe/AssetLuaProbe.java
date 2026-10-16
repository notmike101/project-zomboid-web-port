package probe;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import port.runtime.BrowserAssets;
import se.krka.kahlua.j2se.J2SEPlatform;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import se.krka.kahlua.stdlib.BaseLib;
import se.krka.kahlua.stdlib.TableLib;
import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaThread;
import se.krka.kahlua.vm.KahluaUtil;
import se.krka.kahlua.vm.LuaClosure;

/** Reads and executes the two unchanged allowlisted installed Lua assets, in the browser only. */
public final class AssetLuaProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        String[] paths = {"/media/lua/shared/ISBaseObject.lua", "/media/lua/shared/Util/LuaTableUtil.lua"};
        J2SEPlatform platform = J2SEPlatform.getInstance();
        KahluaTable environment = platform.newTable();
        environment.rawset("_G", environment);
        BaseLib.register(environment);
        TableLib.register(platform, environment);
        // The installed stdlib.lua binds this same original TableLib iterator globally.
        environment.rawset("pairs", ((KahluaTable) environment.rawget("table")).rawget("pairs"));
        KahluaThread thread = new KahluaThread(System.out, platform, environment);
        thread.debugOwnerThread = Thread.currentThread();
        KahluaUtil.setWorkerThread(environment, thread);
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-lua-runtime\",\"cases\":[");
        for (int index = 0; index < paths.length; index++) {
            File file = new File(paths[index]);
            byte[] bytes;
            try (FileInputStream stream = new FileInputStream(file)) { bytes = stream.readAllBytes(); }
            if (!file.isFile() || !file.canRead() || file.canWrite() || file.length() != bytes.length || bytes.length == 0
                    || Arrays.hashCode(bytes) != BrowserAssets.contentHash(paths[index])) throw new AssertionError("Mounted asset read differs");
            String[] listing = file.getParentFile().list();
            if (listing == null || !Arrays.asList(listing).contains(file.getName())) throw new AssertionError("Mounted file absent from directory");
            if (file.delete() || file.setLastModified(0) || file.setWritable(true)) throw new AssertionError("Asset mutation accepted");
            try {
                new FileOutputStream(file).close();
                throw new AssertionError("Asset writable stream accepted");
            } catch (IOException expected) { }
            if (file.length() != bytes.length) throw new AssertionError("Rejected write changed asset");
            // Compile directly from the mounted file; never replace the original asset source.
            try (var reader = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
                run(thread, LuaCompiler.loadis(reader, paths[index], environment), 0, false);
            }
            if (index != 0) json.append(',');
            json.append("{\"id\":\"").append(paths[index])
                    .append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "size", bytes.length); json.append(',');
            integer(json, "contentHash", Arrays.hashCode(bytes)); json.append("}}");
        }
        String[] checks = {
            "local Derived=ISBaseObject:derive('BrowserDerived'); local o=Derived:new(); o:initialise(); "
                + "check(o.Type=='BrowserDerived' and Derived.SuperType==ISBaseObject and getmetatable(o)==Derived); "
                + "local target={total=0}; local plain=0; "
                + "local withTarget=function(t,a,b) t.total=t.total+a+b end; "
                + "local withoutTarget=function(a,b) plain=plain+a*b end; "
                + "o:addEventListener('changed',withTarget,target); o:addEventListener('changed',withoutTarget); "
                + "o:triggerEvent('changed',2,3); check(target.total==5 and plain==6); "
                + "o:removeEventListener('changed',withoutTarget); o:triggerEvent('changed',4,1); "
                + "check(target.total==10 and plain==6); o:clearEventListeners(); o:triggerEvent('changed',9,9); "
                + "check(target.total==10 and plain==6 and o.__eventListeners==nil); return target.total*100+plain",
            "local list={'a','b'}; check(LuaTableUtil:contains(list,'a')); "
                + "check(not LuaTableUtil:contains(list,'missing') and not LuaTableUtil:contains(nil,'a')); "
                + "check(LuaTableUtil:insertUnique(list,'b')==list and #list==2); "
                + "check(LuaTableUtil:insertUnique(list,'c')==list and #list==3 and list[3]=='c'); "
                + "local marker={}; LuaTableUtil:insertUnique(list,marker); LuaTableUtil:insertUnique(list,marker); "
                + "check(#list==4 and LuaTableUtil:contains(list,marker)); return #list*100+3"
        };
        int[] expected = {1006, 403};
        int[] assertionCounts = {4, 5};
        for (int index = 0; index < checks.length; index++) {
            String test = "local function check(value) if not value then error('Asset contract failed') end end; " + checks[index];
            int result = run(thread, LuaCompiler.loadstring(test, "asset-contract-" + index, environment), expected[index], true);
            json.append(",{\"id\":\"").append(index == 0 ? "original-object-events" : "original-table-helpers")
                    .append("\",\"inputs\":[],\"outputs\":{");
            integer(json, "result", result); json.append(',');
            integer(json, "checks", assertionCounts[index]); json.append("}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static int run(KahluaThread thread, LuaClosure closure, int expected, boolean numeric) {
        Object[] results = thread.pcall(closure, new Object[0]);
        if (results.length < 1 || !Boolean.TRUE.equals(results[0]))
            throw failure("Original Lua asset execution failed: " + Arrays.toString(results));
        if (!numeric) return 0;
        if (results.length != 2 || !(results[1] instanceof Number) || ((Number) results[1]).doubleValue() != expected)
            throw failure("Original Lua helper result differs: " + Arrays.toString(results));
        return ((Number) results[1]).intValue();
    }
    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
    private static void integer(StringBuilder json, String name, int value) {
        json.append('"').append(name).append("\":{\"value\":").append(value).append(",\"bits\":\"");
        String bits = Integer.toHexString(value);
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
