import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildMomentPeerLikePayload} from '../../api/services/momentPeerLikes.js';
import type {ChatCharacter} from '../../api/services/chatCharacter.js';
test('like judgment whitelists actual public content and persona without popularity, relationship or private thread data',()=>{
 const author:ChatCharacter={id:'author',userId:'PRIVATE_OWNER',name:'作者',identity:'成年咖啡师',voice:'简短',boundaries:'尊重隐私',isDefault:false,createdAt:0,updatedAt:0,relation:'lover'},candidate={...author,id:'peer',name:'角色',relation:'family' as const};
 const extended={text:'一条公开的小事',at:10,likes:999,likedByMe:true,giftNote:'PRIVATE_GIFT',memory:'PRIVATE_MEMORY'};
 const payload=buildMomentPeerLikePayload({userId:'PRIVATE_OWNER',author,candidates:[candidate],post:extended,comments:[{id:'c',author:'user',authorName:'PRIVATE_NAME',text:'PRIVATE_COMMENT',at:1}],lang:'zh-CN'}),raw=JSON.stringify(payload);
 for(const forbidden of ['PRIVATE_','likes','likedByMe','relation','comments','memory','giftNote'])assert.equal(raw.includes(forbidden),false);
 assert.deepEqual(payload.post,{text:'一条公开的小事',at:10});assert.equal(payload.candidates[0].name,'角色');
});
