import jassimp.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

/** Imports only genuine source data; rejects generated aliases before loading the native importer. */
public final class PrepareScenes {
    static String hash(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private static Path canonical(Path path)throws Exception {
        path=path.toAbsolutePath().normalize();
        if(Files.exists(path,LinkOption.NOFOLLOW_LINKS))return path.toRealPath();
        Path parent=path.getParent();if(parent==null)throw new IllegalArgumentException("Cannot resolve output path");
        return canonical(parent).resolve(path.getFileName()).normalize();
    }
    private static void validate(Path output,List<Path> destinations,List<Path> inputs,Path installation)throws Exception {
        Path actual=canonical(output);
        if(actual.startsWith(installation))throw new IllegalArgumentException("Generated output is inside installation");
        for(Path input:inputs)if(input.startsWith(actual))throw new IllegalArgumentException("Input is inside generated output");
        var resolved=new ArrayList<Path>();
        for(Path destination:destinations){
            Path target=canonical(destination);
            if(!target.startsWith(actual)||target.equals(actual))throw new IllegalArgumentException("Generated destination escapes output: "+destination);
            if(Files.exists(destination)&&!Files.isRegularFile(destination))throw new IllegalArgumentException("Generated destination is not a file: "+destination);
            for(Path input:inputs)if(target.equals(input)||(Files.exists(destination)&&Files.isSameFile(destination,input)))throw new IllegalArgumentException("Generated destination aliases input: "+destination);
            for(Path previous:resolved)if(target.equals(previous)||(Files.exists(target)&&Files.exists(previous)&&Files.isSameFile(target,previous)))throw new IllegalArgumentException("Generated destinations alias each other: "+destination);
            resolved.add(target);
        }
    }
    private static String quote(String value){return "\""+value.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
    public static void main(String[] args)throws Exception {
        if(args.length<3)throw new IllegalArgumentException("Usage: PrepareScenes OUTPUT_DIR JASSIMP_DLL SOURCE_X [SOURCE_X ...]");
        Path output=Path.of(args[0]).toAbsolutePath().normalize();
        var inputs=new ArrayList<Path>();var names=new HashSet<String>();
        for(int i=1;i<args.length;i++){Path input=Path.of(args[i]).toRealPath();if(!Files.isRegularFile(input))throw new IllegalArgumentException("Input is not a regular file");inputs.add(input);if(i>1&&!names.add(input.getFileName().toString().toLowerCase(Locale.ROOT)))throw new IllegalArgumentException("Duplicate source basename: "+input.getFileName());}
        Path dll=inputs.get(0),installation=dll.getParent();
        var destinations=new ArrayList<Path>();for(int i=1;i<inputs.size();i++)destinations.add(output.resolve(inputs.get(i).getFileName()+".ais"));
        destinations.add(output.resolve("prepared.properties"));destinations.add(output.resolve("manifest.json"));
        validate(output,destinations,inputs,installation);
        Files.createDirectories(output);output=output.toRealPath();
        validate(output,destinations,inputs,installation);
        var originalHashes=new LinkedHashMap<Path,String>();for(Path input:inputs)originalHashes.put(input,hash(Files.readAllBytes(input)));
        Jassimp.setLibraryLoader(new JassimpLibraryLoader(){@Override public void loadLibrary(){System.load(dll.toString());}});
        var records=new ArrayList<String>();var properties=new Properties();var generated=new LinkedHashMap<Path,byte[]>();
        for(int i=1;i<inputs.size();i++){
            Path input=inputs.get(i);String before=originalHashes.get(input);
            boolean animation=input.toString().toLowerCase(Locale.ROOT).contains("anims_x");
            var flags=animation?EnumSet.of(AiPostProcessSteps.MAKE_LEFT_HANDED,AiPostProcessSteps.REMOVE_REDUNDANT_MATERIALS):EnumSet.of(AiPostProcessSteps.FIND_INSTANCES,AiPostProcessSteps.MAKE_LEFT_HANDED,AiPostProcessSteps.LIMIT_BONE_WEIGHTS,AiPostProcessSteps.TRIANGULATE,AiPostProcessSteps.OPTIMIZE_MESHES,AiPostProcessSteps.REMOVE_REDUNDANT_MATERIALS,AiPostProcessSteps.JOIN_IDENTICAL_VERTICES);
            AiScene scene=Jassimp.importFile(input.toString(),flags);byte[] bytes=AiSceneSnapshot.encode(scene);AiScene restored=AiSceneSnapshot.decode(bytes);if(!Arrays.equals(bytes,AiSceneSnapshot.encode(restored)))throw new AssertionError("Scene roundtrip differs");
            String name=input.getFileName()+".ais";generated.put(output.resolve(name),bytes);properties.setProperty(input.getFileName()+".source",before);properties.setProperty(input.getFileName()+".snapshot",hash(bytes));
            records.add("{\"input\":"+quote(input.toString().replace('\\','/'))+",\"inputSha256\":"+quote(before)+",\"output\":"+quote(name)+",\"outputSha256\":"+quote(hash(bytes))+",\"bytes\":"+bytes.length+",\"meshes\":"+restored.getNumMeshes()+",\"animations\":"+restored.getNumAnimations()+",\"roundtripExact\":true,\"flags\":"+quote(flags.toString())+"}");
            System.out.println(input.getFileName()+" exact snapshot bytes="+bytes.length+" meshes="+restored.getNumMeshes()+" animations="+restored.getNumAnimations());
        }
        for(var entry:originalHashes.entrySet())if(!entry.getValue().equals(hash(Files.readAllBytes(entry.getKey()))))throw new AssertionError("Importer input changed: "+entry.getKey());
        validate(output,destinations,inputs,installation);
        for(var entry:generated.entrySet())Files.write(entry.getKey(),entry.getValue());
        try(var out=Files.newOutputStream(output.resolve("prepared.properties"))){properties.store(out,"Verified local importer output");}
        Files.writeString(output.resolve("manifest.json"),"{\"pass\":true,\"nativeLibrarySha256\":"+quote(originalHashes.get(dll))+",\"gameClassesExecuted\":false,\"entries\":["+String.join(",",records)+"]}\n");
    }
}
