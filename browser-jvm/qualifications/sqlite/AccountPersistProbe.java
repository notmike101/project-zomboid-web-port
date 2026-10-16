import java.nio.file.*;
import java.time.LocalDateTime;
import zombie.ZomboidFileSystem;
import zombie.network.Account;
import zombie.network.Server;
import zombie.savefile.AccountDBHelper;

public final class AccountPersistProbe {

    public static native void report(String json);

    public static native void image(byte[] bytes);

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        try {
            String phase = args[0],
                owned = "/files/sqlite-owned/" + args[1];
            Path cache = Path.of(owned, "cache"),
                file = cache.resolve("db/ServerList.db");
            port.host.SqliteFiles.configure(owned);
            Files.createDirectories(Path.of(owned, "tmp"));
            Files.createDirectories(cache);
            System.setProperty("org.sqlite.tmpdir", owned + "/tmp");
            System.setProperty("org.sqlite.lib.path", "/app");
            System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
            ZomboidFileSystem.instance.setCacheDir(cache.toString());
            Class.forName("org.sqlite.JDBC");
            AccountDBHelper db = AccountDBHelper.getInstance();
            if (phase.equals("writer")) {
                check(
                    !Files.exists(file),
                    "Fresh owned database unexpectedly exists"
                );
                check(db.getServerList().isEmpty(), "Fresh database not empty");
                Server server = new Server();
                server.setName("persist Ω 🎮");
                server.setIp("127.0.0.1");
                server.setPort(16261);
                server.setDescription("first\u0000last");
                server.setLastOnline(LocalDateTime.of(2026, 1, 2, 3, 4, 5));
                int serverId = db.saveNewServer(server);
                check(serverId == 1, "Server id");
                server.setID(serverId);
                Account account = new Account();
                account.setUserName("userΩ🎮");
                account.setPwd("synthetic-only");
                account.setSavePwd(true);
                account.setAuthType(1);
                account.setTimePlayed(123456);
                check(db.saveNewAccount(server, account) == 1, "Account id");
            } else check(
                Files.exists(file),
                "Committed same-path database is absent in fresh VM"
            );
            var list = db.getServerList();
            check(list.size() == 1, "Persistent server count");
            Server server = list.get(0);
            check(
                server.getID() == 1 &&
                    server.getName().equals("persist Ω 🎮") &&
                    server.getDescription().equals("first\u0000last") &&
                    server
                        .getLastOnline()
                        .equals(LocalDateTime.of(2026, 1, 2, 3, 4, 5)),
                "Persistent server payload"
            );
            check(server.getAccounts().size() == 1, "Persistent account count");
            Account account = server.getAccounts().get(0);
            check(
                account.getID() == 1 &&
                    account.getUserName().equals("userΩ🎮") &&
                    account.getPwd().equals("synthetic-only") &&
                    account.getTimePlayed() == 123456 &&
                    account.isSavePwd(),
                "Persistent account payload"
            );
            byte[] bytes = Files.readAllBytes(file);
            check(bytes.length > 100, "Not a real SQLite image");
            image(bytes);
            report(
                "{\"pass\":true,\"phase\":\"" +
                    phase +
                    "\",\"servers\":1,\"accounts\":1,\"sameJavaPath\":true,\"imageBytes\":" +
                    bytes.length +
                    "}"
            );
        } catch (Throwable e) {
            e.printStackTrace();
            report(
                "{\"pass\":false,\"error\":\"" +
                    e.toString().replace("\\", "\\\\").replace("\"", "\\\"") +
                    "\"}"
            );
        }
    }
}
