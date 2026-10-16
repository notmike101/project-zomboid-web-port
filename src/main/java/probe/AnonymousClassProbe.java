package probe;

import java.awt.Desktop;
import java.lang.reflect.Array;
import java.lang.reflect.Modifier;

/** Classfile identity checks only; Desktop.class does not initialize desktop services. */
public final class AnonymousClassProbe {
    private static final class Member { }
    public static void main(String[] args) {
        class Local { }
        Object anonymous = new Object() { };
        Runnable lambda = () -> { };
        Class<?>[] types = {AnonymousClassProbe.class,Member.class,Local.class,anonymous.getClass(),
                lambda.getClass(),Array.newInstance(anonymous.getClass(),0).getClass(),int.class,Desktop.class};
        String[] ids = {"ordinary","member","local","anonymous","lambda","anonymous-array","primitive","desktop-token"};
        int[] expected = {0,0,0,1,0,0,0,0};
        if (Modifier.isFinal(Desktop.class.getModifiers()) || !Modifier.isPublic(Desktop.class.getModifiers())
                || Desktop.class.getSuperclass() != Object.class
                || !Desktop.class.getName().equals("java.awt.Desktop")) throw new AssertionError("Desktop type identity differs");
        StringBuilder json=new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for(int i=0;i<types.length;i++) {
            int flag=types[i].isAnonymousClass()?1:0;
            int empty=types[i].getSimpleName().isEmpty()?1:0;
            if(flag!=expected[i] || empty!=expected[i]) throw new AssertionError(ids[i]+": "+flag+","+empty);
            if(i>0)json.append(',');
            json.append("{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json,flag);json.append(",\"contentHash\":");append(json,empty);json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
    private static void append(StringBuilder json,int value) {
        json.append("{\"value\":").append(value).append(",\"bits\":\"0000000").append(value).append("\"}");
    }
}
