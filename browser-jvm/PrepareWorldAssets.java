import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;
/** Copies an explicit, bounded set of genuine installed files; no installed code executes. */
public final class PrepareWorldAssets {
    private static String quote(String value) { return "\""+value.replace("\\","\\\\").replace("\"","\\\"")+"\""; }
    public static void main(String[] args) throws Exception {
        if(args.length!=3)throw new IllegalArgumentException("mediaRoot outputZip manifest");
        Path media=Path.of(args[0]).toRealPath(), base=media.getParent();
        Path output=Path.of(args[1]).toAbsolutePath().normalize(),manifest=Path.of(args[2]).toAbsolutePath().normalize();
        if(output.startsWith(base)||manifest.startsWith(base))throw new IllegalArgumentException("Output must not be inside installation");
        var files=new TreeMap<String,Path>();
        for(String name:List.of("stdlib.lua","media/fileGuidTable.xml","media/lua/shared/defines.lua","media/lua/shared/Sandbox/Apocalypse.lua","media/lua/shared/NPCs/MainCreationMethods.lua","media/hairStyles/hairStyles.xml","media/hairStyles/beardStyles.xml"))files.put(name,base.resolve(name));
        try(var paths=Files.walk(media.resolve("actiongroups/player"))){for(Path file:paths.filter(Files::isRegularFile).toList())files.put(base.relativize(file).toString().replace('\\','/'),file);}
        if(files.size()!=953)throw new IllegalArgumentException("Unqualified installed player asset inventory: "+files.size());
        for(var item:files.entrySet()){Path real=item.getValue().toRealPath();if(!real.startsWith(base)||!Files.isRegularFile(real)||Files.size(real)>1048576)throw new IllegalArgumentException("Asset escapes installation or exceeds bound: "+item.getKey());if((Files.exists(output)&&Files.isSameFile(real,output))||(Files.exists(manifest)&&Files.isSameFile(real,manifest)))throw new IllegalArgumentException("Output aliases installed asset");}
        var records=new ArrayList<String>();long total=0;
        try(var zip=new ZipOutputStream(Files.newOutputStream(output))){for(var item:files.entrySet()){
            byte[] bytes=Files.readAllBytes(item.getValue());total+=bytes.length;if(total>2097152)throw new IllegalArgumentException("Player assets exceed total bound");
            String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            var entry=new ZipEntry(item.getKey());entry.setTime(0);zip.putNextEntry(entry);zip.write(bytes);zip.closeEntry();
            records.add("{\"path\":"+quote(item.getKey())+",\"size\":"+bytes.length+",\"sha256\":"+quote(hash)+"}");
        }}
        Files.writeString(manifest,"{\"files\":"+files.size()+",\"bytes\":"+total+",\"entries\":["+String.join(",",records)+"]}\n");
        System.out.println("Prepared "+files.size()+" actual player assets, "+total+" bytes");
    }
}

