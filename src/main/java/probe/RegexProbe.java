package probe;

import java.util.ConcurrentModificationException;
import java.util.function.Function;
import java.util.regex.MatchResult;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Functional Matcher replacement and callback mutation behavior, without game code. */
public final class RegexProbe {
    public static void main(String[] args) {
        String[] names = {"groups", "quoted-replacement", "named-group", "optional-group", "multi-digit-group",
                "zero-width", "reset-before-replace", "no-match", "null-function", "null-result",
                "callback-failure", "reset-find-mutation", "append-mutation", "pattern-mutation", "readonly-callback", "invalid-mutators"};
        String[] expected = {"a<1>b<2>", "a$\\b$\\", "a[1]b[2]", "ab", "jj", "-a-b-", "aXbX", "abc",
                "NullPointerException", "NullPointerException", "callback", "ConcurrentModificationException",
                "ConcurrentModificationException", "ConcurrentModificationException", "a1b2", "aXbX"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            int selected = i;
            String regex = i == 2 ? "(?<number>\\d)" : i == 3 ? "(z)?[ab]" : i == 4 ? "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)" : i == 5 ? "" : "(\\d)";
            String input = i == 3 || i == 5 ? "ab" : i == 4 ? "abcdefghijabcdefghij" : i == 7 ? "abc" : "a1b2";
            Matcher matcher = Pattern.compile(regex).matcher(input);
            if (i == 6) { matcher.region(2, 4); matcher.find(); }
            RuntimeException callbackFailure = new IllegalStateException("Expected callback failure");
            Function<MatchResult, String> function = match -> {
                switch (selected) {
                    case 0: return "<$1>";
                    case 1: return Matcher.quoteReplacement("$\\");
                    case 2: return "[${number}]";
                    case 3: return "$1$0";
                    case 4: return "$10";
                    case 5: return "-";
                    case 7: throw new AssertionError("No-match callback invoked");
                    case 9: return null;
                    case 10: throw callbackFailure;
                    case 11: matcher.reset(); matcher.find(); return "X";
                    case 12: matcher.appendReplacement(new StringBuffer(), "X"); return "X";
                    case 13: matcher.usePattern(matcher.pattern()); return "X";
                    case 14:
                        if (match != matcher || match.start() < 0 || match.end() < match.start()
                                || !match.group(1).equals(match.group()) || match.groupCount() != 1) throw new AssertionError("Read-only match differs");
                        matcher.toMatchResult(); matcher.pattern(); matcher.regionStart(); matcher.regionEnd();
                        matcher.hitEnd(); matcher.requireEnd(); matcher.useAnchoringBounds(false); matcher.useTransparentBounds(true);
                        return "$1";
                    case 15:
                        try { matcher.find(-1); throw new AssertionError(); } catch (IndexOutOfBoundsException expectedFailure) { }
                        try { matcher.region(-1, 2); throw new AssertionError(); } catch (IndexOutOfBoundsException expectedFailure) { }
                        try { matcher.usePattern(null); throw new AssertionError(); } catch (IllegalArgumentException expectedFailure) { }
                        return "X";
                    default: return "X";
                }
            };
            String result;
            try {
                result = matcher.replaceAll(i == 8 ? null : function);
            } catch (NullPointerException failure) {
                if (i != 8 && i != 9) throw failure;
                result = "NullPointerException";
            } catch (ConcurrentModificationException failure) {
                if (i < 11 || i > 13) throw failure;
                result = "ConcurrentModificationException";
            } catch (IllegalStateException failure) {
                if (i != 10 || failure != callbackFailure) throw failure;
                result = "callback";
            }
            if (!result.equals(expected[i])) throw new AssertionError(names[i] + ":" + result);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":");
            append(json, result.length());
            json.append(",\"contentHash\":");
            append(json, result.hashCode());
            json.append("}}");
        }
        System.out.println(json.append("]}"));
    }

    private static void append(StringBuilder json, int value) {
        String bits = Integer.toHexString(value);
        json.append("{\"value\":").append(value).append(",\"bits\":\"");
        for (int i = bits.length(); i < 8; i++) json.append('0');
        json.append(bits).append("\"}");
    }
}
