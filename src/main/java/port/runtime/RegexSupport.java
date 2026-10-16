package port.runtime;

import java.util.ConcurrentModificationException;
import java.util.Objects;
import java.util.function.Function;
import java.util.regex.MatchResult;
import java.util.regex.Matcher;

/** Functional replacement using the real matcher and an instrumented mutation epoch. */
public final class RegexSupport {
    public interface Access { int portRegexEpoch(); }

    public static String replaceAll(Matcher matcher, Function<MatchResult, String> replacer) {
        Objects.requireNonNull(replacer);
        matcher.reset();
        StringBuffer result = new StringBuffer();
        while (matcher.find()) {
            int before = ((Access) (Object) matcher).portRegexEpoch();
            String replacement = replacer.apply(matcher);
            if (before != ((Access) (Object) matcher).portRegexEpoch()) throw new ConcurrentModificationException();
            matcher.appendReplacement(result, replacement);
        }
        return matcher.appendTail(result).toString();
    }

    public static String expandReplacement(Matcher matcher, String replacement) {
        matcher.start();
        Objects.requireNonNull(replacement);
        StringBuilder result = new StringBuilder();
        for (int cursor = 0; cursor < replacement.length();) {
            char character = replacement.charAt(cursor++);
            if (character == '\\') {
                if (cursor == replacement.length()) throw new IllegalArgumentException("Missing escaped character");
                result.append(replacement.charAt(cursor++));
            } else if (character == '$') {
                if (cursor == replacement.length()) throw new IllegalArgumentException("Missing group reference");
                int group;
                if (replacement.charAt(cursor) == '{') {
                    int begin = ++cursor;
                    while (cursor < replacement.length() && asciiLetterOrDigit(replacement.charAt(cursor))) cursor++;
                    if (cursor == begin || cursor == replacement.length() || replacement.charAt(cursor) != '}'
                            || !asciiLetter(replacement.charAt(begin))) throw new IllegalArgumentException("Invalid named group reference");
                    String name = replacement.substring(begin, cursor++);
                    Integer named = matcher.pattern().namedGroups().get(name);
                    if (named == null) throw new IllegalArgumentException("Unknown named group");
                    group = named;
                } else {
                    char digit = replacement.charAt(cursor++);
                    if (digit < '0' || digit > '9') throw new IllegalArgumentException("Invalid group reference");
                    group = digit - '0';
                    while (cursor < replacement.length()) {
                        digit = replacement.charAt(cursor);
                        if (digit < '0' || digit > '9') break;
                        long candidate = (long) group * 10 + digit - '0';
                        if (candidate > matcher.groupCount()) break;
                        group = (int) candidate;
                        cursor++;
                    }
                }
                String capture = matcher.group(group);
                if (capture != null) result.append(capture);
            } else result.append(character);
        }
        return result.toString();
    }

    private static boolean asciiLetter(char value) {
        return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z';
    }
    private static boolean asciiLetterOrDigit(char value) {
        return asciiLetter(value) || value >= '0' && value <= '9';
    }
}
