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
    private volatile String remote = "1.1.4";
    @Override public void onCreate(Bundle args) { start(); }
    @Override public void onStart() {
        Bundle result = new Bundle(); AppUpdater updater = null;
        try {
            URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
                @Override protected URLConnection openConnection(URL url) throws IOException {
                    if (!"www.pgyer.com".equals(url.getHost())) throw new IOException("Website deliberately unavailable");
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
            remote = "1.1.3"; updater.check(); await(state, "current");
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
}
