import java.io.*;
import java.nio.file.*;
import java.util.*;
import jassimp.*;

/** One original native import per child process; process exit owns native reclamation. */
public final class ImportManifestRecord {
    public static void main(String[] args) throws Exception {
        if (args.length != 5) throw new IllegalArgumentException("ROOT DLL PLAN KEY STAGING");
        Path root = Path.of(args[0]).toRealPath(), dll = Path.of(args[1]).toRealPath(), plan = Path.of(args[2]).toRealPath(), output = Path.of(args[4]).toRealPath();
        if (output.startsWith(root) || !dll.getParent().equals(root)) throw new IOException("Invalid ownership roots");
        var records = PrepareManifestScenes.inputs(plan);
        var input = records.stream().filter(record -> record.key().equals(args[3])).findFirst().orElseThrow(() -> new IOException("Unknown manifest identity"));
        Path source = PrepareManifestScenes.source(root, input);
        EnumSet<AiPostProcessSteps> flags = EnumSet.noneOf(AiPostProcessSteps.class);
        for (String name : input.flags().split(",")) flags.add(AiPostProcessSteps.valueOf(name));
        Jassimp.setLibraryLoader(new JassimpLibraryLoader() { public void loadLibrary() { System.load(dll.toString()); } });
        AiScene original = Jassimp.importFile(source.toString(), flags);
        byte[] encoded = AiSceneSnapshot.encode(original);
        if (encoded.length > 256L * 1024 * 1024) throw new IOException("Snapshot exceeds per-record bound");
        AiScene restored = AiSceneSnapshot.decode(encoded);
        if (!Arrays.equals(encoded, AiSceneSnapshot.encode(restored))) throw new IOException("Original scene roundtrip differs");
        PrepareManifestScenes.source(root, input);
        Path snapshot = output.resolve(input.key() + ".ais");
        Files.write(snapshot, encoded, StandardOpenOption.CREATE_NEW);
        Properties proof = new Properties();
        proof.setProperty("source.sha256", input.sourceHash()); proof.setProperty("snapshot.sha256", PrepareManifestScenes.digest(encoded)); proof.setProperty("flags", input.flags());
        proof.setProperty("meshes", Integer.toString(restored.getNumMeshes())); proof.setProperty("animations", Integer.toString(restored.getNumAnimations()));
        try (OutputStream stream = Files.newOutputStream(output.resolve(input.key() + ".properties"), StandardOpenOption.CREATE_NEW)) { proof.store(stream, "Original Jassimp, exact codec roundtrip"); }
        System.out.println("Verified " + input.relative() + " bytes=" + encoded.length);
    }
}
