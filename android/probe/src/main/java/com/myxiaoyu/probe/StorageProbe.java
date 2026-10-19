package com.myxiaoyu.probe;

import android.app.*;
import android.content.Intent;
import android.os.Bundle;
import android.view.*;
import android.webkit.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Run only on the disposable emulator. Uses synthetic records, never production accounts. */
public final class StorageProbe extends Instrumentation {
    private Bundle args;
    @Override public void onCreate(Bundle args) { this.args = args; start(); }
    private WebView find(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++) { WebView w=find(((ViewGroup)view).getChildAt(i)); if(w!=null)return w; }
        return null;
    }
    private String evaluate(WebView view, String js) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> value = new AtomicReference<>();
        runOnMainSync(() -> view.evaluateJavascript(js, result -> { value.set(result); done.countDown(); }));
        if (!done.await(15, TimeUnit.SECONDS)) throw new Exception("JavaScript timed out");
        return value.get();
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent intent = new Intent(Intent.ACTION_MAIN).setClassName("com.myxiaoyu.app", "com.myxiaoyu.app.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = startActivitySync(intent);
            AtomicReference<WebView> holder = new AtomicReference<>();
            runOnMainSync(() -> { holder.set(find(activity.getWindow().getDecorView())); WebView.setWebContentsDebuggingEnabled(true); });
            WebView view = holder.get();
            if (view == null) throw new Exception("No WebView");
            boolean seed = "seed".equals(args.getString("mode"));
            boolean legacy = "legacy".equals(args.getString("mode"));
            if (seed || legacy) {
                CountDownLatch loaded = new CountDownLatch(1);
                runOnMainSync(() -> {
                    view.stopLoading();
                    view.setWebViewClient(new WebViewClient() { @Override public void onPageFinished(WebView v,String u){ loaded.countDown(); } });
                    view.loadDataWithBaseURL("https://myxiaoyu.com/", "<html><body>Upgrade fixture</body></html>", "text/html", "UTF-8", "https://myxiaoyu.com/");
                });
                if(!loaded.await(15,TimeUnit.SECONDS)) throw new Exception("Seed page timed out");
            }
            if (seed) {
                evaluate(view, "localStorage.setItem('android_upgrade_probe_v1','story-draft-保留');document.cookie='android_upgrade_probe=kept;path=/;Secure;SameSite=Lax';window.probeDone=false;var r=indexedDB.open('android-upgrade-probe',1);r.onupgradeneeded=()=>r.result.createObjectStore('saves');r.onsuccess=()=>{var t=r.result.transaction('saves','readwrite');t.objectStore('saves').put({text:'synthetic story',turn:7},'story');t.oncomplete=()=>{r.result.close();window.probeDone=true;};};");
                for(int i=0;i<50 && !"true".equals(evaluate(view,"window.probeDone"));i++) Thread.sleep(100);
                if(!"true".equals(evaluate(view,"window.probeDone"))) throw new Exception("Seed database failed");
                runOnMainSync(() -> CookieManager.getInstance().flush());
                result.putString("origin", evaluate(view,"location.origin"));
                result.putString("written", evaluate(view,"localStorage.getItem('android_upgrade_probe_v1')"));
                // Chromium flushes DOM storage asynchronously. Let the old app persist it
                // before instrumentation terminates the process, then cold-read it again.
                Thread.sleep(10000);
                result.putString("seed", "localStorage + IndexedDB + cookie");
            } else {
                String state = "";
                if (!legacy) {
                for(int i=0;i<120;i++) { state=evaluate(view,"JSON.stringify({native:!!window.__XIAOYU_ANDROID__,root:document.getElementById('root')?.children.length||0})"); if(state.contains("true")&&!state.contains("root\\\":0"))break; Thread.sleep(250); }
                if(!state.contains("true")||state.contains("root\\\":0")) throw new Exception("Offline UI failed: " + state);
                }
                String storage=evaluate(view,"localStorage.getItem('android_upgrade_probe_v1')");
                if(!storage.contains("story-draft-保留"))throw new Exception("Local storage changed: " + storage + "; origin=" + evaluate(view,"location.origin"));
                if(!evaluate(view,"document.cookie").contains("android_upgrade_probe=kept"))throw new Exception("Cookie changed");
                evaluate(view,"window.probeValue=null;var r=indexedDB.open('android-upgrade-probe',1);r.onsuccess=()=>{var t=r.result.transaction('saves');var q=t.objectStore('saves').get('story');q.onsuccess=()=>{window.probeValue=q.result; r.result.close();};};");
                String idb="";
                for(int i=0;i<50;i++){idb=evaluate(view,"JSON.stringify(window.probeValue)");if(idb.contains("synthetic story"))break;Thread.sleep(100);}
                if(!idb.contains("synthetic story"))throw new Exception("IndexedDB changed");
                result.putString("upgrade", "PASS: offline React UI, localStorage, cookie, IndexedDB");
                result.putString("state", evaluate(view,"JSON.stringify(window.__XIAOYU_ANDROID__)"));
                result.putString("url", evaluate(view,"location.href"));
            }
            if (args.containsKey("hold")) Thread.sleep(Long.parseLong(args.getString("hold")));
            finish(Activity.RESULT_OK,result);
        } catch(Throwable e) { result.putString("failure", e.toString()); finish(Activity.RESULT_CANCELED,result); }
    }
}
