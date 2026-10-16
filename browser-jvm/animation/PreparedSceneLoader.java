import java.nio.file.*;
import java.security.*;
import java.util.*;
import jassimp.*;
public final class PreparedSceneLoader {
 public static AiScene importFile(String file,Set<AiPostProcessSteps> flags)throws java.io.IOException {
  System.out.println("Prepared importer entry: "+file);
  try{
   String normalized=file.replace('\\','/').toLowerCase(Locale.ROOT);String name;
   if(normalized.endsWith("/models_x/skinned/malebody.x"))name="MaleBody.x";
   else if(normalized.endsWith("/anims_x/bob/bob_idle.x"))name="Bob_Idle.X";
   else if(normalized.endsWith("/anims_x/bob/bob_idle_heavybreathing.x"))name="Bob_Idle_HeavyBreathing.X";
   else if(normalized.endsWith("/anims_x/bob/bob_walkslow.x"))name="Bob_WalkSlow.x";
   else if(normalized.endsWith("/anims_x/bob/bob_walklightlimpr.x"))name="Bob_WalkLightLimpR.x";
   else if(normalized.endsWith("/anims_x/bob/bob_walklightlimpl.x"))name="Bob_WalkLightLimpL.x";
   else if(normalized.endsWith("/anims_x/bob/bob_walkheavylimpr.x"))name="Bob_WalkHeavyLimpR.x";
   else if(normalized.endsWith("/anims_x/bob/bob_walkheavylimpl.x"))name="Bob_WalkHeavyLimpL.x";
   else if(normalized.endsWith("/anims_x/bob/bob_walk.x"))name="Bob_Walk.x";else if(normalized.endsWith("/anims_x/bob/bob_run.x"))name="Bob_Run.X";else if(normalized.endsWith("/models_x/skinned/femalebody.x"))name="FemaleBody.x";else if(normalized.endsWith("/models_x/skinned/male_skeleton.x"))name="Male_Skeleton.X";else if(normalized.endsWith("/models_x/skinned/female_skeleton.x"))name="Female_Skeleton.X";
   else throw new java.io.IOException("No prepared original importer data for "+file);
   boolean animation=name.startsWith("Bob_");
   var expectedFlags=animation?EnumSet.of(AiPostProcessSteps.MAKE_LEFT_HANDED,AiPostProcessSteps.REMOVE_REDUNDANT_MATERIALS):EnumSet.of(AiPostProcessSteps.FIND_INSTANCES,AiPostProcessSteps.MAKE_LEFT_HANDED,AiPostProcessSteps.LIMIT_BONE_WEIGHTS,AiPostProcessSteps.TRIANGULATE,AiPostProcessSteps.OPTIMIZE_MESHES,AiPostProcessSteps.REMOVE_REDUNDANT_MATERIALS,AiPostProcessSteps.JOIN_IDENTICAL_VERTICES);
   if(!expectedFlags.equals(flags))throw new java.io.IOException("Prepared importer postprocess flags differ");
   var properties=new Properties();try(var in=Files.newInputStream(Path.of("/app/prepared.properties"))){properties.load(in);}
   var digest=MessageDigest.getInstance("SHA-256");String sourceHash=HexFormat.of().formatHex(digest.digest(Files.readAllBytes(Path.of(file))));
   if(!sourceHash.equals(properties.getProperty(name+".source")))throw new java.io.IOException("Original source SHA mismatch");
   byte[] snapshot=Files.readAllBytes(Path.of("/app",name+".ais"));String snapshotHash=HexFormat.of().formatHex(digest.digest(snapshot));
   if(!snapshotHash.equals(properties.getProperty(name+".snapshot")))throw new java.io.IOException("Prepared data SHA mismatch");
   return AiSceneSnapshot.decode(snapshot);
  }catch(java.io.IOException error){throw error;}catch(Exception error){throw new java.io.IOException("Prepared importer data unavailable",error);}
 }
}
