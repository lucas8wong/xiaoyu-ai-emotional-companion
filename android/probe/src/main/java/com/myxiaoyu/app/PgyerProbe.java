package com.myxiaoyu.app;

import android.app.*;
import android.content.Intent;
import android.os.Bundle;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;

/** Emulator-only synthetic transport. Never publish the probe APK. */
public final class PgyerProbe extends Instrumentation {
    private volatile String remote = "9.9.9";
    @Override public void onCreate(Bundle args) { start(); }
    @Override public void onStart() {
        Bundle result = new Bundle(); AppUpdater updater = null;
        try {
            URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
                @Override protected URLConnection openConnection(URL url) throws IOException {
                    if (!"www.pgyer.com".equals(url.getHost())) throw new IOException("Website deliberately unavailable");
                    if (!"/xiaoyu-ai-android".equals(url.getPath())) throw new IOException("Wrong download page");
                    return new HttpURLConnection(url) {
                        public void disconnect() {} public boolean usingProxy() { return false; } public void connect() {}
                        public int getResponseCode() { return 200; }
                        public InputStream getInputStream() {
                            String page = "<script>\naType = 'android',\naVersion = '" + remote + "',\nagKey = 'd41a59afbc045d82dfc7bc2c4fb48e11',\n</script>";
                            return new ByteArrayInputStream(page.getBytes(StandardCharsets.UTF_8));
                        }
                    };
                }
            });
            Activity activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("com.myxiaoyu.app", "com.myxiaoyu.app.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            java.lang.reflect.Field webField = activity.getClass().getDeclaredField("webView");
            webField.setAccessible(true);
            android.webkit.WebView web = (android.webkit.WebView)webField.get(activity);
            awaitJs(web, "!!document.querySelector('dialog[open] #android-update-title')");
            String sequence = js(web, "window.__XIAOYU_ANDROID__.openSequence");
            js(web, "document.querySelector('dialog[open] button').click()");
            Thread.sleep(700);
            awaitJs(web, "!document.querySelector('dialog[open] #android-update-title')");
            // Real task background/foreground transition; does not clear login or reload JS.
            runOnMainSync(() -> activity.moveTaskToBack(true));
            Thread.sleep(2500); // Let the task transition finish and Activity reach onStop.
            getTargetContext().startActivity(new Intent(Intent.ACTION_MAIN).setClassName("com.myxiaoyu.app", "com.myxiaoyu.app.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
            awaitJs(web, "window.__XIAOYU_ANDROID__.openSequence > " + sequence);
            awaitJs(web, "!!document.querySelector('dialog[open] #android-update-title')");
            result.putString("foreground", "PASS: guest cold open, dismiss, real background return, repeated newer-version prompt");
            AtomicReference<String> state = new AtomicReference<>(), delivery = new AtomicReference<>();
            updater = new AppUpdater(activity, new JSONObject("{\"updateProvider\":\"pgyer-public-page\",\"backendOrigins\":[]}"), patch -> {
                if (patch.has("update")) state.set(patch.optString("update"));
                if (patch.has("updateDelivery")) delivery.set(patch.optString("updateDelivery"));
            });
            updater.check(); await(state, "available");
            if (!"browser".equals(delivery.get())) throw new Exception("Wrong delivery");
            android.content.IntentFilter filter = new android.content.IntentFilter(Intent.ACTION_VIEW);
            filter.addDataScheme("https"); filter.addDataAuthority("www.pgyer.com", null);
            ActivityMonitor monitor = addMonitor(filter, new ActivityResult(Activity.RESULT_OK, null), true);
            final AppUpdater checkedUpdater = updater;
            runOnMainSync(checkedUpdater::download);
            if (monitor.getHits() != 1) throw new Exception("Browser monitor hits=" + monitor.getHits() + ", state=" + state.get());
            removeMonitor(monitor);
            remote = "1.1.6"; updater.check(); await(state, "current");
            remote = "1.1.2"; updater.check(); await(state, "current");
            remote = "invalid"; updater.check(); await(state, "failed");
            result.putString("pgyer", "PASS: website unavailable, newer/equal/older/malformed, browser handoff");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) { result.putString("failure", error.toString()); finish(Activity.RESULT_CANCELED, result); }
        finally { if (updater != null) updater.close(); }
    }
    private void await(AtomicReference<String> state, String target) throws Exception {
        for (int i = 0; i < 200; i++) { if (target.equals(state.get())) { Thread.sleep(50); return; } Thread.sleep(50); }
        throw new Exception("Expected " + target + ", got " + state.get());
    }
    private String js(android.webkit.WebView web, String script) throws Exception {
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        runOnMainSync(() -> web.evaluateJavascript(script, reply -> { value.set(reply); latch.countDown(); }));
        if (!latch.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new Exception("JS timeout");
        return value.get();
    }
    private void awaitJs(android.webkit.WebView web, String script) throws Exception {
        for (int i = 0; i < 150; i++) {
            if ("true".equals(js(web, script))) return;
            // The guest homepage can open its timed sign-in invitation. Dismiss via its
            // real close control so the update notice may proceed after that dialog.
            js(web, "document.querySelector('[role=dialog] button[aria-label=关闭], [role=dialog] button[aria-label=關閉], [role=dialog] button[aria-label=Close]')?.click()");
            Thread.sleep(200);
        }
        throw new Exception("UI condition failed: " + script + "; " + js(web, "JSON.stringify({state:window.__XIAOYU_ANDROID__,active:document.activeElement?.tagName,visibility:document.visibilityState,dialogs:[...document.querySelectorAll('dialog[open],[role=dialog]')].map(e=>e.outerHTML.slice(0,200)),root:document.getElementById('root')?.children.length,url:location.href})"));
    }
}
