/** Operator-requested use of the reviewed private bundle; no claim of IP licensing.
 * Text is authoritative. Missing media or selection failure can never fail a reply.
 * No extra model call, prompt token, quota charge, persistent store or hidden timer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CharacterSticker } from '../../src/lib/characterSticker.js';
import { toZhSimple } from './zhConvert.js';

type StickerRelation = 'friend' | 'buddy' | 'family' | 'lover';
interface StickerPersona {
  id: string; identity: string; voice: string; boundaries: string;
  story?: { scenarioTitle: string }; storyMode?: 'in' | 'out'; relation?: StickerRelation;
}

export interface StickerCandidate {
  id: string; family: string; title: string; categories: string[];
  file: string; posterFile?: string; width: number; height: number; animated: boolean;
}
export interface StickerHistory {
  content?: string; role?: string; timestamp?: Date | string; at?: number;
  sticker?: CharacterSticker; characterId?: string;
}
export interface StickerSelection {
  context: 'chat' | 'moments'; userId: string; character: StickerPersona;
  relation?: StickerRelation | null; text: string; userText?: string;
  history: StickerHistory[]; now: number; seed: string; hasOtherMedia?: boolean;
}
const VERSION = '2026-10-25.2';
const ROOT = () => path.resolve(process.env.CHARACTER_STICKER_ROOT || 'resources/stickers-modern/2026-10-25');
const families = new Set(['A','C','D','E','F','G','H','I']);
let cache: { root: string; at: number; assets: StickerCandidate[]; files: Map<string,string> } | undefined;

function bank() {
  const root=ROOT();
  if (cache?.root===root && Date.now()-cache.at<5000) return cache;
  const assets: StickerCandidate[]=[]; const files=new Map<string,string>();
  try {
    const parsed=JSON.parse(fs.readFileSync(path.join(root,'catalog.json'),'utf8'));
    const approval=JSON.parse(fs.readFileSync(path.join(root,'runtime-approval.json'),'utf8'));
    if(approval.version!==VERSION||approval.allowInApp!==true||!Array.isArray(approval.ids))throw Error('No matching in-app deployment configuration');
    const enabled=new Set(approval.ids);
    if(parsed.version!==VERSION || !Array.isArray(parsed.assets) || parsed.assets.length>1000) throw Error('Unsupported private sticker manifest');
    for(const a of parsed.assets as StickerCandidate[]) {
      if(!enabled.has(a.id)||!families.has(a.family)||!Array.isArray(a.categories)||!a.categories.length||a.categories.includes('needs-review')
        ||!a.id||!a.title||a.title.length>160||!a.file||a.animated&&!a.posterFile)continue;
      const paths=[a.file,...(a.posterFile?[a.posterFile]:[])];
      if(!paths.every(rel=>/^scenes\/[a-z-]+\/[a-z0-9-]+\.(webp|png)$/.test(rel)
        && path.resolve(root,rel).startsWith(root+path.sep) && fs.statSync(path.resolve(root,rel)).isFile())) continue;
      if(paths.some(rel=>files.has(path.basename(rel)))) throw Error('Duplicate immutable sticker filename');
      for(const rel of paths)files.set(path.basename(rel),path.resolve(root,rel));
      assets.push(a);
    }
  } catch { assets.length=0;files.clear(); }
  return cache={root,at:Date.now(),assets,files};
}
export function localCharacterStickerFile(filename: string): string | undefined {
  if(!/^[a-z0-9-]+\.(webp|png)$/.test(filename))return undefined;
  return bank().files.get(filename);
}
const time=(h:StickerHistory)=>h.at??+new Date(h.timestamp||0);
const roll=(seed:string)=>createHash('sha256').update(seed).digest().readUInt32BE(0)/0x100000000;
const romantic=new Set(['kiss','flirt','jealous','miss','reconcile']);
// A reaction must match an explicit conversational beat, never a random decoration.
const scenes: Array<[string,RegExp]> = [
  ['care',/抱抱|摸摸|安慰|陪着你|陪你|辛苦了|hug|comfort/i],
  ['kiss',/亲亲|亲一下|比心|爱你|kiss|love you/i],
  ['miss',/想你|想我|等你|等我|miss you/i],
  ['flirt',/撒娇|贴贴|害羞|脸红|cuddle|blush/i],
  ['rest',/好困|睡觉|晚安|困困|躺平|歇会|good ?night|sleepy|bedtime/i],
  ['food',/吃饭|好饿|吃撑|零食|奶茶|咖啡|喝水|好吃|hungry|snack|coffee|dinner/i],
  ['laugh',/哈哈|笑死|好开心|太开心|耶[！!～~]|haha|hilarious|lol/i],
  ['observe',/吃瓜|围观|细品|看热闹|popcorn/i],
  ['speechless',/无语|没招了|无奈|叹气|speechless|facepalm/i],
  ['work',/下班|摸鱼|作业写完|忙完了|off work|finished work/i],
  ['music',/跳舞|听歌|唱歌|dance|dancing/i],
  ['play',/打游戏|开黑|玩游戏|gaming/i],
  ['ack',/收到|给你点赞|好耶|没问题|got it|you got this/i],
  ['greeting',/早安|回来啦|我回来|早上好|good morning|i.m back/i],
];
const serious=/自杀|自残|不想活|活不下去|轻生|去死|伤害自己|家暴|被强迫|性侵|去世|过世|葬礼|急救|诊断|癌症|分手|失恋|恐慌|崩溃|抑郁|绝望|很难过|难受|很痛苦|被欺负|受伤|别开玩笑|认真说|suicid|self.harm|panic|grief|passed away|abuse|diagnos|heartbroken|devastat|depress|seriously/i;
export function selectCharacterSticker(input: StickerSelection, candidates?: StickerCandidate[]): CharacterSticker | undefined {
  try {
    if(process.env.CHARACTER_STICKERS_ENABLED==='0'||!input.userId||input.hasOtherMedia)return;
    const {character:c,context,now}=input;
    const user=toZhSimple(input.userText||''); const text=toZhSimple(input.text||'');
    if(!text.trim()||text.length>600||user.length>400||serious.test(user+'\n'+text))return;
    if(context==='chat'&&input.history.filter(h=>h.role==='user'&&time(h)<=now).sort((a,b)=>time(a)-time(b)).slice(-3).some(h=>serious.test(toZhSimple(h.content||''))))return;
    if(/(?:别|不要|不用|停止|不发|不喜欢).{0,10}(?:表情|梗图|贴图|亲|抱|撒娇)|no stickers|stop.{0,8}memes/i.test(user))return;
    if(context==='chat'){
      const controls=[...input.history.filter(h=>h.role==='user'&&time(h)<=now).sort((a,b)=>time(a)-time(b)).map(h=>toZhSimple(h.content||'')),user];
      const preference=controls.filter(t=>/(?:表情包|梗图|贴图)|sticker|meme/i.test(t)).at(-1)||'';
      if(/(?:别|不要|不用|停止|不发|不喜欢).{0,10}(?:表情|梗图|贴图)|no stickers|stop.{0,8}memes/i.test(preference))return;
    }
    const persona=toZhSimple([c.identity,c.voice,c.boundaries].join('\n'));
    if(/(?:不用|不要|禁止|不发|不喜欢).{0,10}(?:表情|网络梗|贴图)|no stickers|never.{0,8}memes/i.test(persona))return;
    if(c.story && c.storyMode!=='out' && /古代|古风|江湖|仙侠|武侠|修仙|宫廷|王朝|medieval|ancient|wuxia/i.test(persona+'\n'+c.story.scenarioTitle))return;
    const history=input.history.filter(h=>(context==='moments'||h.role==='assistant')&&time(h)<=now).sort((a,b)=>time(a)-time(b));
    const own=context==='moments'?history.filter(h=>h.characterId===c.id):history;
    const attached=own.filter(h=>h.sticker);
    const last=attached.at(-1);
    const requested=context==='chat'&&/(?:发|来|给|用).{0,8}(?:表情包|贴图|梗图)|send.{0,15}(?:sticker|meme)/i.test(user);
    if(context==='chat'){
      if(!requested&&own.length<3)return;
      if(last&&(now-time(last)<12*60000||own.filter(h=>time(h)>time(last)).length<5))return;
      if(attached.filter(h=>now-time(h)<3600000).length>=3||attached.filter(h=>now-time(h)<86400000).length>=12)return;
    }else{
      if(last&&(now-time(last)<18*3600000||own.filter(h=>time(h)>time(last)).length<2))return;
      const globalLast=history.filter(h=>h.sticker).at(-1);
      if(globalLast&&history.filter(h=>time(h)>time(globalLast)).length<3)return;
    }
    const relationship=input.relation===undefined?c.relation||'friend':input.relation;
    const lover=relationship==='lover'&&!/(?:不|禁止|拒绝).{0,6}(?:亲密|亲吻|撒娇|恋爱)|no romance|no intimacy/i.test(persona);
    let scene=scenes.find(([,re])=>re.test(context==='moments'?text:user+'\n'+text))?.[0];
    if(!scene&&requested)scene='ack';
    if(!scene)return;
    if(romantic.has(scene)&&!lover)return;
    const playful=/抽象|搞怪|幽默|活泼|调皮|嘴贫|损友|chaotic|playful|witty/i.test(persona);
    const reserved=/高冷|克制|寡言|严肃|沉稳|冷静|stoic|reserved/i.test(persona);
    const gentle=/温柔|可爱|软萌|撒娇|黏人|sweet|gentle/i.test(persona);
    const chance=context==='moments'?0.24:reserved?0.09:playful?0.22:0.15;
    if(!requested&&roll(input.seed+':frequency')>=chance)return;
    const styles=reserved?['A','D','H']:lover&&(gentle||romantic.has(scene)||scene==='care')?['E','F','G']:playful?['A','C','D','I']:gentle?['A','E','F','G','H']:['A','D','E','H'];
    const recent=new Set(history.filter(h=>h.sticker).slice(-24).map(h=>h.sticker!.id));
    const pool=(candidates??bank().assets).filter(a=>a.categories.includes(scene!)&&styles.includes(a.family)&&!recent.has(a.id)
      &&(lover||!a.categories.some(s=>romantic.has(s)||s==='hug'))
      &&(!reserved||!a.categories.includes('abstract')));
    if(!pool.length)return;
    // Stable per-character affinity, then vary within it by the saved turn seed.
    const ranked=pool.map(a=>({a,score:roll(input.userId+':'+c.id+':'+a.family)*0.35+roll(input.seed+':'+a.id)*0.65})).sort((a,b)=>b.score-a.score);
    const a=ranked[0].a;
    const sticker:CharacterSticker={id:a.id,version:VERSION,url:'/api/stickers/local/'+path.basename(a.file),...(a.posterFile?{posterUrl:'/api/stickers/local/'+path.basename(a.posterFile)}:{}),alt:a.title,width:a.width,height:a.height,animated:a.animated};
    return sticker;
  }catch{return undefined;}
}
