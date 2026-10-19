package com.myxiaoyu.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.util.Collections;
import java.util.Iterator;
import java.io.OutputStream;

import java.util.ArrayList;
import java.util.List;

/**
 * Bundled interface at the original origin; existing WebView data stays in place.
 */
public class MainActivity extends Activity {
    private static final String START_URL = "https://myxiaoyu.com/";
    private static final String UA_SUFFIX = " XiaoyuAndroid/1.1";
    private static final int REQ_FILE_CHOOSER = 4101;
    private static final int REQ_PERMISSIONS = 4102;
    private static final int REQ_SAVE_IMAGE = 4103;

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> pendingFileCallback;
    private PermissionRequest pendingPermissionRequest;
    private LocalContent localContent;
    private AppUpdater updater;
    private final JSONObject nativeState = new JSONObject();
    private byte[] pendingImage;
    private boolean startedChecks;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureBars();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#FBF6EE"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#FBF6EE"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        setContentView(root);
        try {
            JSONObject config = new JSONObject(LocalContent.read(this, "backend-config.json"));
            updater = new AppUpdater(this, config, this::updateState);
            nativeState.put("versionName", AppUpdater.versionName(this));
            nativeState.put("versionCode", updater.currentCode());
            nativeState.put("backendOrigins", config.getJSONArray("backendOrigins"));
            nativeState.put("backendOrigin", config.getJSONArray("backendOrigins").getString(0));
            nativeState.put("connection", "checking");
            nativeState.put("update", "checking");
            localContent = new LocalContent(this, nativeState);
        } catch (Exception failure) {
            new AlertDialog.Builder(this).setMessage("App resources could not be loaded. Please reinstall the latest update without uninstalling this app.")
                .setPositiveButton(android.R.string.ok, (dialog, which) -> finish()).show();
            return;
        }
        configureWebView();

