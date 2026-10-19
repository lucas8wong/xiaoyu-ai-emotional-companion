package com.myxiaoyu.app;

import android.app.*;
import android.content.Intent;
import android.os.Bundle;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;

/** Synthetic HTTPS transport, real signed package. Run against installed 1.0 on the emulator only. */
public final class UpdaterProbe extends Instrumentation {
    private Bundle args;
    private volatile JSONObject manifest;
    private File apk;
    @Override public void onCreate(Bundle args) { this.args=args; start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        AppUpdater updater = null;
        try {
            apk = new File(getTargetContext().getCacheDir(), "fixture.apk");
            byte[] digest; MessageDigest md=MessageDigest.getInstance("SHA-256");
            try(InputStream in=new FileInputStream(apk)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)md.update(b,0,n);} digest=md.digest();
            StringBuilder sha=new StringBuilder();for(byte b:digest)sha.append(String.format("%02x",b&255));
            manifest=new JSONObject().put("schema",1).put("packageId","com.myxiaoyu.app").put("versionCode",2).put("versionName","1.1.0").put("minSdk",24).put("bytes",apk.length()).put("sha256",sha.toString()).put("apkUrl","https://myxiaoyu.com/download/fixture.apk");
            URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
                @Override protected URLConnection openConnection(URL url) {
                    return new HttpURLConnection(url) {
                        public void disconnect(){} public boolean usingProxy(){return false;} public void connect(){}
                        public int getResponseCode(){return 200;}
                        public InputStream getInputStream() throws IOException {
                            return url.getPath().endsWith(".apk") ? new FileInputStream(apk) : new ByteArrayInputStream(manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        }
                    };
                }
            });
            Activity activity=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("com.myxiaoyu.app","com.myxiaoyu.app.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            AtomicReference<String> status=new AtomicReference<>();
            JSONObject config=new JSONObject("{\"backendOrigins\":[\"https://myxiaoyu.com\"],\"downloadOrigins\":[\"https://myxiaoyu.com\"],\"updatePath\":\"/download/android-release.json\"}");
            updater=new AppUpdater(activity,config,patch->{if(patch.has("update"))status.set(patch.optString("update"));});
            updater.check(); await(status,"available"); Thread.sleep(50);
            updater.download(); await(status,"ready"); Thread.sleep(50);
            result.putString("valid", "PASS: manifest, size, SHA-256, package ID, version and installed signing identity");
            manifest.put("sha256","0".repeat(64)); updater.check(); await(status,"available"); Thread.sleep(50); updater.download(); await(status,"failed"); Thread.sleep(50);
            result.putString("corrupt", "PASS: checksum mismatch rejected");
            manifest.put("apkUrl","https://unapproved.example/app.apk"); updater.check(); await(status,"failed"); Thread.sleep(50);
            result.putString("origin", "PASS: unapproved download host rejected");
            manifest.put("apkUrl","https://myxiaoyu.com/download/fixture.apk").put("sha256",sha.toString()).put("versionCode",3);
            updater.check(); await(status,"available"); Thread.sleep(50); updater.download(); await(status,"failed");
            result.putString("version", "PASS: package version mismatch rejected");
            finish(Activity.RESULT_OK,result);
        } catch(Throwable e) { result.putString("failure",e.toString()); finish(Activity.RESULT_CANCELED,result); }
        finally {if(updater!=null)updater.close();}
    }
    private void await(AtomicReference<String> status,String target) throws Exception {
        for(int i=0;i<600;i++){if(target.equals(status.get()))return;Thread.sleep(100);}
        throw new Exception("Expected "+target+", got "+status.get());
    }
}
