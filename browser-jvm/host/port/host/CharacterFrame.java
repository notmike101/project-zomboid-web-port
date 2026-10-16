package port.host;

import java.nio.ByteBuffer;
import java.util.Arrays;
import org.joml.Matrix4f;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import zombie.core.skinnedmodel.animation.AnimationPlayer;
import zombie.core.skinnedmodel.model.Model;
import zombie.core.skinnedmodel.shader.Shader;
import zombie.core.textures.Texture;

/** An authored camera/readback harness around the original ready mesh, animation skinning and draw. */
public final class CharacterFrame {
    private CharacterFrame() { }
    public static String render(Model model, AnimationPlayer player, Texture texture) {
        if(model==null||!model.isReady()||model.mesh==null||!model.mesh.isReady()||model.mesh.vb==null)
            throw new AssertionError("Original GPU model is not ready");
        if(player==null||!player.isReady()||player.getModel()!=model||texture==null||!texture.isReady())
            throw new AssertionError("Original animation player or actual texture is not ready");
        var mesh=model.mesh;
        var palette=player.getSkinTransforms(mesh.skinningData);
        if(palette==null||palette.length==0||palette.length>60)throw new AssertionError("Original skin palette outside shader capacity");
        int width=SpriteGraphics.surfaceWidth(),height=SpriteGraphics.surfaceHeight();
        // Original skinned import does not fill ModelMesh's static-mesh bounds. Fit this
        // authored viewing camera to the original animation player's actual bone positions.
        float minX=Float.POSITIVE_INFINITY,maxX=Float.NEGATIVE_INFINITY,minY=Float.POSITIVE_INFINITY,maxY=Float.NEGATIVE_INFINITY;
        int modelTransforms=player.getModelTransformsCount();
        var position=new org.lwjgl.util.vector.Vector3f();
        for(int i=0;i<modelTransforms;i++){
            var bone=player.getModelTransformAt(i);
            zombie.core.skinnedmodel.HelperFunctions.getPosition(bone,position);
            if(!Float.isFinite(position.x)||!Float.isFinite(position.y))throw new AssertionError("Non-finite original bone position");
            minX=Math.min(minX,position.x);maxX=Math.max(maxX,position.x);minY=Math.min(minY,position.y);maxY=Math.max(maxY,position.y);
        }
        float centerX=(minX+maxX)*.5f,centerY=(minY+maxY)*.5f;
        float span=Math.max(maxX-minX,maxY-minY)*.75f;
        if(!Float.isFinite(span)||span<=0)throw new AssertionError("Invalid original animated bone bounds: "+modelTransforms+" x="+minX+".."+maxX+" y="+minY+".."+maxY);
        System.out.println("Original body camera from "+modelTransforms+" bone positions x="+minX+".."+maxX+" y="+minY+".."+maxY);
        Shader shader=new Shader("basicEffect",false,false);
        if(shader.getID()<=0)throw new AssertionError("Original body shader unavailable");
        GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER,0);
        GL11.glViewport(0,0,width,height);GL11.glDisable(GL11.GL_BLEND);GL11.glDisable(GL11.GL_CULL_FACE);
        GL11.glEnable(GL11.GL_DEPTH_TEST);GL11.glClearColor(0,0,0,1);GL11.glClear(GL11.GL_COLOR_BUFFER_BIT|GL11.GL_DEPTH_BUFFER_BIT);
        shader.Start();
        try {
            shader.getShaderProgram().setValue("ModelViewProjection",new Matrix4f().ortho(centerX-span,centerX+span,centerY-span,centerY+span,-100,100));
            shader.setMatrixPalette(palette);shader.setTexture(texture,"Texture",0);shader.setAlpha(1);shader.setTint(1,1,1);shader.setAmbient(1);shader.setHueShift(0);shader.setTargetDepth(.5f);shader.setDepthBias(0);shader.setScale(1);
            mesh.Draw(shader);
        }finally{shader.End();}
        ByteBuffer pixels=ByteBuffer.allocateDirect(Math.multiplyExact(Math.multiplyExact(width,height),4));
        GL11.glReadPixels(0,0,width,height,GL11.GL_RGBA,GL11.GL_UNSIGNED_BYTE,pixels);
        if(GL11.glGetError()!=0||pixels.position()!=0||pixels.limit()!=pixels.capacity())throw new AssertionError("Actual body draw/readback failed");
        byte[] image=new byte[pixels.capacity()];int visible=0;
        for(int i=0;i<image.length;i++)image[i]=pixels.get(i);
        for(int i=0;i<image.length;i+=4)if(image[i]!=0||image[i+1]!=0||image[i+2]!=0)visible++;
        if(visible<16)throw new AssertionError("Original skinned body produced insufficient visible pixels: "+visible);
        // Mesh, original shader and readback are owned by this isolated browser JVM lifetime.
        return "{\"pass\":true,\"originalMeshDraw\":true,\"paletteBones\":"+palette.length+",\"width\":"+width+",\"height\":"+height+",\"visiblePixels\":"+visible+",\"pixelHash\":"+Arrays.hashCode(image)+"}";
    }
}
