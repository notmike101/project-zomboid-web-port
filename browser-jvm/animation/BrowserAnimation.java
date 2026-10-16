import java.nio.file.*;
import java.util.*;
import zombie.core.skinnedmodel.model.*;
import zombie.core.skinnedmodel.model.jassimp.*;
public final class BrowserAnimation {
 public static native void report(String json);
 public static void main(String[] args){String stage="snapshot";try{
  StringBuilder result=new StringBuilder("{\"pass\":true,\"nativeFree\":true,\"clips\":[");int count=0;
  for(String name:new String[]{"MaleBody.x.ais","Bob_Idle.X.ais","Bob_Walk.x.ais"}){
   byte[] bytes=Files.readAllBytes(Path.of("/app",name));var scene=AiSceneSnapshot.decode(bytes);if(!Arrays.equals(bytes,AiSceneSnapshot.encode(scene)))throw new AssertionError("Snapshot roundtrip differs");
   stage="original-process-"+name;var params=ProcessedAiSceneParams.create();params.scene=scene;params.mode=JAssImpImporter.LoadMode.AnimationOnly;var processed=ProcessedAiScene.process(params);
   stage="original-clip-"+name;var asset=new AnimationAsset(new zombie.asset.AssetPath(name),null,null);processed.applyToAnimation(asset);
   if(asset.animationClips==null||asset.animationClips.isEmpty())throw new AssertionError("No real clips");
   for(var entry:asset.animationClips.entrySet()){
    var clip=entry.getValue();if(clip.getKeyframes().length==0||clip.getDuration()<=0)throw new AssertionError("Empty real clip");
    float translation=clip.getTranslationLength("Translation_Data",zombie.core.skinnedmodel.animation.BoneAxis.Y);
    if(name.equals("Bob_Walk.x.ais") && translation<=0.9f)throw new AssertionError("Original walking translation missing: "+translation);
    if(count++!=0)result.append(',');result.append("{\"source\":\"").append(name).append("\",\"name\":\"").append(clip.name).append("\",\"duration\":").append(clip.getDuration()).append(",\"keyframes\":").append(clip.getKeyframes().length).append(",\"rootMotionFrames\":").append(clip.getRootMotionFrameCount()).append(",\"translationLength\":").append(translation).append('}');
   }
  }
  report(result.append("]}").toString());
 }catch(Throwable error){error.printStackTrace();report("{\"pass\":false,\"stage\":\""+stage+"\",\"error\":\""+error.toString().replace("\\","\\\\").replace("\"","\\\"")+"\"}");}}
}
