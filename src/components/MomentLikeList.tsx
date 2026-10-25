import {Heart} from 'lucide-react';
import {getLang,t} from '../i18n';
import type {MomentPeerLike} from '../lib/momentPeerLikes';
export default function MomentLikeList({peerLikes=[],likedByMe}:{peerLikes?:MomentPeerLike[];likedByMe:boolean}){
 const names=[...(likedByMe?[t('momentYouLiked')]:[]),...peerLikes.map(l=>l.characterName)].join(getLang()==='en'?', ':'、');
 if(!names)return null;
 return <div data-testid="moment-like-list" className="flex items-start gap-2 rounded-sm bg-clay-muted px-3 py-2 text-[12px] font-medium text-primary-text" aria-label={t('shopMomentsLike')+' · '+names}><Heart aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0"/><span className="min-w-0 break-words [overflow-wrap:anywhere]">{names}</span></div>;
}
