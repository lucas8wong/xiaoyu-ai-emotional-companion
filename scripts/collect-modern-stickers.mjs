/** Download the user's approved A/C/D/E/F/G/H/I families into a PRIVATE local bundle.
 * node scripts/collect-modern-stickers.mjs --dry-run
 * node scripts/collect-modern-stickers.mjs --apply
 * Public availability is not commercial redistribution permission. Never publishes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const apply = process.argv.includes('--apply');
if (apply && process.argv.includes('--dry-run')) throw Error('Choose --apply or --dry-run');
if (process.argv.slice(2).some(a => !['--apply', '--dry-run'].includes(a))) throw Error('Unknown option');
const base = path.resolve('resources/stickers-modern/2026-10-25');
const cache = path.resolve('temp/sticker-modern/http');
if(apply){
 try{
  const existing=JSON.parse(await fs.readFile(path.join(base,'catalog.json'),'utf8'));
  if(existing.scenes)throw Error('Curated bundle already exists; use a new version directory to refresh, never overwrite its catalog.');
 }catch(e){if(e.code!=='ENOENT')throw e;}
}
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
const sources = [
  { id:'opossum', family:'C', name:'背手负鼠', repo:'zhaoolee/ChineseBQB', ref:'d675832ad842413679dd4a132bbfa3c311057119', select:p=>p.startsWith('109_Opossum_') && /\.(png|jpg|gif)$/i.test(p) && !/跳了|干掉|把老板锁|干票大的/.test(p) },
  { id:'penguin', family:'D', name:'高雅企鹅', repo:'Moeary/Penguin-Meme-Maker', ref:'0e929eae3511f4174ff544dc8dfb049d1ed1b92e', select:p=>p.startsWith('public/meme-base/') && /\.webp$/i.test(p) },
  { id:'maltese', family:'E', name:'线条小狗', repo:'remake1026/desktop-pets', ref:'0529f64b521f32e28140bb3d07d0985ef905a7da', select:p=>/^源码\/assets\/(520|521|after-work|good|heart|jump|mealtime|music-dance|music|send|sleep|sleepy|sleepy2|special|turn on)\.gif$/.test(p) },
  { id:'nailong', family:'I', name:'抽象奶龙', repo:'GeorgeNaNN/nailong-memes', ref:'faff7a463622d83bfd4ef62e04220675b41db49d', select:p=>/^(gif|images)\//.test(p) && /\.(png|jpg|webp|gif)$/i.test(p) },
];
const jobs = [];
const allowedHosts = new Set(['api.github.com','raw.githubusercontent.com','s3.getstickerpack.com','n.sinaimg.cn','k.sinaimg.cn','k.sina.cn','k.sina.com.cn','imgs.qiubiaoqing.com','pbs.twimg.com','media.chineseherald.co.nz']);
await fs.mkdir(cache,{recursive:true});
async function download(url) {
  const u = new URL(url);
  if(u.protocol !== 'https:' || !allowedHosts.has(u.hostname)) throw Error(`Unapproved asset host: ${u.hostname}`);
  const file = path.join(cache,digest(url));
  try{return await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  const r=await fetch(url,{signal:AbortSignal.timeout(45000),redirect:'error'});
  if(!r.ok)throw Error(`HTTP ${r.status}: ${url}`);
  const b=Buffer.from(await r.arrayBuffer());
  if(!b.length||b.length>16*1024*1024)throw Error(`Asset exceeds bounded size: ${url}`);
  await fs.writeFile(file,b);
  return b;
}
const raw=(s,p)=>`https://raw.githubusercontent.com/${s.repo}/${s.ref}/${p.split('/').map(encodeURIComponent).join('/')}`;
for(const s of sources){
  const t=JSON.parse(await download(`https://api.github.com/repos/${s.repo}/git/trees/${s.ref}?recursive=1`));
  if(t.truncated||!Array.isArray(t.tree))throw Error(`Incomplete tree: ${s.id}`);
  const images=t.tree.filter(x=>s.select(x.path));
  images.forEach((x,i)=>jobs.push({sourceId:s.id,family:s.family,sourcePage:`https://github.com/${s.repo}/tree/${s.ref}`,url:raw(s,x.path),title:path.basename(x.path).replace(/\.[^.]+$/,''),order:i+1}));
}
for(const [id,family,name,slug,count] of [
 ['cats','A','猫咪嘴替','cat-memes',10],
 ['peach','F','蜜桃猫与灰猫','peach-and-goma',28],
 ['bears','G','小熊一二和布布','xiao-xiong-yi-er-he-bu-bu-credits-to-huang-xiaob',30],
]){
  sources.push({id,family,name,url:`https://getstickerpack.com/stickers/${slug}`});
  for(let n=1;n<=count;n++)jobs.push({sourceId:id,family,sourcePage:`https://getstickerpack.com/stickers/${slug}`,url:`https://s3.getstickerpack.com/storage/uploads/sticker-pack/${slug}/sticker_${n}.png`,title:`${name} ${n}`,order:n});
}
const articles=[
 ['capy','H','水豚噜噜','https://k.sina.com.cn/article_3058542253_b64da6ad04001f62o.html','20250323'],
 ['capy','H','水豚噜噜','https://k.sina.cn/article_3058542253_b64da6ad04001fbio.html','20250422'],
];
sources.push({id:'capy',family:'H',name:'水豚噜噜',url:articles[0][3]});
for(const [sourceId,family,name,url,date] of articles){
 const html=(await download(url)).toString();
 const urls=[...new Set([...html.matchAll(/(?:src|data-src)=["']([^"']+)["']/g)].map(m=>m[1]).filter(u=>u.includes(date)&&/\.gif(?:[?#]|$)/i.test(u)).map(u=>u.replace(/^http:/,'https:')))];
 urls.forEach((u,i)=>jobs.push({sourceId,family,sourcePage:url,url:u,title:`${name} ${date}-${i+1}`,order:jobs.filter(j=>j.sourceId===sourceId).length+1}));
}
const selected=[
 ['cats','A','看起来淡定，其实是没招了','https://k.sina.com.cn/article_7879776328_1d5abd84806801ehfe.html','https://k.sinaimg.cn/n/sinakd20260328ac/314/w557h557/20260328/3e14-fa5f6c36f11529802bbec70841f654e7.jpg/w700d1q75cms.jpg'],
 ['cats','A','小猫扔番茄','https://x.com/TrillinDaGame/status/1970468095698547083','https://pbs.twimg.com/media/G1bLOiJXwAA46QT.jpg'],
 ['maltese','E','抱抱贴贴','https://www.qiubiaoqing.com/img_detail/672073434271842742.html','https://imgs.qiubiaoqing.com/qiubiaoqing/user_pre_up_imgs/66d8651125dadAUB.gif'],
 ['maltese','E','靠在一起陪伴','https://www.qiubiaoqing.com/img_detail/743786238225418809.html','https://imgs.qiubiaoqing.com/qiubiaoqing/imgs/67dd48a9e25cakY3.gif'],
 ['maltese','E','害羞托脸','https://www.qiubiaoqing.com/img_detail/744555098172031130.html','https://imgs.qiubiaoqing.com/qiubiaoqing/imgs/67e014cb6dc87zJ3.gif'],
];
for(const [sourceId,family,title,sourcePage,url] of selected)jobs.push({sourceId,family,title,sourcePage,url,order:jobs.filter(j=>j.sourceId===sourceId).length+1});
console.log(JSON.stringify({mode:apply?'apply':'dry-run',candidates:jobs.length,byFamily:Object.fromEntries(['A','C','D','E','F','G','H','I'].map(f=>[f,jobs.filter(j=>j.family===f).length]))}));
if(!apply)process.exit(0);
await fs.mkdir(path.join(base,'assets'),{recursive:true});
await fs.mkdir(path.join(base,'source-notices'),{recursive:true});
for(const s of sources.filter(s=>s.repo)){
 for(const p of ['README.md',...(s.id==='opossum'?[]:[s.id==='penguin'?'License':'LICENSE'])]){
  try{await fs.writeFile(path.join(base,'source-notices',`${s.id}-${p}`),await download(raw(s,p)));}
  catch(e){console.warn(`Notice unavailable: ${s.id}/${p}: ${e.message}`);}
 }
}
sharp.cache(false);sharp.concurrency(1);
const assets=[],failed=[];let cursor=0,done=0;
async function convert(j){
 const input=await download(j.url),originalSha256=digest(input);
 const meta=await sharp(input,{animated:true,limitInputPixels:256*1024*1024}).metadata();
 const apng=meta.format==='png'&&input.includes(Buffer.from('acTL'));
 const animated=apng||(meta.pages||1)>1;
 if((meta.pages||1)>300)throw Error('Long animation exceeds sticker frame budget');
 const filename=`${j.sourceId}-${String(j.order).padStart(3,'0')}-${originalSha256.slice(0,10)}`;
 const id=filename;
 let encoded=apng?input:await sharp(input,{animated:true}).resize({width:384,height:384,fit:'inside',withoutEnlargement:true}).webp({quality:82,effort:4,loop:meta.loop??0}).toBuffer();
 if(!apng&&encoded.length>768*1024)encoded=await sharp(input,{animated:true}).resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).webp({quality:72,effort:5,loop:meta.loop??0}).toBuffer();
 if(encoded.length>3*1024*1024)throw Error('Compressed image exceeds sticker size budget');
 const sha256=digest(encoded),file=`assets/${filename}-${sha256.slice(0,10)}.${apng?'png':'webp'}`;
 await fs.writeFile(path.join(base,file),encoded);
 const info=await sharp(encoded,{animated:true}).metadata();
 let posterFile;
 if(animated){const poster=await sharp(input).resize({width:384,height:384,fit:'inside',withoutEnlargement:true}).webp({quality:84}).toBuffer();posterFile=`assets/${filename}-poster-${digest(poster).slice(0,10)}.webp`;await fs.writeFile(path.join(base,posterFile),poster);}
 return {id,sourceId:j.sourceId,family:j.family,order:j.order,title:j.title,alt:j.title,file,url:`/stickers/${file}`,posterFile,posterUrl:posterFile?`/stickers/${posterFile}`:undefined,contexts:['chat','moments'],categories:['needs-review'],tags:[],style:j.sourceId,rightsStatus:'unverified',publicationAllowed:false,review:'pending-visual-classification',sourcePage:j.sourcePage,sourceUrl:j.url,sha256,originalSha256,bytes:encoded.length,originalBytes:input.length,width:info.width,height:info.pageHeight||info.height,animated,frames:apng?input.readUInt32BE(input.indexOf(Buffer.from('acTL'))+4):info.pages||1};
}
await Promise.all(Array.from({length:3},async()=>{while(cursor<jobs.length){const j=jobs[cursor++];try{assets.push(await convert(j));}catch(e){failed.push({sourceId:j.sourceId,order:j.order,url:j.url,error:e.message});}done++;if(done%50===0)console.log(`Saved ${done}/${jobs.length}`);}}));
assets.sort((a,b)=>a.family.localeCompare(b.family)||a.order-b.order);
const seen=new Set();const unique=assets.filter(a=>{if(seen.has(a.originalSha256))return false;seen.add(a.originalSha256);return true;});
const records=sources.map(({select:_select,...s})=>({...s,rightsStatus:'unverified',note:'Repository/site availability does not establish permission for commercial character redistribution.'}));
const catalog={schemaVersion:1,version:'2026-10-25.2',purpose:'private-local-collection',sources:records,assets:unique};
await fs.writeFile(path.join(base,'catalog.json'),JSON.stringify(catalog,null,2));
await fs.writeFile(path.join(base,'download-failures.json'),JSON.stringify(failed,null,2));
const report={candidates:jobs.length,saved:assets.length,unique:unique.length,animated:unique.filter(a=>a.animated).length,failed:failed.length,originalBytes:unique.reduce((n,a)=>n+a.originalBytes,0),compressedBytes:unique.reduce((n,a)=>n+a.bytes,0),byFamily:Object.fromEntries(['A','C','D','E','F','G','H','I'].map(f=>[f,unique.filter(a=>a.family===f).length]))};
await fs.writeFile(path.join(base,'summary.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(base,'SOURCE-RIGHTS.txt'),'Private local collection of user-approved A/C/D/E/F/G/H/I families.\nNot a commercial reuse license. No automatic public publication.\nEvery asset retains its source and SHA-256. Existing source notices are retained.\nSigStick bulk collection was excluded under its terms; Tenor was not used as a download source.\n');
console.log(JSON.stringify(report));
