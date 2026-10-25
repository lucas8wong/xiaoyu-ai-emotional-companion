import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCharacterSticker, chooseCharacterSticker, characterStickerCandidates, type StickerCandidate, type StickerSelection } from '../../api/services/characterStickers.js';
import { validCharacterSticker } from '../../src/lib/characterSticker.js';
import { mapServerMessages } from '../../src/lib/chatServerMessages.js';

const NOW=Date.parse('2026-10-25T08:00:00Z');
const asset=(id:string,family:string,categories:string[]):StickerCandidate=>({id,family,categories,title:'合成测试表情',file:`scenes/ack/${id}.webp`,width:128,height:128,animated:false});
const pool=[asset('cat-ack','A',['ack']),asset('capy-care','H',['care']),asset('dog-kiss','E',['kiss']),asset('dog-sleep','E',['rest']),asset('capy-sleep','H',['rest']),asset('nailong-laugh','I',['laugh','abstract']),asset('cat-laugh','A',['laugh']),asset('dog-laugh','E',['laugh']),asset('penguin-laugh','D',['laugh'])];
const base=(extra:Partial<StickerSelection>={}):StickerSelection=>({context:'chat',userId:'synthetic-user',character:{id:'test',identity:'成年朋友',voice:'自然',boundaries:'尊重别人',relation:'friend'},text:'收到，没问题',userText:'发个表情包给我',history:[],now:NOW,seed:'test',...extra});
const select=(extra:Partial<StickerSelection>={},id='cat-ack')=>selectCharacterSticker(base(extra),pool,{use:true,id});
const find=(extra:Partial<StickerSelection>={})=>Array.from({length:100},(_,i)=>select({...extra,seed:'test-'+i})).find(Boolean);
const history=Array.from({length:8},(_,i)=>({role:'assistant',content:'普通旧回复',timestamp:new Date(NOW-(10-i)*60000)}));

