import type {Request,Response,NextFunction} from 'express';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {getClientIp} from '../services/geo.js';

const PREFIX='/xhs', COOKIE='xiaoyu_xhs_session';
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function xhsOperator(options:{secret:()=>string; port?:number; origin?:string}) {
  const origin=options.origin||'https://myxiaoyu.com',port=options.port||3188;
  const attempts=new Map<string,{n:number;until:number}>();
  const sign=(value:string)=>createHmac('sha256',options.secret()).update('xhs-session:'+value).digest('hex');
  const valid=(cookie:string)=>{const [exp,nonce,mac,...extra]=cookie.split('.');return !extra.length&&/^\d+$/.test(exp||'')&&Number(exp)>Date.now()&&Number(exp)<Date.now()+8*3600000+10000&&/^[a-f0-9]{32}$/.test(nonce||'')&&equal(mac||'',sign(exp+'.'+nonce));};
  const cookie=(value:string,age:number)=>`${COOKIE}=${value}; Path=/xhs; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
  const login=(res:Response,error=false)=>res.status(error?401:200).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录小红书运营台</title><style>body{margin:0;background:#f5faf7;color:#243b2e;font:16px system-ui,sans-serif}main{max-width:360px;margin:12vh auto;padding:28px;background:white;border:1px solid #dce9df;border-radius:18px}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:12px;border:1px solid #cfdfd4;border-radius:8px;font:inherit}button{background:#178353;color:white;cursor:pointer}p{line-height:1.7;color:#52665a}.error{color:#a44010}a{color:#178353}</style><main><h1>小红书运营台</h1><p>输入现有 admin 管理口令。运营服务由本机运行，电脑需保持开机。</p>${error?'<p class="error">口令不正确或会话已过期，请重新登录。</p>':''}<form method="post" action="/xhs/login"><label for="token">管理口令</label><input id="token" name="token" type="password" required maxlength="512" autocomplete="current-password"><button>进入运营台</button></form><p><a href="/admin.html">返回管理控制台</a></p></main></html>`);
  return (req:Request,res:Response,next:NextFunction)=>{
    const raw=req.url;
    if(raw!==PREFIX&&!raw.startsWith(PREFIX+'/')&&!raw.startsWith(PREFIX+'?'))return next();
    res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(!options.secret())return void res.status(503).send('运营台管理鉴权尚未配置');
    const pathname=raw.split('?')[0];
    if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(req.method))return void res.status(405).end();
    // Validate the external origin before replacing upstream headers. Never trust forwarded origin/host.
    if((req.headers.origin&&req.headers.origin!==origin)||(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin))return void res.status(403).send('不接受跨站操作');
    if(pathname===PREFIX+'/login'&&req.method==='POST'){
      const now=Date.now();for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
      const ip=getClientIp(req);const limit=attempts.get(ip)||{n:0,until:now+900000};
      if(limit.n>=10||attempts.size>10000){res.setHeader('Retry-After','900');return void res.status(429).send('登录尝试过多，请十五分钟后再试');}
      limit.n++;attempts.set(ip,limit);
      if(!String(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return void res.status(415).end();
      let body='',tooLarge=false;req.setEncoding('utf8');
      req.on('data',chunk=>{if(tooLarge)return;body+=chunk;if(Buffer.byteLength(body)>4096){tooLarge=true;res.status(413).end();}});
      req.on('end',()=>{if(tooLarge)return;const supplied=new URLSearchParams(body).get('token')||'';
        if(!equal(supplied,options.secret()))return void login(res,true);
        attempts.delete(ip);const payload=(Date.now()+8*3600000)+'.'+randomBytes(16).toString('hex');
        res.setHeader('Set-Cookie',cookie(payload+'.'+sign(payload),28800));res.redirect(303,PREFIX+'/');
      });return;
    }
    const session=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
    if(!valid(session)){
      if((pathname===PREFIX||pathname===PREFIX+'/')&&['GET','HEAD'].includes(req.method))return void login(res);
      return void res.status(401).json({error:'运营台登录已过期，请重新打开 /xhs/ 登录'});
    }
    if(pathname===PREFIX+'/logout'&&req.method==='POST'){res.setHeader('Set-Cookie',cookie('',0));return void res.redirect(303,PREFIX+'/');}
    if(pathname===PREFIX)return void res.redirect(308,PREFIX+'/');
    const target=raw.slice(PREFIX.length);
    if(!/^\/(?:$|\?|api(?:\/|\?|$)|media\/|assets\/|compat\.js(?:\?|$))/.test(target)||/[\\\r\n]/.test(target))return void res.status(404).end();
    const headers:Record<string,string>={host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`};
    for(const name of ['content-type','content-length','accept','x-csrf-token','last-event-id','range'])if(typeof req.headers[name]==='string')headers[name]=req.headers[name] as string;
    const upstream=httpRequest({hostname:'127.0.0.1',port,path:target,method:req.method,headers},reply=>{
      res.statusCode=reply.statusCode||502;
      for(const name of ['content-type','content-length','content-disposition','content-range','accept-ranges','content-security-policy'])if(reply.headers[name])res.setHeader(name,reply.headers[name]!);
      res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Accel-Buffering','no');reply.pipe(res);
    });
    upstream.setTimeout(180000,()=>upstream.destroy(new Error('upstream timeout')));
    upstream.on('error',()=>{if(!res.headersSent)res.status(503).json({error:'运营台本机服务暂时离线，请确认电脑和运营台服务正在运行'});else res.end();});
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
  };
}
