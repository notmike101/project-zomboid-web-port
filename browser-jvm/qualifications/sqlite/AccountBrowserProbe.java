import java.nio.file.*;
import java.sql.*;
import java.time.LocalDateTime;
import zombie.ZomboidFileSystem;
import zombie.network.Account;
import zombie.network.Server;
import zombie.savefile.AccountDBHelper;

public final class AccountBrowserProbe {

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    public static native void report(String json);

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Throwable e) {
            e.printStackTrace();
            report(
                "{\"pass\":false,\"error\":\"" +
                    e.toString().replace("\\", "\\\\").replace("\"", "\\\"") +
                    "\"}"
            );
        }
    }

    private static void run(String[] args) throws Exception {
        String owned =
            "/files/sqlite-owned/22222222-2222-4222-8222-222222222222";
        port.host.SqliteFiles.configure(owned);
        Files.createDirectories(Path.of(owned, "tmp"));
        System.setProperty("org.sqlite.tmpdir", owned + "/tmp");
        System.setProperty("org.sqlite.lib.path", "/app");
        System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
        args = new String[] { owned + "/cache" };
        Path cache = Path.of(args[0]).toAbsolutePath().normalize();
        if (
            !cache
                .toString()
                .replace('\\', '/')
                .matches("/files/sqlite-owned/[a-f0-9-]{36}/cache")
        ) {
            throw new IllegalArgumentException("Fresh private cache required");
        }
        check(!Files.exists(cache), "Cache must be fresh");
        Files.createDirectories(cache);
        ZomboidFileSystem.instance.setCacheDir(cache.toString());
        Class.forName("org.sqlite.JDBC");
        AccountDBHelper db = AccountDBHelper.getInstance();
        check(db.getServerList().isEmpty(), "Fresh database not empty");
        Server server = new Server();
        server.setName("Port \u03a9 \ud83c\udfae");
        server.setIp("127.0.0.1");
        server.setPort(16261);
        server.setServerPassword("synthetic-server-password");
        server.setDescription("first\u0000last");
        server.setLastOnline(LocalDateTime.of(2026, 1, 2, 3, 4, 5));
        int serverId = db.saveNewServer(server);
        check(serverId > 0, "Server insert failed");
        server.setID(serverId);
        Account account = new Account();
        account.setUserName("user\u03a9\ud83c\udfae");
        account.setPwd("synthetic-password");
        account.setSavePwd(true);
        account.setUseSteamRelay(false);
        account.setAuthType(1);
        account.setTimePlayed(123456);
        int accountId = db.saveNewAccount(server, account);
        check(accountId > 0, "Account insert failed");
        account.setID(accountId);
        var list = db.getServerList();
        check(list.size() == 1, "Server count");
        Server loaded = list.get(0);
        check(
            loaded.getID() == serverId &&
                loaded.getName().equals(server.getName()) &&
                loaded.getDescription().equals(server.getDescription()),
            "Server payload"
        );
        check(loaded.getAccounts().size() == 1, "Account count");
        Account saved = loaded.getAccounts().get(0);
        check(
            saved.getID() == accountId &&
                saved.getUserName().equals(account.getUserName()) &&
                saved.getPwd().equals(account.getPwd()) &&
                saved.getTimePlayed() == 123456 &&
                saved.isSavePwd(),
            "Account payload"
        );
        server.setName("updated\u03a9");
        check(db.updateServer(server), "Server update");
        account.setTimePlayed(654321);
        account.setUserName("updated-user");
        check(db.updateAccount(account), "Account update");
        list = db.getServerList();
        check(
            list.get(0).getName().equals("updated\u03a9") &&
                list.get(0).getAccounts().get(0).getTimePlayed() == 654321,
            "Update reopen"
        );
        check(db.deleteAccount(account), "Account delete");
        check(
            db.getServerList().get(0).getAccounts().isEmpty(),
            "Account deletion reopen"
        );
        check(db.deleteServer(server), "Server delete");
        check(db.getServerList().isEmpty(), "Server deletion reopen");
        Path image = cache.resolve("db/ServerList.db");
        try (
            Connection connection = DriverManager.getConnection(
                "jdbc:sqlite:" + image
            );
            Statement statement = connection.createStatement()
        ) {
            try (
                ResultSet rows = statement.executeQuery(
                    "PRAGMA integrity_check"
                )
            ) {
                check(
                    rows.next() && rows.getString(1).equals("ok"),
                    "Integrity"
                );
            }
            try (
                ResultSet rows = statement.executeQuery(
                    "SELECT (SELECT count(*) FROM server),(SELECT count(*) FROM account)"
                )
            ) {
                check(
                    rows.next() && rows.getInt(1) == 0 && rows.getInt(2) == 0,
                    "Final raw counts"
                );
            }
        }
        report(
            "{\"pass\":true,\"originalAccountDB\":true,\"serverId\":" +
                serverId +
                ",\"accountId\":" +
                accountId +
                ",\"bytes\":" +
                Files.size(image) +
                "}"
        );
    }
}
