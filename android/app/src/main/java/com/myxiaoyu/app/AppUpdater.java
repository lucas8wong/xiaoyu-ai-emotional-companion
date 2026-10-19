package com.myxiaoyu.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import org.json.*;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** HTTPS manifest + package/signature/hash checks. Updates never clear application data. */
final class AppUpdater {
    interface Listener { void changed(JSONObject patch); }
    private final Activity activity;
    private final JSONObject config;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean busy;
    private volatile boolean closed;
    private JSONObject release;
    private File readyFile;
    private boolean waitingPermission;
    AppUpdater(Activity activity, JSONObject config, Listener listener) {
        this.activity = activity; this.config = config; this.listener = listener;
    }
    void emit(String key, Object value) { try { if (!closed) listener.changed(new JSONObject().put(key, value)); } catch (Exception ignored) {} }
    static String versionName(Activity activity) {
        try { return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; } catch (Exception e) { return "1.1.0"; }
    }
    static long versionCode(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    long currentCode() throws Exception { return versionCode(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0)); }
    private boolean allowed(String value, String list) {
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getHost() == null || uri.getFragment() != null) return false;
            String origin = "https://" + uri.getHost().toLowerCase(Locale.ROOT) + (uri.getPort() == -1 || uri.getPort() == 443 ? "" : ":" + uri.getPort());
            JSONArray origins = config.getJSONArray(list);
            for (int i = 0; i < origins.length(); i++) if (origin.equals(origins.getString(i))) return true;
        } catch (Exception ignored) {}
        return false;
    }
    private HttpURLConnection open(String url, String list, int timeout) throws Exception {
        if (!allowed(url, list)) throw new IOException("Unapproved origin");
        HttpURLConnection connection = (HttpURLConnection)new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(timeout); connection.setReadTimeout(timeout);
        connection.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive");
        connection.setRequestProperty("Cache-Control", "no-cache");
        return connection;
    }
    private JSONObject json(String url, int timeout) throws Exception {
        HttpURLConnection connection = open(url, "backendOrigins", timeout);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("HTTP status");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] bytes = new byte[4096]; int n;
                while ((n = in.read(bytes)) != -1) { if (out.size() + n > 65536) throw new IOException("Oversize manifest"); out.write(bytes, 0, n); }
                return new JSONObject(out.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }
    void checkConnection() {
        emit("connection", "checking");
        worker.execute(() -> {
            try {
                JSONArray origins = config.getJSONArray("backendOrigins");
                for (int i = 0; i < origins.length(); i++) {
                    String origin = origins.getString(i);
                    try {
                        JSONObject health = json(origin + "/api/health", 4000);
                        if (!health.optBoolean("success") && !"ok".equals(health.optString("status"))) continue;
                        emit("backendOrigin", origin); emit("connection", "online"); return;
                    } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
            emit("connection", "offline");
        });
    }
    synchronized void check() {
        if (busy || closed) return;
        busy = true; emit("update", "checking");
        worker.execute(() -> {
            try {
                JSONObject found = null;
                JSONArray origins = config.getJSONArray("backendOrigins");
                for (int i = 0; i < origins.length(); i++) {
                    try { found = json(origins.getString(i) + config.getString("updatePath") + "?v=" + currentCode() + "&t=" + System.currentTimeMillis(), 6000); validate(found); break; }
                    catch (Exception ignored) { found = null; }
                }
                if (found == null) throw new IOException("No release manifest");
                release = found;
                emit("latestVersion", release.getString("versionName"));
                emit("update", release.getLong("versionCode") > currentCode() ? "available" : "current");
            } catch (Exception failure) { emit("update", "failed"); }
            finally { busy = false; }
        });
    }
    private void validate(JSONObject entry) throws Exception {
        if (entry.getInt("schema") != 1 || !activity.getPackageName().equals(entry.getString("packageId"))
            || entry.getLong("versionCode") <= 0 || entry.getString("versionName").length() > 40
            || entry.getInt("minSdk") > Build.VERSION.SDK_INT
            || !entry.getString("sha256").matches("[0-9a-fA-F]{64}")
            || entry.getLong("bytes") <= 0 || entry.getLong("bytes") > 1024L * 1024 * 1024
            || !allowed(entry.getString("apkUrl"), "downloadOrigins")) throw new IOException("Invalid release");
    }
    synchronized void download() {
        if (busy || release == null || closed) return;
        busy = true; emit("progress", 0); emit("update", "downloading");
        final JSONObject selected = release;
        worker.execute(() -> {
            File partial = null;
            try {
                validate(selected);
                if (selected.getLong("versionCode") <= currentCode()) throw new IOException("Not an upgrade");
                File directory = new File(activity.getCacheDir(), "updates");
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("Storage unavailable");
                long expected = selected.getLong("bytes");
                if (directory.getUsableSpace() < expected * 2) throw new IOException("Not enough space");
                partial = new File(directory, "release.part");
                HttpURLConnection connection = open(selected.getString("apkUrl"), "downloadOrigins", 30000);
                MessageDigest digest = MessageDigest.getInstance("SHA-256"); long total = 0; int lastProgress = -1;
                try {
                    if (connection.getResponseCode() != 200) throw new IOException("Download failed");
                    try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
                        byte[] buffer = new byte[65536]; int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (closed || (total += n) > expected) throw new IOException("Download interrupted");
                            out.write(buffer, 0, n); digest.update(buffer, 0, n);
                            int progress = (int)(total * 100 / expected);
                            if (progress != lastProgress) { lastProgress = progress; emit("progress", progress); }
                        }
                        out.getFD().sync();
                    }
                } finally { connection.disconnect(); }
                if (total != expected || !hex(digest.digest()).equalsIgnoreCase(selected.getString("sha256"))) throw new IOException("Checksum mismatch");
                verifyPackage(partial, selected.getLong("versionCode"));
                File target = new File(directory, "xiaoyu-" + selected.getLong("versionCode") + ".apk");
                if (target.exists() && !target.delete()) throw new IOException("Cannot replace cached update");
                if (!partial.renameTo(target)) throw new IOException("Cannot finish download");
                readyFile = target;
                emit("update", "ready");
            } catch (Exception failure) { if (partial != null) partial.delete(); emit("update", "failed"); }
            finally { busy = false; }
        });
    }
    @SuppressWarnings("deprecation")
    private void verifyPackage(File apk, long expectedVersion) throws Exception {
        PackageManager manager = activity.getPackageManager();
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES);
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (archive == null || !installed.packageName.equals(archive.packageName) || versionCode(archive) != expectedVersion || expectedVersion <= versionCode(installed)) throw new IOException("Wrong app version");
        if (archive.signatures == null || installed.signatures == null || !new HashSet<Signature>(Arrays.asList(installed.signatures)).equals(new HashSet<Signature>(Arrays.asList(archive.signatures)))) throw new IOException("Signing identity mismatch");
    }
    void install() {
        if (readyFile == null || !readyFile.isFile()) { check(); return; }
        try {
            verifyPackage(readyFile, release.getLong("versionCode"));
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                waitingPermission = true;
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
                return;
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", readyFile);
            activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
        } catch (Exception failure) { emit("update", "failed"); }
    }
    void onResume() {
        if (waitingPermission) { waitingPermission = false; if (Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls()) install(); }
    }
    void close() { closed = true; worker.shutdownNow(); }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
}
