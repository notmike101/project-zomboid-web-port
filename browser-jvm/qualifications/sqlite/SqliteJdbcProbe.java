import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Arrays;

public final class SqliteJdbcProbe {

    public static native void report(String text);

    public static void main(String[] args) {
        try {
            String owned =
                "/files/sqlite-owned/11111111-1111-4111-8111-111111111111";
            port.host.SqliteFiles.configure(owned);
            Files.createDirectories(
                Path.of(
                    "/files/sqlite-owned/11111111-1111-4111-8111-111111111111/tmp"
                )
            );
            Files.createDirectories(
                Path.of(
                    "/files/sqlite-owned/11111111-1111-4111-8111-111111111111/db"
                )
            );
            System.setProperty(
                "org.sqlite.tmpdir",
                "/files/sqlite-owned/11111111-1111-4111-8111-111111111111/tmp"
            );
            System.setProperty("org.sqlite.lib.path", "/app");
            System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
            Class.forName("org.sqlite.JDBC");
            try (
                var c = DriverManager.getConnection(
                    "jdbc:sqlite:/files/sqlite-owned/11111111-1111-4111-8111-111111111111/db/probe.db"
                )
            ) {
                try (
                    var s = c.createStatement();
                    var r = s.executeQuery("PRAGMA journal_mode=TRUNCATE")
                ) {
                    if (
                        !r.next() || !"truncate".equals(r.getString(1))
                    ) throw new AssertionError("Not real truncate");
                }
                try (var s = c.createStatement()) {
                    s.executeUpdate(
                        "CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT UNIQUE,amount INTEGER,payload BLOB,optional TEXT)"
                    );
                }
                c.setAutoCommit(false);
                try (
                    var s = c.prepareStatement(
                        "INSERT INTO sample(label,amount,payload,optional) VALUES(?,?,?,?)",
                        java.sql.Statement.RETURN_GENERATED_KEYS
                    )
                ) {
                    s.setString(1, "Unicode Ω 😃\u0000tail");
                    s.setLong(2, Long.MAX_VALUE);
                    s.setBytes(3, new byte[] {
                        0,
                        1,
                        127,
                        (byte) 128,
                        (byte) 255,
                    });
                    s.setNull(4, java.sql.Types.VARCHAR);
                    if (s.executeUpdate() != 1) throw new AssertionError(
                        "Update count"
                    );
                    try (var r = s.getGeneratedKeys()) {
                        if (
                            !r.next() || r.getLong(1) != 1
                        ) throw new AssertionError("Generated id");
                    }
                }
                c.commit();
                try (
                    var s = c.prepareStatement(
                        "INSERT INTO sample(label,amount) VALUES(?,?)"
                    )
                ) {
                    s.setString(1, "rolledback");
                    s.setLong(2, Long.MIN_VALUE);
                    s.executeUpdate();
                }
                c.rollback();
                try (
                    var s = c.createStatement();
                    var r = s.executeQuery(
                        "SELECT id,label,amount,payload,optional FROM sample"
                    )
                ) {
                    if (
                        !r.next() ||
                        r.getInt("id") != 1 ||
                        !"Unicode Ω 😃\u0000tail".equals(
                            r.getString("label")
                        ) ||
                        r.getLong("amount") != Long.MAX_VALUE ||
                        !Arrays.equals(r.getBytes("payload"), new byte[] {
                            0,
                            1,
                            127,
                            (byte) 128,
                            (byte) 255,
                        }) ||
                        r.getString("optional") != null ||
                        !r.wasNull() ||
                        r.next()
                    ) throw new AssertionError("Payload/rollback");
                }
                boolean constraint = false;
                try (var s = c.createStatement()) {
                    s.executeUpdate(
                        "INSERT INTO sample(label) VALUES('Unicode Ω 😃'||char(0)||'tail')"
                    );
                } catch (SQLException e) {
                    constraint =
                        e.getErrorCode() == 19 || e.getErrorCode() == 2067;
                }
                if (!constraint) throw new AssertionError(
                    "Real constraint SQL exception missing"
                );
            }
            report(
                "{\"pass\":true,\"originalXerial\":true,\"truncate\":true,\"signed64\":true,\"nulBlobNull\":true,\"rollback\":true,\"generatedKeys\":true,\"constraintException\":true}"
            );
        } catch (Throwable error) {
            error.printStackTrace();
            report(
                "{\"pass\":false,\"error\":\"" +
                    error
                        .toString()
                        .replace("\\", "\\\\")
                        .replace("\"", "\\\"")
                        .replace("\n", "\\n")
                        .replace("\r", "\\r") +
                    "\"}"
            );
        }
    }
}
