import type {CharacterSticker} from './characterSticker';
export interface MomentCommentView {
 id:string;author:'user'|'character';authorName:string;text:string;at:number;
 sticker?:CharacterSticker;replyToId?:string;replyToName?:string;characterId?:string;
 replyState?:'pending'|'complete'|'failed'|'none';
}
export interface MomentCommentsPage {comments:MomentCommentView[];hasOlder:boolean;nextBefore?:string}
