/** Likes guide editorial interests, never affection, access, spending or punishment. */
export interface TastePost { characterId:string; topic?:string; likedByMe:boolean; at:number; style?:string; text?:string;releaseState?:string }
export function momentTaste(posts:TastePost[],characterId:string,now:number){
 const scores=new Map<string,number>(),styles=new Map<string,number>();
 for(const p of posts){
  if(p.releaseState==='pending'||p.releaseState==='withdrawn'||!p.likedByMe||p.at>now||now-p.at>90*86400000)continue;
  const weight=Math.exp(-(now-p.at)/(21*86400000))*(p.characterId===characterId?1:.2);
  if(p.topic)scores.set(p.topic,(scores.get(p.topic)||0)+weight);
  if(p.style)styles.set(p.style,(styles.get(p.style)||0)+weight);
 }
 const examples=posts.filter(p=>p.releaseState!=='pending'&&p.releaseState!=='withdrawn'&&p.characterId===characterId&&p.likedByMe&&p.text&&p.at<=now&&now-p.at<=90*86400000).sort((a,b)=>b.at-a.at).slice(0,3).map(p=>p.text!.slice(0,120));
 return {examples,topics:[...scores].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([topic,weight])=>({topic,weight:Math.min(2,weight)})),styles:[...styles].sort((a,b)=>b[1]-a[1]).slice(0,2).map(([style])=>style)};
}
export function chooseMomentTopic(topics:readonly string[],avoid:Set<string>,taste:ReturnType<typeof momentTaste>,draw:number):string{
 const available=topics.filter(t=>!avoid.has(t));const pool=available.length?available:[...topics];
 const rows=pool.map(topic=>({topic,weight:1+Math.min(2,taste.topics.find(t=>t.topic===topic)?.weight||0)}));
 let sample=Math.max(0,Math.min(.999999,draw))*rows.reduce((n,r)=>n+r.weight,0);
 for(const r of rows){sample-=r.weight;if(sample<0)return r.topic;}
 return rows.at(-1)?.topic||'';
}
