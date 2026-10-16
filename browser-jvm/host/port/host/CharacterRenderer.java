package port.host;

import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.joml.Matrix4f;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import zombie.core.skinnedmodel.animation.AnimationPlayer;
import zombie.core.skinnedmodel.model.Model;
import zombie.core.skinnedmodel.shader.Shader;
import zombie.core.textures.ImageData;
import zombie.core.textures.Texture;
import zombie.core.textures.TextureID;

/** Owns one original shader and body material across repeated original mesh submissions. */
public final class CharacterRenderer implements AutoCloseable {
    private final Thread owner=Thread.currentThread();
    private final Matrix4f projection=new Matrix4f();
    private final org.lwjgl.util.vector.Vector3f position=new org.lwjgl.util.vector.Vector3f();
    private final Shader shader;
    private final Texture texture;
    private ByteBuffer readback;
    private byte[] image;
    private boolean closed;
    private int frames,lastWidth,lastHeight,lastBones;

    private CharacterRenderer(Texture material) {
        texture=material;
        shader=new Shader("basicEffect",false,false);
        if(shader.getID()<=0)throw new AssertionError("Original body shader unavailable");
    }

    /** Loads the selected mounted original body PNG once; no character appearance selection is claimed. */
    public static CharacterRenderer open(String mountedMaterial) throws Exception {
        Path path=Path.of(mountedMaterial).toRealPath();
        Path bodies=Path.of("/files/work/media/textures/Body").toRealPath();
        if(!path.startsWith(bodies)||!path.getFileName().toString().endsWith(".png"))throw new IllegalArgumentException("Expected mounted original body PNG");
        ImageData data;
        try(var input=Files.newInputStream(path)){data=new ImageData(input,false);}
        Texture texture=null;
        try{
            // TextureID owns ImageData until its actual render-context upload disposes it.
            texture=new Texture(new TextureID(data),path.toString());
            if(!texture.isReady())throw new AssertionError("Original body texture not ready");
            return new CharacterRenderer(texture);
        }catch(Throwable failure){
            if(texture!=null&&texture.getID()>0)GL11.glDeleteTextures(texture.getID());
            throw failure;
        }
    }

    /** Submits actual current skin transforms and the original GPU mesh without a per-frame readback. */
    public void draw(Model model,AnimationPlayer player) {
        checkOpen();
        if(model==null||!model.isReady()||model.mesh==null||!model.mesh.isReady()||model.mesh.vb==null)
            throw new AssertionError("Original GPU model is not ready");
        if(player==null||!player.isReady()||player.getModel()!=model||!texture.isReady())
            throw new AssertionError("Original animation player or material is not ready");
        var mesh=model.mesh;
        var palette=player.getSkinTransforms(mesh.skinningData);
        if(palette==null||palette.length==0||palette.length>60)throw new AssertionError("Original skin palette outside shader capacity");
        int width=SpriteGraphics.surfaceWidth(),height=SpriteGraphics.surfaceHeight();
        // Original skinned import does not fill ModelMesh's static-mesh bounds. Fit this
        // authored viewing camera to the original animation player's actual bone positions.
        float minX=Float.POSITIVE_INFINITY,maxX=Float.NEGATIVE_INFINITY,minY=Float.POSITIVE_INFINITY,maxY=Float.NEGATIVE_INFINITY;
        int modelTransforms=player.getModelTransformsCount();
        for(int i=0;i<modelTransforms;i++){
            var bone=player.getModelTransformAt(i);
            zombie.core.skinnedmodel.HelperFunctions.getPosition(bone,position);
            if(!Float.isFinite(position.x)||!Float.isFinite(position.y))throw new AssertionError("Non-finite original bone position");
            minX=Math.min(minX,position.x);maxX=Math.max(maxX,position.x);minY=Math.min(minY,position.y);maxY=Math.max(maxY,position.y);
        }
        float centerX=(minX+maxX)*.5f,centerY=(minY+maxY)*.5f;
        float span=Math.max(maxX-minX,maxY-minY)*.75f;
        if(!Float.isFinite(span)||span<=0)throw new AssertionError("Invalid original animated bone bounds: "+modelTransforms+" x="+minX+".."+maxX+" y="+minY+".."+maxY);
        GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER,0);
        GL11.glViewport(0,0,width,height);GL11.glDisable(GL11.GL_BLEND);GL11.glDisable(GL11.GL_CULL_FACE);
        GL11.glEnable(GL11.GL_DEPTH_TEST);GL11.glClearColor(0,0,0,1);GL11.glClear(GL11.GL_COLOR_BUFFER_BIT|GL11.GL_DEPTH_BUFFER_BIT);
        shader.Start();
        try {
            shader.getShaderProgram().setValue("ModelViewProjection",projection.identity().ortho(centerX-span,centerX+span,centerY-span,centerY+span,-100,100));
            shader.setMatrixPalette(palette);shader.setTexture(texture,"Texture",0);shader.setAlpha(1);shader.setTint(1,1,1);shader.setAmbient(1);shader.setHueShift(0);shader.setTargetDepth(.5f);shader.setDepthBias(0);shader.setScale(1);
            mesh.Draw(shader);
        }finally{shader.End();}
        if(GL11.glGetError()!=0)throw new AssertionError("Actual cached body draw failed");
        frames++;lastWidth=width;lastHeight=height;lastBones=palette.length;
    }

    /** Verifies a submitted frame on demand, reusing readback storage while the surface size is stable. */
    public String capture() {
        checkOpen();
        if(frames==0)throw new IllegalStateException("No original character frame submitted");
        int bytes=Math.multiplyExact(Math.multiplyExact(lastWidth,lastHeight),4);
        if(readback==null||readback.capacity()!=bytes){readback=ByteBuffer.allocateDirect(bytes);image=new byte[bytes];}
        readback.clear();
        GL11.glReadPixels(0,0,lastWidth,lastHeight,GL11.GL_RGBA,GL11.GL_UNSIGNED_BYTE,readback);
        if(GL11.glGetError()!=0||readback.position()!=0||readback.limit()!=bytes)throw new AssertionError("Actual cached character readback failed");
        int visible=0;
        for(int i=0;i<bytes;i++)image[i]=readback.get(i);
        for(int i=0;i<bytes;i+=4)if(image[i]!=0||image[i+1]!=0||image[i+2]!=0)visible++;
        if(visible<16)throw new AssertionError("Original cached character frame is not visible");
        return "{\"pass\":true,\"originalMeshDraw\":true,\"paletteBones\":"+lastBones+",\"frames\":"+frames+",\"width\":"+lastWidth+",\"height\":"+lastHeight+",\"visiblePixels\":"+visible+",\"pixelHash\":"+Arrays.hashCode(image)+"}";
    }

    public int getShaderId(){checkOpen();return shader.getID();}
    public int getMaterialId(){checkOpen();return texture.getID();}
    public int getFrameCount(){checkOpen();return frames;}

    private void checkOpen(){if(Thread.currentThread()!=owner)throw new IllegalStateException("Character renderer belongs to another Java thread");if(closed)throw new IllegalStateException("Character renderer is closed");}

    /** Releases the owned shader through its original API and deletes the owned actual GPU texture. */
    @Override public void close(){
        if(Thread.currentThread()!=owner)throw new IllegalStateException("Character renderer belongs to another Java thread");
        if(closed)return;
        closed=true;
        try{shader.getShaderProgram().destroy();}
        finally{GL11.glDeleteTextures(texture.getID());readback=null;image=null;}
        // Original asset wrappers, global models and engine bootstrap resources remain worker-lifetime.
    }
}
