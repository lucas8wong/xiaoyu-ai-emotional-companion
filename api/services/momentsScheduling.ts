export interface PendingMomentGift {id:string;characterId:string;giftIds:string[];at:number;dueAt:number;attempts:number}
export const MOMENT_ACTIVE_MS=7*86400000;
export function initialMomentDue(now:number,draw:number){return now+(2+Math.floor(Math.max(0,Math.min(.999,draw))*10))*60000;}
export function giftMomentDue(now:number,draw:number){return draw<.2?now:now+(30+Math.floor(Math.max(0,Math.min(.999,draw))*270))*1000;}
export function inMomentWakingHours(now:number,timezone:string){
 try{const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(now));return hour>=8||hour===0;}catch{return true;}
}
