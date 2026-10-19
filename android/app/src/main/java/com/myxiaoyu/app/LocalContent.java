package com.myxiaoyu.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Exact bundled resources under the old HTTPS origin preserve existing WebView storage. */
final class LocalContent {
    private final Context context;
    private final JSONObject manifest;
    private final String html;
    LocalContent(Context context, JSONObject initialState) throws Exception {
        this.context = context;
        manifest = new JSONObject(read(context, "web-manifest.json"));
        html = read(context, "web/index.html").replace("<!--XIAOYU_ANDROID_STATE-->",
            "<script>window.__XIAOYU_ANDROID__=" + initialState.toString().replace("<", "\\u003c") + ";</script>");
    }
    static String read(Context context, String asset) throws IOException {
        try (InputStream stream = context.getAssets().open(asset); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int n;
            while ((n = stream.read(buffer)) >= 0) bytes.write(buffer, 0, n);
            return bytes.toString("UTF-8");
        }
    }
    WebResourceResponse intercept(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!"https".equals(uri.getScheme()) || !"myxiaoyu.com".equals(uri.getHost()) || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
        String path = uri.getPath();
        if (path == null || path.contains("..") || path.contains("\\")) return error(400, "Bad Request");
        if (path.startsWith("/api/") || path.startsWith("/uploads/") || path.startsWith("/scene-art/") || path.startsWith("/download/")) return null;
        try {
            if (path.equals("/") || path.equals("/index.html") || (request.isForMainFrame() && !path.substring(path.lastIndexOf('/') + 1).contains("."))) {
                byte[] bytes = html.getBytes(StandardCharsets.UTF_8);
                return response("text/html", 200, "OK", new ByteArrayInputStream(bytes), bytes.length, null);
            }
            if (!manifest.has(path)) return error(404, "Not Found");
            long size = manifest.getJSONObject(path).getLong("bytes");
            InputStream input = context.getAssets().open("web" + path.substring(0));
            String range = request.getRequestHeaders().get("Range");
            if (range != null && range.matches("bytes=\\d+-\\d*")) {
                String[] parts = range.substring(6).split("-", -1);
                long start = Long.parseLong(parts[0]);
                long end = parts[1].isEmpty() ? size - 1 : Math.min(Long.parseLong(parts[1]), size - 1);
                if (start >= size || start > end) { input.close(); return error(416, "Range Not Satisfiable"); }
                long left = start;
                while (left > 0) { long skipped = input.skip(left); if (skipped <= 0) throw new IOException("Unable to seek"); left -= skipped; }
                final long count = end - start + 1;
                InputStream bounded = new FilterInputStream(input) {
                    long remaining = count;
                    @Override public int read() throws IOException { if (remaining <= 0) return -1; int value = super.read(); if (value >= 0) remaining--; return value; }
                    @Override public int read(byte[] b, int off, int len) throws IOException { if (remaining <= 0) return -1; int n = super.read(b, off, (int)Math.min(len, remaining)); if (n > 0) remaining -= n; return n; }
                };
                return response(mime(path), 206, "Partial Content", bounded, count, "bytes " + start + "-" + end + "/" + size);
            }
            return response(mime(path), 200, "OK", input, size, null);
        } catch (Exception failure) { return error(500, "Resource Error"); }
    }
    private static String mime(String path) {
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        if (ext.equals("js") || ext.equals("mjs")) return "text/javascript";
        if (ext.equals("woff2")) return "font/woff2";
        if (ext.equals("wasm")) return "application/wasm";
        String result = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return result == null ? "application/octet-stream" : result;
    }
    private static WebResourceResponse response(String mime, int status, String reason, InputStream body, long length, String range) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Length", Long.toString(length));
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Accept-Ranges", "bytes");
        if (range != null) headers.put("Content-Range", range);
        return new WebResourceResponse(mime, mime.startsWith("text/") ? "UTF-8" : null, status, reason, headers, body);
    }
    private static WebResourceResponse error(int code, String reason) {
        return response("text/plain", code, reason, new ByteArrayInputStream(new byte[0]), 0, null);
    }
}
