import java.nio.file.*;
import java.util.*;
import zombie.asset.*;
import zombie.core.skinnedmodel.model.*;
import zombie.core.skinnedmodel.animation.*;
public final class BrowserAnimator {
 public static native void report(String json);
 public static void main(String[] args){String stage="mount";try{
  String[] names={"MaleBody.x","Bob_Idle.X","Bob_Walk.x"};String[] paths={"media/models_X/skinned/MaleBody.x","media/anims_X/Bob/Bob_Idle.X","media/anims_X/Bob/Bob_Walk.x"};
  for(int i=0;i<names.length;i++){Path destination=Path.of("/files/work",paths[i]);Files.createDirectories(destination.getParent());Files.copy(Path.of("/app",names[i]),destination,StandardCopyOption.REPLACE_EXISTING);}
  zombie.ZomboidFileSystem.instance.init();zombie.core.skinnedmodel.ModelManager.noOpenGL=true;
  stage="asset-managers";var fs=new zombie.fileSystem.FileSystemImpl();var managers=new AssetManagers(fs);MeshAssetManager.instance.create(ModelMesh.ASSET_TYPE,managers);AnimationAssetManager.instance.create(AnimationAsset.ASSET_TYPE,managers);ModelAssetManager.instance.create(Model.ASSET_TYPE,managers);
  zombie.debug.DebugLog.getInstance().setStdOut(System.out);zombie.debug.DebugLog.getInstance().setStdErr(System.out);stage="actual-model-load";var params=new Model.ModelAssetParams();params.meshName="skinned/MaleBody";params.isStatic=false;Model model=(Model)ModelAssetManager.instance.load(new AssetPath("prepared-male"),params);
  long end=System.currentTimeMillis()+20000;while(!model.isReady()&&!model.isFailure()&&System.currentTimeMillis()<end){fs.updateAsyncTransactions();Thread.sleep(1);}
  if(!model.isReady()){try{System.out.println("Diagnostic task constructor start");var task=new FileTask_LoadMesh(model.mesh,fs,null);for(String methodName:new String[]{"checkSlowLoad","checkExtensionType"}){try{var method=FileTask_AbstractLoadModel.class.getDeclaredMethod(methodName);method.setAccessible(true);System.out.println("Diagnostic "+methodName+": "+method.invoke(task));}catch(Throwable failure){System.out.println("Diagnostic "+methodName+" failed "+failure+" cause "+failure.getCause());}}System.out.println("Diagnostic task call start");Object diagnostic=task.call();System.out.println("Direct original mesh diagnostic: "+diagnostic);}catch(Throwable failure){failure.printStackTrace();}}
  if(!model.isReady()||model.mesh.skinningData==null)throw new AssertionError("Original model not ready: "+model.getState()+" mesh="+model.mesh.getState());
  stage="actual-animation-load"; var group=new zombie.core.skinnedmodel.ModelManager.ModAnimations("prepared-original-assets"); group.setPriority(0); var loadAnim=zombie.core.skinnedmodel.ModelManager.class.getDeclaredMethod("loadAnim",String.class,ModelMesh.class,zombie.core.skinnedmodel.ModelManager.ModAnimations.class);loadAnim.setAccessible(true);
  for(String clipName:new String[]{"Bob_Idle","Bob_Walk"}){
   var asset=(AnimationAsset)loadAnim.invoke(zombie.core.skinnedmodel.ModelManager.instance,"Bob/"+clipName,model.mesh,group);
   end=System.currentTimeMillis()+20000;while(!asset.isReady()&&!asset.isFailure()&&System.currentTimeMillis()<end){fs.updateAsyncTransactions();Thread.sleep(1);}
   if(!asset.isReady())throw new AssertionError("Original animation not ready: "+clipName+" "+asset.getState());
   if(!model.mesh.skinningData.animationClips.keySet().containsAll(asset.animationClips.keySet()))throw new AssertionError("Original manager did not register clips");
  }
  stage="actual-animation-player";AnimationPlayer player=AnimationPlayer.alloc(model);if(!player.isReady())throw new AssertionError("Animation player not ready");
  var idle=player.play("Bob_Idle",true);if(idle==null)throw new AssertionError("No idle track");idle.setBlendWeight(1);idle.setDeferredBone(model.mesh.skinningData.getBone("Translation_Data"),BoneAxis.Y);idle.setUseDeferredMovement(true);player.Update(1f/60);player.Update(1f/60);float idleTime=idle.getCurrentTimeValue();float idleMovement=player.getDeferredMovement(new zombie.iso.Vector2(),false).getLength();if(idleTime<=0||idleMovement>0.00001f)throw new AssertionError("Idle motion mismatch "+idleMovement);player.getMultiTrack().removeTrack(idle);player.resetDeferredMovementAccum(); var track=player.play("Bob_Walk",true);if(track==null)throw new AssertionError("No walking track");track.setBlendWeight(1);track.setDeferredBone(model.mesh.skinningData.getBone("Translation_Data"),BoneAxis.Y);track.setUseDeferredMovement(true);
  player.Update(1f/60);player.Update(1f/60);var movement=player.getDeferredMovement(new zombie.iso.Vector2(),false);
  if(movement.getLength()<=0)throw new AssertionError("Original deferred movement absent: "+movement);
  float walkingTime=track.getCurrentTimeValue();int bones=player.getNumBones();player.stopAll();player.release();var executorField=zombie.fileSystem.FileSystemImpl.class.getDeclaredField("executor");executorField.setAccessible(true);var executor=(java.util.concurrent.ExecutorService)executorField.get(fs);executor.shutdown();if(!executor.awaitTermination(5,java.util.concurrent.TimeUnit.SECONDS))throw new AssertionError("Asset executor still running");
  report("{\"pass\":true,\"modelReady\":true,\"idleTime\":"+idleTime+",\"idleMovement\":"+idleMovement+",\"assetExecutorTerminated\":true,\"bones\":"+bones+",\"trackTime\":"+walkingTime+",\"movementX\":"+movement.x+",\"movementY\":"+movement.y+"}");
 }catch(Throwable error){error.printStackTrace();report("{\"pass\":false,\"stage\":\""+stage+"\",\"error\":\""+error.toString().replace("\\","\\\\").replace("\"","\\\"")+"\"}");}}
}
