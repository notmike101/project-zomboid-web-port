package probe;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import org.joml.Matrix4f;

/** Compares the shipped JOML NIO provider with the installed JVM implementation. */
public final class JomlProbe {
    public static void main(String[] args) {
        float[][] inputs = {{-1,1,-1,1,1,100}, {-1,1,-1,1,1,100},
                {2,11,3,17,0.25f,700}, {-20,-2,-17,-3,-50,100},
                {-100000,300000,-200000,500000,0.1f,10000}, {-0.001f,0.002f,-0.003f,0.004f,0.0001f,0.01f},
                {-5,5,-7,7,999,1000}, {3,-2,7,-5,100,1}};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-f32-raw-bits\",\"cases\":[");
        for (int i=0;i<inputs.length;i++) {
            float[] c=inputs[i];
            Matrix4f matrix=new Matrix4f().setOrtho(c[0],c[1],c[2],c[3],c[4],c[5],i==1);
            FloatBuffer data=ByteBuffer.allocateDirect(19*4).order(ByteOrder.nativeOrder()).asFloatBuffer();
            data.put(0,12345).put(1,-12345).put(2,42).position(3);
            matrix.get(data);
            if(data.position()!=3 || data.get(0)!=12345 || data.get(1)!=-12345 || data.get(2)!=42) throw new AssertionError("Matrix write changed prefix or position");
            if(i!=0) json.append(',');
            json.append("{\"id\":\"ortho-").append(i).append("\",\"inputs\":[");
            for(int j=0;j<c.length;j++) { if(j!=0) json.append(','); append(json,c[j]); }
            json.append("],\"outputs\":{");
            for(int j=0;j<16;j++) {
                float value=data.get(3+j);
                if(Float.floatToRawIntBits(value)!=Float.floatToRawIntBits(matrix.get(j/4,j%4))) throw new AssertionError("NIO write changed matrix bits");
                if(j!=0) json.append(',');
                json.append('"').append('m').append(j).append("\":"); append(json,value);
            }
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static void append(StringBuilder json,float value) {
        if(!Float.isFinite(value)) throw new AssertionError("Non-finite matrix");
        String bits=Integer.toHexString(Float.floatToRawIntBits(value));
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for(int i=bits.length();i<8;i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