test('explicit request resolves one local attachment without changing spoken text',()=>{
 const input=base();const result=selectCharacterSticker(input,pool,{use:true,id:'cat-ack'})!;
 assert.ok(validCharacterSticker(result));assert.equal(input.text,'收到，没问题');
 assert.equal(result.id,'cat-ack');assert.match(result.url,/^\/api\/stickers\/local\//);
 assert.deepEqual(result,selectCharacterSticker(input,pool,{use:true,id:'cat-ack'}),'saved turn seeds are deterministic');
});
test('serious subjects, no-sticker requests and character boundaries suppress reactions',()=>{
 for(const userText of ['我不想活了，发个表情包','我朋友去世了，想要安慰','别发表情包了','不要抱我，认真说','I am depressed, send a sticker'])assert.equal(select({userText}),undefined,userText);
 assert.equal(select({character:{...base().character,boundaries:'不要发表情包'}}),undefined);
 assert.equal(select({hasOtherMedia:true}),undefined);
 assert.equal(select({userId:''}),undefined);
 assert.equal(select({text:''}),undefined);
 assert.equal(select({history:[{role:'user',content:'我朋友去世了',timestamp:new Date(NOW-60000)}]}),undefined,'a short follow-up does not reset serious context');
 assert.equal(select({text:'x'.repeat(601)}),undefined);
});
test('romantic pictures require lover relationship and do not infer romance from received gifts',()=>{
 const request={text:'亲亲，爱你',userText:'亲亲，发个表情包'};
 for(const relation of ['friend','buddy','family'] as const)assert.equal(select({...request,relation},'dog-kiss'),undefined);
 assert.equal(select({...request,relation:'lover'},'dog-kiss')?.id,'dog-kiss');
 assert.equal(select({...request,relation:null},'dog-kiss'),undefined);
 assert.equal(select({...request,relation:'lover',character:{...base().character,boundaries:'不接受亲密表达'}},'dog-kiss'),undefined);
 assert.equal(select({...request,character:{...base().character,relation:'lover'},relation:'friend'},'dog-kiss'),undefined);
});
test('ancient in-story roles keep their era while out-of-story daily chat can react',()=>{
 const character={...base().character,identity:'古代江湖侠客',story:{scenarioId:'synthetic',scenarioTitle:'江湖',kind:'official' as const,aiName:'侠客',userName:'旅人',importedAt:NOW,syncedMsgCount:0}};
 assert.equal(select({character}),undefined);
 assert.ok(select({character:{...character,storyMode:'out'}}));
});
test('warmup, twelve-minute cooldown, six-turn spacing and rolling caps survive history reuse',()=>{
 assert.equal(select({userText:'收到'}),undefined);
 assert.ok(find({userText:'收到',history}));
 const sticker=select()!;
 const recent={role:'assistant',timestamp:new Date(NOW-60000),sticker};
 assert.equal(select({history:[recent,...history]}),undefined,'explicit request does not bypass cooldown');
 const old={...recent,timestamp:new Date(NOW-20*60000)};
 assert.equal(select({history:[old,...history.slice(0,4)]}),undefined);
 // The same ID is not repeated, even when enough turns and time have passed.
 assert.equal(select({history:[old,...history]}),undefined);
 const caps=Array.from({length:3},(_,i)=>({...old,sticker:{...sticker,id:'previous-'+i},timestamp:new Date(NOW-(50-i*15)*60000)}));
 assert.equal(select({history:[...caps,...history]}),undefined);
});
test('semantic approval, not keywords, selects an eligible picture and rejects invented IDs',async()=>{
 const input=base({text:'脑袋开始自动关机了',userText:'发个表情包'});
 assert.equal(selectCharacterSticker(input,pool),undefined);
 assert.equal(selectCharacterSticker(input,pool,{use:true,id:'invented'}),undefined);
 const pick=await chooseCharacterSticker(input,{candidates:pool,generate:async(_system,user)=>{
  const data=JSON.parse(user);assert.equal(data.completedText,input.text);assert.ok(data.candidates.some((a:any)=>a.id==='dog-sleep'));
  return JSON.stringify({use:true,id:'dog-sleep'});
 }});assert.equal(pick?.id,'dog-sleep');
 assert.equal(await chooseCharacterSticker(base({text:'晚安个头，我现在一点也不想睡'}),{candidates:pool,generate:async()=>'{"use":false}'}),undefined);
 for(const raw of ['no JSON','{"use":true,"id":"evil"}','{"use":"true","id":"cat-ack"}'])assert.equal(await chooseCharacterSticker(input,{candidates:pool,generate:async()=>raw}),undefined);
 assert.equal(await chooseCharacterSticker(input,{candidates:pool,timeoutMs:5,generate:()=>new Promise(()=>{})}),undefined);
 let calls=0;assert.equal(await chooseCharacterSticker(base({userText:'我很难过'}),{candidates:pool,generate:async()=>{calls++;return '{}';}}),undefined);assert.equal(calls,0);
});

test('personality changes the low-frequency opportunity, semantic model can always decline',()=>{
 const playful={...base().character,voice:'活泼搞怪，爱玩抽象梗'},quiet={...base().character,voice:'高冷克制，严肃寡言'};
 const rates=[playful,quiet].map(character=>Array.from({length:1000},(_,i)=>characterStickerCandidates(base({character,userText:'好呀',history,seed:'rate'+i}),pool)).filter(a=>a.length).length);
 assert.ok(rates[0]>150&&rates[0]<280);assert.ok(rates[1]>50&&rates[1]<140);assert.ok(rates[0]>rates[1]);
 assert.ok(characterStickerCandidates(base({character:quiet}),pool).every(a=>!a.categories.includes('abstract')));
});

test('Moments use their own text, at most one per four posts and one per three character posts',()=>{
 const seed=find({context:'moments',text:'哈哈笑死了',history:[]})!;assert.ok(seed);
 const post={characterId:'test',at:NOW-20*3600000,sticker:seed};
 assert.equal(find({context:'moments',text:'哈哈笑死了',history:[post]}),undefined);
 const other={characterId:'other',at:NOW-60000,sticker:seed};
 assert.equal(find({context:'moments',text:'哈哈笑死了',history:[other]}),undefined);
 const rows=[post,...Array.from({length:4},(_,i)=>({characterId:'test',at:NOW-(5-i)*60000}))];
 assert.ok(Array.from({length:100},(_,i)=>select({context:'moments',text:'哈哈笑死了',history:rows,seed:'retry-'+i},'dog-laugh')).find(Boolean));
 assert.equal(selectCharacterSticker(base({context:'moments',text:'这里的书签像树叶'}),pool,{use:false}),undefined);
});
test('one attachment survives split history only on the last assistant bubble; unsafe URLs drop',()=>{
 const sticker=select()!;
 const message={role:'assistant' as const,content:'第一句\n\n第二句',timestamp:new Date(NOW).toISOString(),sticker};
 const rows=mapServerMessages([message]);assert.equal(rows.length,2);assert.equal(rows[0].sticker,undefined);assert.deepEqual(rows[1].sticker,sticker);
 assert.equal(mapServerMessages([{...message,role:'user'}])[0].sticker,undefined);
 for(const url of ['https://evil.example/a.webp','/api/stickers/local/../secret.png','/api/stickers/local/a.svg','/api/stickers/local/a.webp?token=secret']){
  assert.equal(validCharacterSticker({...sticker,url}),false);assert.equal(mapServerMessages([{...message,sticker:{...sticker,url}}]).at(-1)?.sticker,undefined);
 }
 assert.equal(validCharacterSticker({...sticker,animated:true}),false,'motion needs a static poster');
});
