package probe;

import java.util.concurrent.TimeUnit;

/** Exact unit conversions, including extreme timeout saturation. */
public final class TimeUnitProbe {
    public static void main(String[] args) {
        TimeUnit[] units = TimeUnit.values();
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for(int i=0;i<16;i++) {
            TimeUnit source = units[i<14?i/2:2];
            long value = i<14?(i%2==0?Long.MIN_VALUE:Long.MAX_VALUE):(i==14?-123456789:123456789);
            long[] converted={source.toNanos(value),source.toMicros(value),source.toMillis(value),source.toSeconds(value),source.toMinutes(value),source.toHours(value),source.toDays(value)};
            if(i!=0)json.append(',');
            json.append("{\"id\":\"conversion-").append(i).append("\",\"inputs\":[],\"outputs\":{");
            for(int j=0;j<units.length;j++) {
                if(converted[j]!=units[j].convert(value,source))throw new AssertionError("Conversion entry points disagree");
                if(j!=0)json.append(',');
                String bits=Long.toHexString(converted[j]);
                json.append('"').append(units[j].name()).append("\":{\"value\":").append(converted[j]).append(",\"bits\":\"");
                for(int k=bits.length();k<16;k++)json.append('0');
                json.append(bits).append("\"}");
            }
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }
}
