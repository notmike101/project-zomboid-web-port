package port.host;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.List;
import java.util.Objects;
import zombie.scripting.ScriptBucketCollection;
import zombie.scripting.ScriptLoadMode;
import zombie.scripting.ScriptManager;
import zombie.scripting.ScriptType;

/** Supplies real vanilla source provenance around the original selective script loader. */
public final class ScriptBootstrap {
    private ScriptBootstrap() { }

    public static void load(EnumSet<ScriptType> types, String... relativePaths) throws Exception {
        Objects.requireNonNull(types, "types");
        Objects.requireNonNull(relativePaths, "relativePaths");
        if (types.isEmpty()) throw new IllegalArgumentException("No script types selected");
        Path scriptRoot = Path.of("media/scripts").toRealPath();
        String[] absolutePaths = new String[relativePaths.length];
        for (int i = 0; i < relativePaths.length; i++) {
            Path relative = Path.of(Objects.requireNonNull(relativePaths[i], "script path"));
            if (relative.isAbsolute() || !relative.normalize().startsWith(Path.of("media/scripts"))) {
                throw new IllegalArgumentException("Expected mounted vanilla media/scripts path");
            }
            Path source = relative.toRealPath();
            if (!source.startsWith(scriptRoot) || !Files.isRegularFile(source)
                    || !source.getFileName().toString().endsWith(".txt")) {
                throw new IllegalArgumentException("Expected mounted vanilla script file");
            }
            absolutePaths[i] = source.toString();
        }
        Field[] provenance = new Field[3];
        Object[] previous = new Object[3];
        String[] names = {"currentLoadFileMod", "currentLoadFileAbsPath", "currentLoadFileName"};
        for (int i = 0; i < names.length; i++) {
            provenance[i] = ScriptManager.class.getDeclaredField(names[i]);
            provenance[i].setAccessible(true);
            previous[i] = provenance[i].get(null);
        }
        try {
            for (int i = 0; i < relativePaths.length; i++) {
                provenance[0].set(null, "pz-vanilla");
                provenance[1].set(null, absolutePaths[i]);
                provenance[2].set(null, zombie.scripting.FileName.getName(absolutePaths[i]));
                ScriptManager.instance.LoadFile(ScriptLoadMode.Init, relativePaths[i], false);
            }
            Method load = ScriptManager.class.getDeclaredMethod("loadScripts", ScriptLoadMode.class, EnumSet.class);
            load.setAccessible(true);
            try {
                load.invoke(ScriptManager.instance, ScriptLoadMode.Init, types);
            } catch (InvocationTargetException failure) {
                Throwable cause = failure.getCause();
                if (cause instanceof Exception exception) throw exception;
                if (cause instanceof Error error) throw error;
                throw failure;
            }
            Field collections = ScriptManager.class.getDeclaredField("bucketCollectionList");
            collections.setAccessible(true);
            for (Object value : (List<?>) collections.get(ScriptManager.instance)) {
                ScriptBucketCollection<?> bucket = (ScriptBucketCollection<?>) value;
                if (types.contains(bucket.getScriptType()) && bucket.hasLoadErrors()) {
                    throw new IllegalStateException("Original script bucket reports load errors: " + bucket.getScriptType());
                }
            }
            if (ScriptManager.instance.hasLoadErrors()) {
                throw new IllegalStateException("Original script lifecycle reports load errors");
            }
        } finally {
            for (int i = 0; i < provenance.length; i++) provenance[i].set(null, previous[i]);
        }
    }
}
