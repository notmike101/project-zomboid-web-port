import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;

/** Copies bounded original client animation scripts, scene inputs and shaders into owned browser storage. */
public final class PrepareAnimationAssets {
    private static String quote(String value){return "\""+value.replace("\\","\\\\").replace("\"","\\\"")+"\"";}
    public static void main(String[] args)throws Exception {
        if(args.length!=3)throw new IllegalArgumentException("mediaRoot outputZip manifest");
        Path media=Path.of(args[0]).toRealPath(),base=media.getParent();
        Path output=Path.of(args[1]).toAbsolutePath().normalize(),manifest=Path.of(args[2]).toAbsolutePath().normalize();
        if(output.startsWith(base)||manifest.startsWith(base)||output.equals(manifest))throw new IllegalArgumentException("Outputs must be distinct and outside installation");
        var files=new TreeMap<String,Path>();
        for(String name:List.of("media/models_X/skinned/MaleBody.x","media/models_X/skinned/FemaleBody.x","media/models_X/skinned/Male_Skeleton.X","media/models_X/skinned/Female_Skeleton.X","media/anims_X/Bob/Bob_Idle.X","media/anims_X/Bob/Bob_Walk.x","media/anims_X/Bob/Bob_Run.X","media/scripts/generated/animations_meshes.txt","media/scripts/generated/models_characters.txt","media/AnimSets/Defaults.xml","media/shaders/default.vert","media/shaders/default.frag","media/shaders/basicEffect.vert","media/shaders/basicEffect.frag","media/shaders/util/math.h","media/shaders/util/math.glsl","media/shaders/util/hueShift.h","media/shaders/util/hueShift.glsl","media/ui/avatarBackgroundWhite.png","media/textures/Body/MaleBody01.png","media/textures/Body/FemaleBody01.png"))files.put(name,base.resolve(name));
        try(var paths=Files.walk(media.resolve("AnimSets/player"))){for(Path file:paths.filter(Files::isRegularFile).toList())files.put(base.relativize(file).toString().replace('\\','/'),file);}
        if(files.size()!=1842)throw new IllegalArgumentException("Unqualified installed animation asset inventory: "+files.size());
        for(var item:files.entrySet()){Path real=item.getValue().toRealPath();if(!real.startsWith(base)||!Files.isRegularFile(real)||Files.size(real)>4194304)throw new IllegalArgumentException("Asset escapes installation or exceeds bound: "+item.getKey());if((Files.exists(output)&&Files.isSameFile(real,output))||(Files.exists(manifest)&&Files.isSameFile(real,manifest)))throw new IllegalArgumentException("Output aliases installed asset");}
        var records=new ArrayList<String>();long total=0;
        try(var zip=new ZipOutputStream(Files.newOutputStream(output))){for(var item:files.entrySet()){
            byte[] bytes=Files.readAllBytes(item.getValue());total+=bytes.length;if(total>8388608)throw new IllegalArgumentException("Animation assets exceed total bound");
            String hash=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            var entry=new ZipEntry(item.getKey());entry.setTime(0);zip.putNextEntry(entry);zip.write(bytes);zip.closeEntry();
            records.add("{\"path\":"+quote(item.getKey())+",\"size\":"+bytes.length+",\"sha256\":"+quote(hash)+"}");
        }}
        Files.writeString(manifest,"{\"files\":"+files.size()+",\"bytes\":"+total+",\"entries\":["+String.join(",",records)+"]}\n");
        System.out.println("Prepared "+files.size()+" actual animation assets, "+total+" bytes");
    }
}
