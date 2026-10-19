import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupTempCwd } from './setup.js';
setupTempCwd();process.env.PERSISTENCE_PROVIDER='file';
const { requestClientSource, clientDate, mergeClientUsage, clientUsageStats } = await import('../../api/services/clientSource.js');
const { UsageTimeStore } = await import('../../api/services/usageTime.js');
const { PresenceStore } = await import('../../api/services/presence.js');

test('source identifies delivery channel, iOS home-screen, beacon fallback and legacy APK; unknown is never guessed',()=>{
  const source=(headers:Record<string,string>,body:any={})=>requestClientSource({headers,body});
  assert.deepEqual(source({'user-agent':'Mozilla/5.0 Android Chrome/130','x-xiaoyu-client':'web'}),{kind:'web'});
  assert.deepEqual(source({'user-agent':'Mozilla/5.0 XiaoyuAndroid/1.1'}),{kind:'android-app'});
  assert.deepEqual(source({'x-xiaoyu-client':'ios-home'}),{kind:'ios-home'});
  assert.deepEqual(source({}, {client:'ios-web'}),{kind:'ios-web'});
  assert.deepEqual(source({'x-xiaoyu-client':'web'}, {client:'android-app'}),{kind:'web'});
  assert.deepEqual(source({'x-xiaoyu-client':'android-app','x-xiaoyu-version':'1.1.6'}),{kind:'android-app',version:'1.1.6'});
  assert.deepEqual(source({'x-xiaoyu-client':'android-app','x-xiaoyu-version':'<unsafe>'}),{kind:'android-app'});
  assert.deepEqual(source({'user-agent':'Mozilla/5.0 iPhone Safari/600'}),{kind:'unknown'});
  assert.deepEqual(source({'x-xiaoyu-client':'ios-native'}),{kind:'unknown'});
  assert.equal(clientDate(Date.UTC(2026,9,19,16)), '2026-10-20');
});

test('channel ledger preserves old daily values, separates explicit login, survives reload/merge/deletion',()=>{
  const day=clientDate(Date.now());
  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync('data/usage-time.json',JSON.stringify([{userId:'old',daily:{[day]:120},lastAt:7}]));
  const store=new UsageTimeStore();
  assert.deepEqual(store.getClientRange('old',day,day).map(r=>[r.kind,r.seconds]),[['unknown',120]]);
  store.addActiveTime('old',30,{kind:'web'});
  store.addActiveTime('old',60,{kind:'android-app',version:'1.1.6'});
  store.recordClientLogin('old',{kind:'android-app',version:'1.1.6'});
  store.recordClientLogin('only-login',{kind:'ios-home'});
  const rows=store.getClientRange('old',day,day);
  assert.deepEqual(rows.map(r=>[r.kind,r.seconds,r.logins]),[['web',30,0],['android-app',60,1],['unknown',120,0]]);
  assert.equal(store.getUserLifetime('old'),210);
  assert.equal(store.getUserLifetime('only-login'),0);
  const restored=new UsageTimeStore();assert.deepEqual(restored.getClientRange('old',day,day),rows);
  assert.equal(restored.getClientRange('only-login',day,day)[0].logins,1);
  restored.addActiveTime('guest',15,{kind:'ios-web'});restored.mergeUsers('guest','old');
  assert.equal(restored.getUserLifetime('old'),225);assert.deepEqual(restored.getClientRange('guest',day,day),[]);
  assert.equal(restored.getClientRange('old',day,day).find(r=>r.kind==='ios-web')?.seconds,15);
  restored.deleteUser('old');assert.deepEqual(new UsageTimeStore().getClientRange('old',day,day),[]);
  assert.equal(new UsageTimeStore().getClientRange('only-login',day,day)[0].logins,1);
});

test('one account online on two clients stays one person; each client expires independently',()=>{
  const store=new PresenceStore();store.clear();const at=Date.now();
  store.touch('same',{account:true,source:{kind:'web'}},at);
  store.touch('same',{account:true,source:{kind:'android-app',version:'1.1.6'}},at+1000);
  store.touch('guest-a',{deviceKey:'same-device',source:{kind:'ios-home'}},at+1000);
  store.touch('guest-b',{deviceKey:'same-device',source:{kind:'ios-home'}},at+2000);
  let snap=store.snapshot(at+2000);assert.equal(snap.online,2);assert.equal(snap.accounts,1);
  assert.equal(snap.clients.web.online,1);assert.equal(snap.clients['android-app'].online,1);assert.equal(snap.clients['ios-home'].guests,1);
  assert.equal(store.list(at+2000).find(u=>u.id==='same')?.clients.length,2);
  snap=store.snapshot(at+90_001);assert.equal(snap.clients.web.online,0);assert.equal(snap.clients['android-app'].online,1);
  assert.equal(store.list(at+90_001).find(u=>u.id==='same')?.clients[0].kind,'android-app');
  store.clear();
});

test('source aggregates keep all aliases, unknown history and distinct login-account counts',()=>{
  const rows=mergeClientUsage([
    {kind:'web',seconds:20,logins:1,lastAt:1,lastLoginAt:1},
    {kind:'web',seconds:30,logins:2,lastAt:2,lastLoginAt:2},
    {kind:'android-app',seconds:40,logins:1,lastAt:3,lastLoginAt:3},
  ]);
  const stats=clientUsageStats([{account:true,clientUsage:rows}]);
  assert.equal(stats.find(r=>r.kind==='web')?.logins,3);
  assert.equal(stats.find(r=>r.kind==='web')?.loginAccounts,1);
  assert.equal(stats.find(r=>r.kind==='android-app')?.accounts,1);
  assert.equal(stats.reduce((n,r)=>n+r.seconds,0),90);
});
