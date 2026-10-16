import java.sql.*;

public final class PersistentImageRead {

    static void check(boolean v, String m) {
        if (!v) throw new AssertionError(m);
    }

    public static void main(String[] args) throws Exception {
        Class.forName("org.sqlite.JDBC");
        for (String file : args)
            try (
                Connection c = DriverManager.getConnection(
                    "jdbc:sqlite:file:" + file.replace('\\', '/') + "?mode=ro"
                );
                Statement s = c.createStatement()
            ) {
                try (ResultSet r = s.executeQuery("PRAGMA integrity_check")) {
                    check(r.next() && "ok".equals(r.getString(1)), "integrity");
                }
                try (ResultSet r = s.executeQuery("SELECT * FROM server")) {
                    check(r.next(), "server absent");
                    check(
                        r.getInt("id") == 1 &&
                            r.getString("name").equals("persist Ω 🎮") &&
                            r
                                .getString("description")
                                .equals("first\u0000last"),
                        "server payload"
                    );
                    check(!r.next(), "extra server");
                }
                try (ResultSet r = s.executeQuery("SELECT * FROM account")) {
                    check(r.next(), "account absent");
                    check(
                        r.getInt("id") == 1 &&
                            r.getString("userName").equals("userΩ🎮") &&
                            r.getString("password").equals("synthetic-only") &&
                            r.getLong("timePlayed") == 123456 &&
                            r.getInt("isSavePassword") == 1,
                        "account payload"
                    );
                    check(!r.next(), "extra account");
                }
                System.out.println("PERSISTENT_IMAGE_PASS " + file);
            }
    }
}
