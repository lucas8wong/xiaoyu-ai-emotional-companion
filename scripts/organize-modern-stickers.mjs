/** Curate the private download; never publishes third-party media. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { modernStickerScenes, classifyModernSticker } from './lib/modernStickerScenes.mjs';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(a => !['--apply', '--verify'].includes(a))) throw Error('Unknown option');
const base = path.resolve('resources/stickers-modern/2026-10-25');
const archive = path.resolve('temp/sticker-modern/raw-import');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const json = (f,v) => fs.writeFile(f,JSON.stringify(v,null,2)+'\n');
const safe = (root,rel) => {
  const file=path.resolve(root,rel);
  if (!file.startsWith(root+path.sep)) throw Error('Path outside bundle');
  return file;
};
const families={A:'真实猫狗反应',C:'背手负鼠',D:'高雅企鹅',E:'线条小狗',F:'蜜桃猫与灰猫',G:'小熊一二和布布',H:'水豚噜噜',I:'抽象奶龙'};
if(apply){
 await fs.mkdir(archive,{recursive:true});
 try{await fs.copyFile(path.join(base,'catalog.json'),path.join(archive,'catalog.json'),fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
 const raw=JSON.parse(await fs.readFile(path.join(archive,'catalog.json'),'utf8'));
 const assets=[];
 for(const a of raw.assets){
  const c=classifyModernSticker(a); if(!c)continue;
  const scenes=[...new Set(c.scenes)];
  assert.ok(scenes.length&&scenes.every(id=>modernStickerScenes.some(s=>s.id===id)),a.id);
  const item={...a,title:c.title,titleZh:c.title,alt:c.title,categories:scenes,
   tags:[...new Set([families[a.family],c.title,...modernStickerScenes.filter(s=>scenes.includes(s.id)).flatMap(s=>s.keywords)])],
   review:a.animated?'poster-reviewed-animation-decoded':'static-reviewed',license:'Unverified third-party character rights',rightsStatus:'unverified',publicationAllowed:false};
  for(const field of ['file','posterFile']){
   if(!a[field])continue;
   item[field]=`scenes/${scenes[0]}/${path.basename(a[field])}`;
   const dest=safe(base,item[field]);await fs.mkdir(path.dirname(dest),{recursive:true});
   let from=safe(base,a[field]);
   try{await fs.access(from);}catch{from=safe(archive,a[field]);}
   await fs.copyFile(from,dest);
  }
  assets.push(item);
 }
 const catalog={...raw,version:'2026-10-25.2',purpose:'Private curated source bank for chat and Moments; rights clearance required for publication',families,scenes:modernStickerScenes,assets};
 await json(path.join(base,'catalog.json'),catalog);
 const byFamily=Object.fromEntries(Object.keys(families).map(k=>[k,assets.filter(a=>a.family===k).length]));
 const byScene=Object.fromEntries(modernStickerScenes.map(s=>[s.id,assets.filter(a=>a.categories.includes(s.id)).length]));
 await fs.mkdir(path.join(base,'scene-index'),{recursive:true});
 for(const s of modernStickerScenes)await json(path.join(base,'scene-index',s.id+'.json'),{...s,ids:assets.filter(a=>a.categories.includes(s.id)).map(a=>a.id)});
 const summary={version:catalog.version,downloadedUnique:raw.assets.length,curated:assets.length,animated:assets.filter(a=>a.animated).length,byFamily,byScene,originalBytes:assets.reduce((n,a)=>n+a.originalBytes,0),compressedBytes:assets.reduce((n,a)=>n+a.bytes,0),publicationAllowed:false};
 await json(path.join(base,'summary.json'),summary);
 await json(path.join(base,'excluded.json'),raw.assets.filter(a=>!assets.some(b=>a.id===b.id)).map(a=>({id:a.id,sourceUrl:a.sourceUrl,reason:a.family==='D'?'Unused repetitive template':'Excluded during visual review'})));
 const data=JSON.stringify({assets,families,scenes:modernStickerScenes}).replace(/</g,'\\u003c');
 await fs.writeFile(path.join(base,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>现代聊天表情库</title><style>body{font:16px system-ui;background:#FBF6EE;color:#243B2E;margin:24px}header{max-width:900px}select,input,button{font:inherit;padding:10px;margin:6px 8px 6px 0;max-width:100%;box-sizing:border-box}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-top:20px}figure{margin:0;background:white;padding:12px;border-radius:14px}img{width:100%;height:150px;object-fit:contain}figcaption{overflow-wrap:anywhere}a{color:#178353}:focus-visible{outline:3px solid #1FA46B}</style><header><h1>现代聊天表情库</h1><p>${assets.length} 张精选，聊天与朋友圈共用场景索引。媒体仅本地保存，品牌角色的产品再分发授权待核实。</p><label>场景 <select id="scene"><option value="">全部场景</option></select></label><label>系列 <select id="family"><option value="">全部系列</option></select></label><label>搜索 <input id="query" placeholder="抱抱、晚安、吃瓜…"></label><label><input id="motion" type="checkbox">播放动图</label><p id="count" role="status"></p></header><main id="grid"></main><script>const data=${data};const $=id=>document.getElementById(id);for(const s of data.scenes)$('scene').add(new Option(s.zh,s.id));for(const [id,name] of Object.entries(data.families))$('family').add(new Option(name,id));function render(){const q=$('query').value.trim().toLowerCase(),rows=data.assets.filter(a=>(!$('scene').value||a.categories.includes($('scene').value))&&(!$('family').value||a.family===$('family').value)&&(!q||[a.title,...a.tags].join(' ').toLowerCase().includes(q)));$('grid').replaceChildren();$('count').textContent=rows.length+' 张';for(const a of rows){const f=document.createElement('figure'),im=document.createElement('img'),cap=document.createElement('figcaption'),link=document.createElement('a');im.src=!$('motion').checked&&a.posterFile?a.posterFile:a.file;im.alt=a.alt;im.loading='lazy';cap.textContent=a.title+' · '+data.families[a.family]+' ';link.href=a.sourcePage;link.textContent='出处';link.rel='noreferrer';link.target='_blank';cap.append(link);f.append(im,cap);$('grid').append(f)}}for(const id of ['scene','family','query','motion'])$(id).addEventListener('input',render);render();</script></html>`);
 await fs.writeFile(path.join(base,'README.txt'),`现代表情精选库 ${catalog.version}\n打开 index.html 离线预览。scenes/ 按主场景存放原图，scene-index/ 提供多场景交叉索引；无重复复制。\n聊天与朋友圈共用同一 catalog.json。动图保留动画，posterFile 为静态预览。\n所有第三方角色当前为 unverified / publicationAllowed=false，不代表已取得商业再分发授权。出处逐张保存在 catalog.json，来源说明在 source-notices/ 和 SOURCE-RIGHTS.txt。\n已剔除旧 Fluent/Blob/Blobfox 库；未修改聊天、朋友圈或用户记录。\n`);
 // Keep rejected raw downloads outside the deliverable, with an exact checked target.
 const rawAssets=path.join(base,'assets'),archiveAssets=path.join(archive,'assets');
 try{await fs.access(rawAssets);try{await fs.access(archiveAssets);throw Error('Archive already exists');}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rename(rawAssets,archiveAssets);}catch(e){if(e.code!=='ENOENT')throw e;}
 console.log(JSON.stringify(summary));
}
if(process.argv.includes('--verify')){
 sharp.cache(false);sharp.concurrency(1);
 const c=JSON.parse(await fs.readFile(path.join(base,'catalog.json'),'utf8'));
 assert.equal(new Set(c.assets.map(a=>a.id)).size,c.assets.length);
 assert.equal(new Set(c.assets.map(a=>a.sha256)).size,c.assets.length);
 let fileBytes=0,animated=0;
 for(const a of c.assets){
  assert.deepEqual(a.contexts,['chat','moments']);assert.equal(a.publicationAllowed,false);
  assert.equal(a.rightsStatus,'unverified');assert.ok(!/sigstick|tenor/i.test(a.sourceUrl));
  assert.ok(a.categories.length&&a.tags.length);assert.ok(!a.categories.includes('needs-review'));
  const b=await fs.readFile(safe(base,a.file));fileBytes+=b.length;
  assert.equal(hash(b),a.sha256,a.id);assert.equal(b.length,a.bytes,a.id);
  const m=await sharp(b,{animated:true}).metadata();
  assert.equal(m.width,a.width,a.id);assert.equal(m.pageHeight||m.height,a.height,a.id);
  await sharp(b,{animated:true}).raw().toBuffer();
  if(a.animated){animated++;assert.ok(a.posterFile,a.id);const p=await fs.readFile(safe(base,a.posterFile));fileBytes+=p.length;assert.equal((await sharp(p,{animated:true}).metadata()).pages||1,1,a.id);await sharp(p).raw().toBuffer();}
 }
 assert.deepEqual([...new Set(c.assets.map(a=>a.family))].sort(),Object.keys(families).sort());
 const report={checked:c.assets.length,animated,fileBytes,sha256Verified:true,allFramesDecoded:true,privateOnly:true};
 await json(path.resolve('temp/sticker-modern/verification.json'),report);console.log(JSON.stringify(report));
}
