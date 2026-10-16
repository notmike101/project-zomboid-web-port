package probe;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import port.runtime.BrowserAssets;
import se.krka.kahlua.j2se.J2SEPlatform;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaThread;
import se.krka.kahlua.vm.KahluaUtil;

/** Browser-only original standard-environment bootstrap with the unchanged installed stdlib.lua. */
public final class StandardEnvironmentProbe {
    public static void main(String[] args) throws Exception {
        BrowserAssets.mount();
        File library = new File("./stdlib.lua");
        byte[] bytes;
        try (FileInputStream input = new FileInputStream(library)) { bytes = input.readAllBytes(); }
        int hash = Arrays.hashCode(bytes);
        if (!library.isFile() || library.canWrite() || bytes.length == 0 || library.length() != bytes.length
                || hash != BrowserAssets.contentHash("/stdlib.lua") || library.delete() || library.setWritable(true))
            throw failure("Original standard library mount differs");
        try {
            new FileOutputStream(library).close();
            throw failure("Original standard library accepted a write");
        } catch (IOException expected) { }
        if (!Arrays.asList(new File("/").list()).contains("stdlib.lua")) throw failure("Root asset listing missing");

        J2SEPlatform platform = J2SEPlatform.getInstance();
        KahluaTable environment = platform.newEnvironment();
        KahluaThread thread = KahluaUtil.getWorkerThread(platform, environment);
        thread.debugOwnerThread = Thread.currentThread();
        String source = "assert(type(assert)=='function' and pairs==table.pairs and ipairs==table.ipairs); "
                + "local weighted=0; for i,v in ipairs({1,2,3}) do weighted=weighted+i*v end; assert(weighted==14); "
                + "local mapped=0; for k,v in pairs({a=4,b=5}) do mapped=mapped+v end; assert(mapped==9); "
                + "local values={3,1,9}; table.sort(values,function(a,b) return a>b end); assert(table.concat(values,',')=='9,3,1'); "
                + "local ok,message=pcall(assert,false,'expected-standard-library-error'); assert(not ok and type(message)=='string'); "
                + "local success,flag,value=pcall(assert,true,17); assert(success and flag and value==17); "
                + "assert(string.rep('ab',3)=='ababab' and math.min(5,2,8)==2 and math.max(3,7,1)==7); "
                + "local wrapped=coroutine.wrap(function(x) return x*2 end); local doubled=wrapped(4); assert(doubled==8); "
                + "return weighted+mapped+doubled+math.min(5,2,8)+math.max(3,7,1)+#values*2";
        Object[] results = thread.pcall(LuaCompiler.loadstring(source, "original-standard-library-contract", environment), new Object[0]);
        if (results.length != 2 || !Boolean.TRUE.equals(results[0]) || !(results[1] instanceof Number)
                || ((Number) results[1]).doubleValue() != 46)
            throw failure("Original standard environment failed: " + Arrays.toString(results));
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-lua-runtime\",\"cases\":[{\"id\":\"/stdlib.lua\",\"inputs\":[],\"outputs\":{");
        integer(json, "size", bytes.length); json.append(',');
        integer(json, "contentHash", hash);
        json.append("}},{\"id\":\"original-standard-environment\",\"inputs\":[],\"outputs\":{");
        integer(json, "result", 46); json.append(',');
        integer(json, "checks", 8);
        System.out.println(json.append("}}],\"pass\":true}"));
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
