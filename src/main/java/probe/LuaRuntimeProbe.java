package probe;

import se.krka.kahlua.j2se.J2SEPlatform;
import se.krka.kahlua.j2se.MathLib;
import se.krka.kahlua.luaj.compiler.LuaCompiler;
import se.krka.kahlua.stdlib.BaseLib;
import se.krka.kahlua.stdlib.CoroutineLib;
import se.krka.kahlua.stdlib.StringLib;
import se.krka.kahlua.stdlib.TableLib;
import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaThread;
import se.krka.kahlua.vm.KahluaUtil;
import se.krka.kahlua.vm.LuaClosure;

/** Browser-only shipped Lua compiler/interpreter proof, without game Lua environment startup. */
public final class LuaRuntimeProbe {
    public static void main(String[] args) throws Exception {
        J2SEPlatform platform = J2SEPlatform.getInstance();
        KahluaTable environment = platform.newTable();
        environment.rawset("_G", environment);
        BaseLib.register(environment);
        MathLib.register(platform, environment);
        TableLib.register(platform, environment);
        StringLib.register(platform, environment);
        CoroutineLib.register(platform, environment);
        KahluaThread thread = new KahluaThread(System.out, platform, environment);
        thread.debugOwnerThread = Thread.currentThread();
        KahluaUtil.setWorkerThread(environment, thread);
        String[] sources = {
            "local function makeCounter(start) local x=start; return function(delta) x=x+delta; return x end end\n"
                + "local bump=makeCounter(10); local values={bump(2),bump(3)}; table.insert(values,bump(5))\n"
                + "local sum=0; for i=1,#values do sum=sum+values[i] end\n"
                + "state={total=sum,count=#values,last=values[3],label=string.upper('lua')}\n"
                + "return state.total+math.floor(math.sqrt(81))\n",
            "local co=coroutine.create(function(seed) local resumed=coroutine.yield(seed+1); return resumed*2 end)\n"
                + "local ok,a=coroutine.resume(co,4); local ok2,b=coroutine.resume(co,7)\n"
                + "state.coroutine=a+b+state.total\n"
                + "return ok and ok2 and coroutine.status(co)=='dead' and state.coroutine or -1\n"
        };
        String[] ids = {"closures-tables-libraries", "coroutine-shared-state"};
        double[] expected = {56,66};
        int[] hashes = {320,366};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-lua-runtime\",\"cases\":[");
        for (int i = 0; i < sources.length; i++) {
            LuaClosure closure = LuaCompiler.loadstring(sources[i], "browser-lua-" + i, environment);
            // This shipped pcall overload dereferences its argument array after
            // execution; its one-argument convenience overload supplies null.
            Object[] results = thread.pcall(closure, new Object[0]);
            if (results.length != 2 || !Boolean.TRUE.equals(results[0]) || !(results[1] instanceof Number))
                throw failure("Lua execution failed: " + ids[i] + ": " + java.util.Arrays.toString(results));
            double value = ((Number) results[1]).doubleValue();
            KahluaTable state = (KahluaTable) environment.rawget("state");
            if (!"LUA".equals(state.rawget("label"))) throw failure("Original string library result differs");
            int hash = ((Number) state.rawget("count")).intValue() * 100
                    + ((Number) state.rawget(i == 0 ? "last" : "coroutine")).intValue();
            if (Double.doubleToRawLongBits(value) != Double.doubleToRawLongBits(expected[i]) || hash != hashes[i])
                throw failure("Lua result differs: " + ids[i] + ": " + value + "," + hash);
            if (i > 0) json.append(',');
            json.append("{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":{\"value\":")
                    .append(value).append(",\"bits\":\"");
            String bits = Long.toHexString(Double.doubleToRawLongBits(value));
            for (int j = bits.length(); j < 16; j++) json.append('0');
            json.append(bits).append("\"},\"contentHash\":{\"value\":").append(hash).append(",\"bits\":\"");
            bits = Integer.toHexString(hash);
            for (int j = bits.length(); j < 8; j++) json.append('0');
            json.append(bits).append("\"}}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static AssertionError failure(String message) {
        System.out.println(message);
        return new AssertionError(message);
    }
}
