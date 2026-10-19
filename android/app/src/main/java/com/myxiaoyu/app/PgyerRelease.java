package com.myxiaoyu.app;

import java.io.IOException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Read-only public-page adapter. No JavaScript execution, account keys or downloaded URLs. */
final class PgyerRelease {
    static final String PAGE = "https://www.pgyer.com/xiaoyu-ai-android-1";
    // Public, stable application-group identifier observed on the owner's download page.
    private static final String APP_GROUP = "d41a59afbc045d82dfc7bc2c4fb48e11";
    private static final Pattern SCRIPTS = Pattern.compile("<script\\b[^>]*>(.*?)</script\\s*>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    static String version(String html) throws IOException {
        if (html.length() > 1024 * 1024) throw new IOException("Page too large");
        Matcher scripts = SCRIPTS.matcher(html);
        String result = null;
        while (scripts.find()) {
            String block = scripts.group(1);
            String group = literal(block, "agKey");
            if (group == null) continue;
            if (!APP_GROUP.equals(group) || !"android".equals(literal(block, "aType"))) throw new IOException("Wrong application");
            String candidate = literal(block, "aVersion");
            if (result != null || !numeric(candidate)) throw new IOException("Unrecognized version");
            result = candidate;
        }
        if (result == null) throw new IOException("Version unavailable");
        return result;
    }

    private static String literal(String block, String name) throws IOException {
        Matcher match = Pattern.compile("(?m)^\\s*(?:var\\s+|let\\s+|const\\s+)?" + name + "\\s*=\\s*(['\"])([^'\"\\r\\n\\\\]*)\\1\\s*[,;]").matcher(block);
        if (!match.find()) return null;
        String value = match.group(2);
        if (match.find()) throw new IOException("Ambiguous metadata");
        return value;
    }

    private static boolean numeric(String value) {
        return value != null && value.matches("[0-9]{1,8}(\\.[0-9]{1,8}){1,3}");
    }

    static boolean newer(String candidate, String installed) throws IOException {
        if (!numeric(candidate) || !numeric(installed)) throw new IOException("Unsupported version format");
        String[] next = candidate.split("\\."), current = installed.split("\\.");
        for (int i = 0; i < Math.max(next.length, current.length); i++) {
            long a = i < next.length ? Long.parseLong(next[i]) : 0;
            long b = i < current.length ? Long.parseLong(current[i]) : 0;
            if (a != b) return a > b;
        }
        return false;
    }
}
