export interface MomentPeerLike {characterId:string;characterName:string;at:number}
export interface MomentPeerLikeJob {state:'scheduled'|'complete'|'skipped';dueAt:number;attempts:number}
