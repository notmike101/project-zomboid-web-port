import java.nio.file.*;
import java.sql.*;
import java.util.Arrays;

public final class SqliteBoundaryProbe {

    public static native void report(String json);

    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void denied(Connection c, String sql) throws Exception {
        boolean caught = false,
            finished = false;
        try (Statement s = c.createStatement()) {
            s.execute(sql);
        } catch (SQLException e) {
            caught = e.getErrorCode() == 23;
        } finally {
            finished = true;
        }
        check(caught && finished, "Authorization denial missing");
    }

    private static void rejectOpen(Path image, int flags, String expected)
        throws Exception {
        byte[] before = Files.readAllBytes(image);
        int identities = port.host.SqliteSupport.identities();
        org.sqlite.core.NativeDB receiver = new org.sqlite.core.NativeDB(
            "jdbc:sqlite:" + image,
            image.toString(),
            new org.sqlite.SQLiteConfig()
        );
        java.lang.reflect.Method open =
            org.sqlite.core.NativeDB.class.getDeclaredMethod(
                "_open_utf8",
                byte[].class,
                int.class
            );
        open.setAccessible(true);
        boolean caught = false,
            finished = false;
        try {
            open.invoke(
                receiver,
                image
                    .toString()
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8),
                flags
            );
        } catch (java.lang.reflect.InvocationTargetException exception) {
            Throwable cause = exception.getCause();
            caught =
                cause instanceof UnsupportedOperationException &&
                cause.getMessage().contains(expected);
        } finally {
            finished = true;
        }
        check(
            caught && finished,
            "Open admission must throw real Java UOE/finally"
        );
        check(
            port.host.SqliteSupport.identities() == identities,
            "Rejected open leaked receiver identity"
        );
        check(
            Arrays.equals(before, Files.readAllBytes(image)),
            "Rejected open changed database image"
        );
    }

    public static void main(String[] args) {
        try {
            String root =
                "/files/sqlite-owned/33333333-3333-4333-8333-333333333333";
            port.host.SqliteFiles.configure(root);
            Files.createDirectories(Path.of(root, "tmp"));
            Files.createDirectories(Path.of(root, "db"));
            System.setProperty("org.sqlite.tmpdir", root + "/tmp");
            System.setProperty("org.sqlite.lib.path", "/app");
            System.setProperty("org.sqlite.lib.name", "sqlitejdbc.js");
            Class.forName("org.sqlite.JDBC");
            Path image = Path.of(root, "db/probe.db");
            check(
                new org.sqlite.SQLiteConfig().getOpenModeFlags() == 70,
                "Original default open flags changed"
            );
            try (
                Connection seed = DriverManager.getConnection(
                    "jdbc:sqlite:" + image
                );
                Statement statement = seed.createStatement()
            ) {
                statement.execute("PRAGMA journal_mode=TRUNCATE");
                statement.execute("CREATE TABLE admission(value INTEGER)");
            }
            rejectOpen(image, 1 | 64, "open flags");
            rejectOpen(image, 70 | 128, "open flags");
            rejectOpen(image, 70 | 131072, "open flags");
            Path wal = image.resolveSibling("wal-format.db");
            byte[] walBytes = Files.readAllBytes(image);
            walBytes[18] = 2;
            walBytes[19] = 2;
            Files.write(wal, walBytes);
            rejectOpen(wal, 70, "WAL-format");
            byte[] external = { 9, 8, 7, 6, 5 };
            boolean publicationCaught = false,
                poisonCaught = false,
                finished = false;
            try (
                Connection c = DriverManager.getConnection(
                    "jdbc:sqlite:" + image
                )
            ) {
                try (Statement s = c.createStatement()) {
                    s.execute("PRAGMA journal_mode=TRUNCATE");
                    s.execute(
                        "CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT UNIQUE)"
                    );
                    s.execute("INSERT INTO sample VALUES(1,'original')");
                }
                org.sqlite.core.NativeDB nativeDb = (org.sqlite.core.NativeDB) (
                    (org.sqlite.SQLiteConnection) c
                ).getDatabase();
                boolean unsupported = false,
                    unsupportedFinally = false;
                try {
                    nativeDb.shared_cache(false);
                } catch (UnsupportedOperationException e) {
                    unsupported = e.getMessage().contains("not qualified");
                } finally {
                    unsupportedFinally = true;
                }
                check(
                    unsupported && unsupportedFinally,
                    "Unsupported native did not throw into Java"
                );
                denied(c, "ATTACH DATABASE '/escape.db' AS outside");
                denied(c, "DETACH DATABASE outside");
                denied(c, "PRAGMA journal_mode=WAL");
                denied(c, "PRAGMA temp_store_directory='/tmp'");
                boolean syntax = false;
                try (Statement s = c.createStatement()) {
                    s.executeQuery("SELECT FROM sample");
                } catch (SQLException e) {
                    syntax =
                        e.getErrorCode() == 1 &&
                        e.getMessage().contains("syntax error");
                }
                check(syntax, "Real syntax error missing");
                boolean constraint = false;
                try (Statement s = c.createStatement()) {
                    s.executeUpdate("INSERT INTO sample VALUES(2,'original')");
                } catch (SQLException e) {
                    constraint =
                        (e.getErrorCode() == 19 || e.getErrorCode() == 2067) &&
                        e.getMessage().contains("UNIQUE constraint failed");
                }
                check(constraint, "Constraint diagnostic changed");
                try (
                    Statement s = c.createStatement();
                    ResultSet r = s.executeQuery("PRAGMA journal_mode")
                ) {
                    check(
                        r.next() && r.getString(1).equals("truncate"),
                        "Denied WAL changed mode"
                    );
                }
                c.setAutoCommit(false);
                try (Statement s = c.createStatement()) {
                    s.executeUpdate(
                        "INSERT INTO sample VALUES(3,'unpublished')"
                    );
                }
                Statement pending = c.createStatement();
                pending.executeQuery("SELECT * FROM sample");
                Files.write(image, external);
                try {
                    c.commit();
                } catch (SQLException e) {
                    publicationCaught =
                        e.getCause() instanceof java.io.IOException &&
                        e
                            .getMessage()
                            .contains("Database changed outside lease");
                } finally {
                    finished = true;
                }
                check(
                    publicationCaught && finished,
                    "Publication failure was not a genuine SQL exception"
                );
                try (Statement s = c.createStatement()) {
                    s.executeQuery("SELECT 1");
                } catch (SQLException e) {
                    poisonCaught = e.getMessage().contains("poisoned");
                }
                check(poisonCaught, "Poisoned connection accepted query");
            }
            check(
                Arrays.equals(Files.readAllBytes(image), external),
                "Failed publish changed external target"
            );
            check(
                port.host.SqliteSupport.pendingFailures() == 0,
                "Unconsumed Java failure"
            );
            report(
                "{\"pass\":true,\"authorizationDenials\":4,\"openAdmissionRejections\":4,\"syntaxException\":true,\"constraintDiagnostic\":true,\"publicationExceptionCaught\":true,\"finallyExecuted\":true,\"poisonRejected\":true,\"externalImagePreserved\":true}"
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
