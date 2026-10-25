import {createHash} from 'node:crypto';
import {sameMomentWorld} from './momentPeers.js';
import type {ChatCharacter} from './chatCharacter.js';
import type {MomentCommentView} from '../../src/lib/momentComments.js';
export interface PublicPeerEvent {kind:'conversation'|'like';postId:string;at:number;post:{author:string;text:string};lines:{speaker:string;text:string}[]}
export interface PublicPeerMemory {version:string;peers:{characterId:string;name:string;events:PublicPeerEvent[]}[]}
interface PublicSource {
 id:string;characterId:string;characterName:string;text:string;at:number;author?:'user'|'character';releaseState?:string;deletedAt?:number;
 comments?:(MomentCommentView&{peer?:boolean;deletedAt?:number})[];
 peerLikes?:{characterId:string;characterName:string;at:number}[];
}
/** Rebuild working memory exclusively from this owner's still-visible peer events. No private store/cache. */
export function collectPublicPeerMemory(ownerId:string,characterId:string,posts:PublicSource[],people:ChatCharacter[],now:number,excludePostId?:string):PublicPeerMemory{
 const own=new Map(people.filter(c=>c.userId===ownerId||c.id==='xiaoyu'&&c.isDefault).map(c=>[c.id,c])),self=own.get(characterId),events=new Map<string,PublicPeerEvent[]>();
 const add=(otherId:string,event:PublicPeerEvent)=>{const other=own.get(otherId);if(!self||!other||!sameMomentWorld(self,other))return;const list=events.get(otherId)||[];list.push(event);events.set(otherId,list);};
 for(const p of posts){
  if(!self||p.id===excludePostId||p.author==='user'||p.deletedAt||p.releaseState==='pending'||p.releaseState==='withdrawn'||p.at>now||now-p.at>90*86400000||!own.has(p.characterId))continue;
  const author=own.get(p.characterId)!,all=new Map<string,NonNullable<PublicSource['comments']>[number]>();for(const c of p.comments||[]){const old=all.get(c.id);if(!old||c.deletedAt||!old.deletedAt)all.set(c.id,c);}
  const visible=(c:NonNullable<PublicSource['comments']>[number])=>{const seen=new Set<string>();let cur:typeof c|undefined=c;while(cur){if(cur.deletedAt||cur.author!=='character'||!cur.peer||!cur.characterId||!own.has(cur.characterId)||cur.at>now||seen.has(cur.id))return false;seen.add(cur.id);if(!cur.replyToId)return true;cur=all.get(cur.replyToId);}return false;};
  const lines=[...all.values()].filter(visible),seenPairs=new Set<string>();
  for(const visit of lines.filter(c=>!c.replyToId&&c.characterId!==p.characterId)){
   const visitor=own.get(visit.characterId!)!;if(!sameMomentWorld(author,visitor)||characterId!==author.id&&characterId!==visitor.id)continue;
   const reply=lines.find(c=>c.characterId===author.id&&c.replyToId===visit.id),other=characterId===author.id?visitor:author;
   const picked=[visit,...(reply?[reply]:[])];seenPairs.add(visitor.id);
   add(other.id,{kind:'conversation',postId:p.id,at:Math.max(...picked.map(c=>c.at)),post:{author:author.name,text:p.text.slice(0,160)},lines:picked.map(c=>({speaker:own.get(c.characterId!)!.name,text:c.text.slice(0,180)}))});
  }
  for(const like of p.peerLikes||[]){
   const visitor=own.get(like.characterId);if(!visitor||like.at>now||seenPairs.has(visitor.id)||!sameMomentWorld(author,visitor)||characterId!==author.id&&characterId!==visitor.id)continue;
   add(characterId===author.id?visitor.id:author.id,{kind:'like',postId:p.id,at:like.at,post:{author:author.name,text:p.text.slice(0,160)},lines:[]});
  }
 }
 const peers=[...events].map(([id,list])=>({characterId:id,name:own.get(id)!.name,events:list.sort((a,b)=>b.at-a.at).slice(0,2)})).sort((a,b)=>b.events[0].at-a.events[0].at).slice(0,2);
 let remaining=3;for(const peer of peers){peer.events=peer.events.slice(0,remaining);remaining-=peer.events.length;}
 const retained=peers.filter(p=>p.events.length),bindings=[self,...retained.map(p=>own.get(p.characterId))].map(c=>c?{id:c.id,name:c.name,identity:c.identity,voice:c.voice,boundaries:c.boundaries,storyMode:c.storyMode,story:c.story?{kind:c.story.kind,id:c.story.scenarioId}:undefined}:null);return {version:createHash('sha256').update(JSON.stringify([retained,bindings])).digest('hex').slice(0,20),peers:retained};
}
/** Defensive wire whitelist; never spread arbitrary source records into a model prompt. */
export function publicPeerMemoryPayload(memory:PublicPeerMemory|undefined){
 if(!memory)return undefined;
 return {peers:memory.peers.slice(0,2).map(p=>({characterId:p.characterId,name:p.name.slice(0,80),events:p.events.slice(0,2).map(e=>({kind:e.kind,postId:e.postId,at:e.at,post:{author:e.post.author.slice(0,80),text:e.post.text.slice(0,160)},lines:e.lines.slice(0,2).map(l=>({speaker:l.speaker.slice(0,80),text:l.text.slice(0,180)}))}))}))};
}
