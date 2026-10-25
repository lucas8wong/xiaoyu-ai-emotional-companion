export interface MomentGiftEvent {userId:string;characterId:string;giftId:string;at:number}
let listener:((event:MomentGiftEvent)=>void)|undefined;
export function onMomentGift(next:(event:MomentGiftEvent)=>void){listener=next;}
/** Called after the real gift transaction commits; optional scheduling cannot undo it. */
export function emitMomentGift(event:MomentGiftEvent){try{listener?.(event);}catch(error){console.warn('[Moments] Gift scheduling deferred for recovery:',error instanceof Error?error.message:'unavailable');}}
