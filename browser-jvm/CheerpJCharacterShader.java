package probe;

import java.nio.*;
import java.nio.file.*;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL20;
import port.host.SpriteGraphics;
import zombie.ZomboidFileSystem;
import zombie.core.skinnedmodel.shader.Shader;

/** Original skinned shader program and real GPU uniform qualification; no synthetic model readiness. */
public final class CheerpJCharacterShader {
    public static void main(String[] args) {
        try {
            String[] paths={"basicEffect.vert","basicEffect.frag","util/math.h","util/math.glsl","util/hueShift.h","util/hueShift.glsl"};
            for(String path:paths){Path target=Path.of("/files/work/media/shaders",path);Files.createDirectories(target.getParent());Files.copy(Path.of("/app/media/shaders",path),target,StandardCopyOption.REPLACE_EXISTING);}
            ZomboidFileSystem.instance.init();
            Shader shader=new Shader("basicEffect",false,false);
            int program=shader.getID();
            if(program<=0||GL20.glGetProgrami(program,GL20.GL_LINK_STATUS)==0)throw new AssertionError("Original skinned basicEffect shader failed");
            shader.Start();
            int uv=GL20.glGetUniformLocation(program,"UVScale");
            int palette=GL20.glGetUniformLocation(program,"MatrixPalette[0]");
            if(uv<0||palette<0)throw new AssertionError("Original skinned uniforms absent");
            if(SpriteGraphics.uniformComponent(program,uv,0)!=1||SpriteGraphics.uniformComponent(program,uv,1)!=1)throw new AssertionError("UVScale initializer not applied");
            FloatBuffer matrices=ByteBuffer.allocateDirect(32*4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            for(int matrix=0;matrix<2;matrix++)for(int i=0;i<16;i++)matrices.put(matrix*16+i,i%5==0?matrix+1:0);
            matrices.put(1,7); matrices.put(18,9);
            shader.setMatrixPalette(matrices,true);
            if(matrices.position()!=0||matrices.limit()!=32)throw new AssertionError("Original palette upload changed buffer state");
            int second=GL20.glGetUniformLocation(program,"MatrixPalette[1]");
            if(SpriteGraphics.uniformComponent(program,palette,0)!=1||SpriteGraphics.uniformComponent(program,second,15)!=2||SpriteGraphics.uniformComponent(program,palette,4)!=7||SpriteGraphics.uniformComponent(program,second,8)!=9)throw new AssertionError("Actual matrix palette array upload differs");
            shader.End();
            if(GL11.glGetError()!=0)throw new AssertionError("Skinned shader GL error");
            SpriteGraphics.report("{\"pass\":true,\"stage\":\"original-character-shader\",\"programLinked\":true,\"uvScaleDefault\":true,\"paletteMatrices\":2,\"bufferStatePreserved\":true}");
        }catch(Throwable error){error.printStackTrace();SpriteGraphics.report("{\"pass\":false,\"stage\":\"original-character-shader\"}");}
    }
}
