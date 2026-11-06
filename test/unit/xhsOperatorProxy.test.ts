import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createServer, type Server} from 'node:http';
import {xhsOperator} from '../../api/middleware/xhsOperator.js';
const listen=(s:Server)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r((s.address() as any).port)));
const close=(s:Server)=>new Promise<void>(r=>{s.closeAllConnections();s.close(()=>r());});
test('operator gateway authenticates every resource, blocks cross-site writes, forwards body and streams without forwarding credentials',async()=>{
 let hits=0,seen:any;
 const upstream=createServer((req,res)=>{hits++;let body='';req.on('data',x=>body+=x);req.on('end',()=>{seen={headers:req.headers,url:req.url,body};if(req.url==='/api/events'){res.setHeader('Content-Type','text/event-stream');res.write('data: first\n\n');setTimeout(()=>res.end('data: last\n\n'),20);}else res.end(JSON.stringify({ok:true}));});});
 const port=await listen(upstream), app=express();let secret='isolated-admin-secret';
 app.use(xhsOperator({secret:()=>secret,port}));app.use((_q,r)=>r.status(404).end());const server=createServer(app), url='http://127.0.0.1:'+await listen(server);
 const origin='https://myxiaoyu.com';
 try{
  const page=await fetch(url+'/xhs/');assert.equal(page.status,200);
  assert.equal(page.headers.get('referrer-policy'),'same-origin');
  for(const path of ['/api/state','/media/private','/assets/app.js','/compat.js'])assert.equal((await fetch(url+'/xhs'+path)).status,401);
  assert.equal(hits,0);
  const login=await fetch(url+'/xhs/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:secret})});
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);const session=cookie.split(';')[0];
  assert.equal((await fetch(url+'/xhs/api/state',{headers:{cookie:session+'bad'}})).status,401);
  assert.equal((await fetch(url+'/xhs/api/state',{method:'POST',headers:{cookie:session,origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(url+'/xhs/api/state',{method:'POST',headers:{cookie:session}})).status,403);
  assert.equal((await fetch(url+'/xhs/login',{method:'POST',headers:{origin:'null','content-type':'application/x-www-form-urlencoded'},body:'token='+secret})).status,403);
  const r=await fetch(url+'/xhs/api/assets?test=1',{method:'POST',headers:{origin,cookie:session,'content-type':'multipart/form-data; boundary=test','x-csrf-token':'csrf','authorization':'Bearer must-not-forward','x-forwarded-host':'evil'},body:'--test\r\nfixture\r\n--test--'});
  assert.equal(r.status,200);assert.equal(seen.url,'/api/assets?test=1');assert.match(seen.body,/fixture/);assert.equal(seen.headers.cookie,undefined);assert.equal(seen.headers.authorization,undefined);assert.equal(seen.headers['x-forwarded-host'],undefined);assert.equal(seen.headers.origin,'http://127.0.0.1:'+port);assert.equal(seen.headers['x-csrf-token'],'csrf');
  const stream=await fetch(url+'/xhs/api/events',{headers:{cookie:session}});assert.match(stream.headers.get('cache-control')!,/no-store/);assert.match(await stream.text(),/data: first[\s\S]*data: last/);
  secret='rotated';assert.equal((await fetch(url+'/xhs/api/state',{headers:{cookie:session}})).status,401);
  secret='';assert.equal((await fetch(url+'/xhs/')).status,503);
 }finally{await close(server);await close(upstream);}
});
test('operator login rate limits failures and never sends the supplied password back',async()=>{
 const app=express();app.use(xhsOperator({secret:()=>'fixture'}));const server=createServer(app),url='http://127.0.0.1:'+await listen(server);
 try{for(let i=0;i<10;i++){const r=await fetch(url+'/xhs/login',{method:'POST',headers:{origin:'https://myxiaoyu.com','content-type':'application/x-www-form-urlencoded'},body:'token=wrong-private'});assert.equal(r.status,401);assert.doesNotMatch(await r.text(),/wrong-private/);}assert.equal((await fetch(url+'/xhs/login',{method:'POST',headers:{origin:'https://myxiaoyu.com'}})).status,429);}finally{await close(server);}
});
