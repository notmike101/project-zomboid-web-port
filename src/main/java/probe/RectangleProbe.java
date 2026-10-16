package probe;

import java.awt.Rectangle;

/** Integer geometry only: never initializes original game or desktop UI code. */
public final class RectangleProbe {
    public static void main(String[] args) {
        String[] ids = {"default", "fields-getters", "point-edges", "empty", "negative", "contained",
                "empty-contained", "intersect", "touching", "overflow-point", "overflow-contained",
                "union", "union-overflow", "negative-union", "negative-add", "clone-null"};
        int[][] expected = {{0,0,0,0,0},{-3,4,5,6,1},{10,20,3,4,3},{1,2,0,3,0},
                {1,2,-1,3,0},{1,2,8,9,3},{1,2,8,9,0},{1,2,8,9,1},{1,2,8,9,0},
                {2147483645,2147483645,10,10,1},{2147483645,2147483645,10,10,1},
                {-2,-3,8,10,1},{Integer.MIN_VALUE,0,Integer.MAX_VALUE,1,1},
                {3,4,5,6,1},{3,4,5,100,1},{1,2,3,4,7}};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < ids.length; i++) {
            Rectangle r = new Rectangle(); int flags = 0;
            switch (i) {
                case 0: break;
                case 1:
                    r.setBounds(-3,4,5,6); r.x = -3;
                    flags = r.getX() == -3 && r.getY() == 4 && r.getWidth() == 5 && r.getHeight() == 6 ? 1 : 0; break;
                case 2:
                    r.setBounds(10,20,3,4);
                    flags = (r.contains(10,20)?1:0) | (r.contains(12,23)?2:0) | (r.contains(13,23)?4:0) | (r.contains(12,24)?8:0); break;
                case 3: r.setBounds(1,2,0,3); flags = r.contains(1,2)?1:0; break;
                case 4: r.setBounds(1,2,-1,3); flags = r.intersects(new Rectangle(0,0,5,5))?1:0; break;
                case 5: r.setBounds(1,2,8,9); flags = (r.contains(new Rectangle(1,2,8,9))?1:0) | (r.contains(new Rectangle(2,3,1,1))?2:0); break;
                case 6: r.setBounds(1,2,8,9); flags = (r.contains(new Rectangle(2,3,0,1))?1:0) | (r.contains(new Rectangle(2,3,-1,1))?2:0); break;
                case 7: r.setBounds(1,2,8,9); flags = r.intersects(new Rectangle(8,10,2,2))?1:0; break;
                case 8: r.setBounds(1,2,8,9); flags = r.intersects(new Rectangle(9,2,1,1))?1:0; break;
                case 9: r.setBounds(Integer.MAX_VALUE-2,Integer.MAX_VALUE-2,10,10); flags = r.contains(Integer.MAX_VALUE,Integer.MAX_VALUE)?1:0; break;
                case 10: r.setBounds(Integer.MAX_VALUE-2,Integer.MAX_VALUE-2,10,10); flags = r.contains(new Rectangle(Integer.MAX_VALUE,Integer.MAX_VALUE,2,2))?1:0; break;
                case 11: r = new Rectangle(1,2,5,5).union(new Rectangle(-2,-3,1,1)); flags = 1; break;
                case 12: r = new Rectangle(Integer.MIN_VALUE,0,1,1).union(new Rectangle(Integer.MAX_VALUE,0,1,1)); flags = 1; break;
                case 13: r = new Rectangle(1,2,-1,100).union(new Rectangle(3,4,5,6)); flags = 1; break;
                case 14: r.setBounds(1,2,-1,100); r.add(new Rectangle(3,4,5,6)); flags = 1; break;
                case 15:
                    r.setBounds(1,2,3,4); Rectangle c = (Rectangle) r.clone(); c.x = 99;
                    flags = c != r && r.x == 1 ? 1 : 0;
                    try { r.contains((Rectangle)null); } catch (NullPointerException expectedNull) { flags |= 2; }
                    if (r.toString().equals("java.awt.Rectangle[x=1,y=2,width=3,height=4]")) flags |= 4;
                    break;
                default: throw new AssertionError();
            }
            int[] values = {r.x,r.y,r.width,r.height,flags};
            if (i > 0) json.append(',');
            json.append("{\"id\":\"").append(ids[i]).append("\",\"inputs\":[],\"outputs\":{");
            String[] names = {"x","y","width","height","flags"};
            for (int j = 0; j < values.length; j++) {
                if (values[j] != expected[i][j]) throw new AssertionError(ids[i]+"/"+names[j]+": "+values[j]);
                if (j > 0) json.append(',');
                json.append('"').append(names[j]).append("\":{\"value\":").append(values[j]).append(",\"bits\":\"");
                String bits = Integer.toHexString(values[j]);
                for (int k = bits.length(); k < 8; k++) json.append('0');
                json.append(bits).append("\"}");
            }
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
}
