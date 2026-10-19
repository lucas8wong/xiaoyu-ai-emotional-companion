package com.myxiaoyu.app;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public final class PgyerReleaseTest {
    private static String page(String version) {
        return "<script>\naType = 'android',\n aVersion = '" + version + "',\n agKey = 'd41a59afbc045d82dfc7bc2c4fb48e11',\n</script>";
    }
    private static void require(boolean condition) { if (!condition) throw new AssertionError(); }
    private static void rejected(String html) throws Exception {
        try { PgyerRelease.version(html); throw new AssertionError("Accepted invalid page"); }
        catch (IOException expected) { }
    }
    public static void main(String[] args) throws Exception {
        require(PgyerRelease.version(page("1.1.4")).equals("1.1.4"));
        require(PgyerRelease.newer("1.1.10", "1.1.9"));
        require(PgyerRelease.newer("2.0.0", "1.99.99"));
        require(!PgyerRelease.newer("1.1.3", "1.1.3"));
        require(!PgyerRelease.newer("1.1.2", "1.1.3"));
        require(!PgyerRelease.newer("1.1.3.0", "1.1.3"));
        rejected("<html>Access denied 9.9.9</html>");
        rejected(page("1.1.4").replace("d41a59af", "ffffffff"));
        rejected(page("1.1.4").replace("android", "ios"));
        rejected(page("1.1.4") + page("9.9.9"));
        rejected(page("1.1.4").replace("aVersion =", "unknownVersion ="));
        rejected(page("1.1.4-beta"));
        rejected(page("999999999999999999.1"));
        rejected(page("1.1.4").replace("</script>", "aVersion = '9.9.9',\n</script>"));
        rejected("x".repeat(1024 * 1024 + 1));
        if (args.length > 0) System.out.println("Public page version: " + PgyerRelease.version(Files.readString(Path.of(args[0]))));
        System.out.println("PASS: version comparison, pinned identity, malformed/ambiguous/oversized pages");
    }
}
