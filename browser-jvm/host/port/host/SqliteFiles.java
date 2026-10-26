package port.host;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Owned same-image bridge; graceful browser restart qualified, fsync/crash durability unqualified. */
public final class SqliteFiles {

    private record Lease(Path path, byte[] image, int references) {}

    private static final Map<Long, Lease> leases = new HashMap<>();
    private static Path root;
    private static long next;

    public static synchronized void configure(String ownedRoot)
        throws IOException {
        if (root != null) throw new IllegalStateException("Already configured");
        Path candidate = Path.of(ownedRoot).normalize();
        if (
            !candidate.toString().matches("/files/sqlite-owned/[a-f0-9-]{36}")
        ) {
            throw new IllegalArgumentException(
                "Fresh owned browser root required"
            );
        }
        Files.createDirectories(candidate);
        root = candidate.toRealPath();
    }

    public static synchronized long acquire(String filename)
        throws IOException {
        if (root == null) throw new IllegalStateException("Configure first");
        Path path = Path.of(filename).toAbsolutePath().normalize();
        if (!path.startsWith(root) || path.equals(root)) throw new IOException(
            "Outside owned database root"
        );
        Path parent = path.getParent().toRealPath();
        if (!parent.startsWith(root)) throw new IOException(
            "Database parent escapes owned root"
        );
        path = parent.resolve(path.getFileName());
        if (Files.isSymbolicLink(path)) throw new IOException(
            "Database symlink unsupported"
        );
        for (Map.Entry<Long, Lease> entry : leases.entrySet()) {
            Lease lease = entry.getValue();
            if (lease.path.equals(path)) {
                leases.put(entry.getKey(), new Lease(path, lease.image, Math.addExact(lease.references, 1)));
                return entry.getKey();
            }
        }
        byte[] image = Files.exists(path) ? Files.readAllBytes(path) : null;
        long key = ++next;
        leases.put(key, new Lease(path, image, 1));
        return key;
    }

    private static Lease lease(long key) throws IOException {
        Lease lease = leases.get(key);
        if (lease == null) throw new IOException("Unknown database lease");
        return lease;
    }

    public static synchronized byte[] read(long key) throws IOException {
        byte[] image = lease(key).image;
        return image == null ? null : image.clone();
    }

    public static synchronized void publish(long key, byte[] image)
        throws IOException {
        Objects.requireNonNull(image);
        Lease lease = lease(key);
        byte[] current = Files.exists(lease.path)
            ? Files.readAllBytes(lease.path)
            : null;
        if (!Arrays.equals(current, lease.image)) throw new IOException(
            "Database changed outside lease"
        );
        Path pending = lease.path.resolveSibling(
            lease.path.getFileName() + ".pending-" + UUID.randomUUID()
        );
        try {
            Files.write(pending, image, StandardOpenOption.CREATE_NEW);
            try (
                FileChannel channel = FileChannel.open(
                    pending,
                    StandardOpenOption.WRITE
                )
            ) {
                channel.force(true);
            }
            Files.move(
                pending,
                lease.path,
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING
            );
            leases.put(key, new Lease(lease.path, image.clone(), lease.references));
        } finally {
            Files.deleteIfExists(pending);
        }
    }

    public static synchronized void release(long key) throws IOException {
        Lease lease = lease(key);
        if (lease.references == 1) leases.remove(key);
        else leases.put(key, new Lease(lease.path, lease.image, lease.references - 1));
    }
}
