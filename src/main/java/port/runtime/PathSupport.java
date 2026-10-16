package port.runtime;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.ProviderMismatchException;
import java.util.ArrayDeque;

/** Supplies newer path conveniences through existing path operations. */
public final class PathSupport {
    public static Path toPath(File file) {
        return Paths.get(file.getPath());
    }

    public static Path resolve(Path base, String first, String[] more) {
        Path result = base.resolve(first);
        for (String part : more) result = result.resolve(part);
        return result;
    }

    /** Resolves paths for the browser's single default path provider. */
    public static Path resolvePath(Path base, Path other) {
        if (base.getClass() != other.getClass()) throw new ProviderMismatchException();
        if (other.isAbsolute() || other.getRoot() != null) return other;
        String left = base.toString();
        String right = other.toString();
        if (right.isEmpty()) return base;
        if (left.isEmpty()) return other;
        String separator = base.getFileSystem().getSeparator();
        return base.getFileSystem().getPath(left + (left.endsWith(separator) ? "" : separator) + right);
    }

    /** Removes lexical dot segments without accessing files or following symbolic links. */
    public static Path normalize(Path path) {
        Path root = path.getRoot();
        ArrayDeque<Path> names = new ArrayDeque<>();
        for (Path part : path) {
            String name = part.toString();
            if (name.isEmpty() || name.equals(".")) continue;
            if (name.equals("..")) {
                if (!names.isEmpty() && !names.peekLast().toString().equals("..")) names.removeLast();
                else if (root == null) names.addLast(part);
            } else names.addLast(part);
        }
        String separator = path.getFileSystem().getSeparator();
        StringBuilder text = new StringBuilder(root == null ? "" : root.toString());
        for (Path name : names) {
            if (text.length() != 0 && !text.toString().endsWith(separator)) text.append(separator);
            text.append(name);
        }
        Path result = path.getFileSystem().getPath(text.toString());
        return result.equals(path) ? path : result;
    }
}