        if (savedInstanceState != null) {
            if (webView.restoreState(savedInstanceState) == null) {
                webView.loadUrl(START_URL);
            }
        } else {
            webView.loadUrl(START_URL);
        }
    }

    private void configureBars() {
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#FBF6EE"));
        window.setNavigationBarColor(Color.parseColor("#FBF6EE"));
        int flags = window.getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        window.getDecorView().setSystemUiVisibility(flags);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setGeolocationEnabled(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + UA_SUFFIX);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "XiaoyuHost", Collections.singleton("https://myxiaoyu.com"),
                (view, message, sourceOrigin, isMainFrame, reply) -> {
                    if (!isMainFrame || !"https://myxiaoyu.com".equals(sourceOrigin.toString())) return;
                    String body = message.getData();
                    if (body == null || body.length() > 34 * 1024 * 1024) return;
                    try {
                        JSONObject command = new JSONObject(body);
                        switch (command.optString("action")) {
                            case "checkUpdate": updater.check(); break;
                            case "downloadUpdate": updater.download(); break;
                            case "installUpdate": updater.install(); break;
                            case "checkConnection": updater.checkConnection(); break;
                            case "saveImage": saveImage(command); break;
                            default: break;
                        }
                    } catch (Exception ignored) { }
                });
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(WebView view, android.webkit.WebResourceRequest request) {
                return localContent.intercept(request);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // A worker installed by 1.0 may serve its cached HTML before interception.
                // Retire the registration, without deleting its databases or app storage.
                if (url.startsWith(START_URL)) view.evaluateJavascript(
                    "if(!window.__XIAOYU_ANDROID__ && 'serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(async r=>{if(r.length){await Promise.all(r.map(w=>w.unregister()));location.reload();}}).catch(()=>{});}", null);
                updateState(new JSONObject());
                if (!startedChecks) {
                    startedChecks = true;
                    updater.checkConnection();
                    updater.check();
                }
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                return handleUrl(request.getUrl().toString());
            }

            @Override
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                } else {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> resolvePermissionRequest(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                }
                pendingFileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setCancelable(false)
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setCancelable(false)
                        .show();
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (ActivityNotFoundException ignored) {
                // Blob/data downloads are not handled by the shell.
            }
        });
    }

    private boolean handleUrl(String url) {
        if (url == null || url.isEmpty()) {
            return false;
        }
        if (url.startsWith("javascript:")) {
            return false;
        }
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();

        if ("http".equals(scheme) || "https".equals(scheme)) {
            String path = uri.getPath() == null ? "/" : uri.getPath();
            if ("https".equals(scheme) && host.equals("myxiaoyu.com") && (uri.getPort() == -1 || uri.getPort() == 443)
                && !path.startsWith("/download") && !path.startsWith("/admin") && !path.startsWith("/console")) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            } catch (ActivityNotFoundException e) {
                return true;
            }
        }

        if ("intent".equals(scheme)) {
            try {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception ignored) {
                // No app handles this intent.
            }
            return true;
        }

        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            // mailto/tel/weixin/alipays with no handler installed.
        }
        return true;
    }

    private void resolvePermissionRequest(PermissionRequest request) {
        if (!"https://myxiaoyu.com/".equals(request.getOrigin().toString()) && !"https://myxiaoyu.com".equals(request.getOrigin().toString())) {
            request.deny(); return;
        }
        boolean wantsCamera = false;
        boolean wantsMic = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                wantsCamera = true;
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                wantsMic = true;
            }
        }
        if (!wantsCamera && !wantsMic) {
            request.deny();
            return;
        }
        List<String> needed = new ArrayList<>();
        if (wantsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (wantsMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (needed.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        if (pendingPermissionRequest != null) {
            pendingPermissionRequest.deny();
        }
        pendingPermissionRequest = request;
        requestPermissions(needed.toArray(new String[0]), REQ_PERMISSIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMISSIONS) {
            return;
        }
        PermissionRequest request = pendingPermissionRequest;
        pendingPermissionRequest = null;
        if (request == null) {
            return;
        }
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) {
                granted = false;
                break;
            }
        }
        if (granted) {
            request.grant(request.getResources());
        } else {
            request.deny();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SAVE_IMAGE) {
            byte[] image = pendingImage;
            pendingImage = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && image != null) {
                Uri target = data.getData();
                new Thread(() -> {
                    try (OutputStream stream = getContentResolver().openOutputStream(target)) {
                        if (stream == null) throw new java.io.IOException("No destination");
                        stream.write(image);
                        runOnUiThread(() -> Toast.makeText(this, "✓", Toast.LENGTH_SHORT).show());
                    } catch (Exception e) {
                        runOnUiThread(() -> Toast.makeText(this, "Unable to save image. Please try again.", Toast.LENGTH_LONG).show());
                    }
                }, "xiaoyu-image-save").start();
            }
            return;
        }
        if (requestCode != REQ_FILE_CHOOSER || pendingFileCallback == null) {
            return;
        }
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        pendingFileCallback.onReceiveValue(results);
        pendingFileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onStart() {
        super.onStart();
        try {
            updateState(new JSONObject().put("openSequence", nativeState.optLong("openSequence", 0) + 1));
        } catch (Exception ignored) { }
        // A real foreground visit, including returning from the background. A permission
        // dialog that only pauses the Activity does not create another reminder.
        if (updater != null && startedChecks) {
            updater.check();
            updater.checkConnection();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updater != null) updater.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (updater != null) updater.close();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private void updateState(JSONObject patch) {
        runOnUiThread(() -> {
            try {
                for (Iterator<String> keys = patch.keys(); keys.hasNext();) { String key = keys.next(); nativeState.put(key, patch.get(key)); }
                if (webView != null) webView.evaluateJavascript("Object.assign(window.__XIAOYU_ANDROID__ || {}, " + nativeState.toString().replace("<", "\\u003c")
                    + ");window.dispatchEvent(new Event('xiaoyu:android-state'));", null);
            } catch (Exception ignored) { }
        });
    }

    private void saveImage(JSONObject command) throws Exception {
        if (pendingImage != null) return;
        String value = command.getString("data");
        int comma = value.indexOf(',');
        if (comma < 0 || !value.substring(0, comma).matches("data:image/(png|jpeg|webp);base64")) return;
        byte[] image = android.util.Base64.decode(value.substring(comma + 1), android.util.Base64.DEFAULT);
        if (image.length > 24 * 1024 * 1024) return;
        String mime = value.substring(5, value.indexOf(';'));
        String name = command.optString("name", "xiaoyu.png").replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        if (name.length() > 100) name = "xiaoyu.png";
        pendingImage = image;
        try {
            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name), REQ_SAVE_IMAGE);
        } catch (Exception e) { pendingImage = null; throw e; }
    }
}
