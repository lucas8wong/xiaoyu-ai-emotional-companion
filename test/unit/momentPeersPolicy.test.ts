import {test} from 'node:test';import assert from 'node:assert/strict';
import {sameMomentWorld,buildMomentPeerPayload} from '../../api/services/momentPeers.js';
import type {ChatCharacter} from '../../api/services/chatCharacter.js';
const character=(id:string,relation:ChatCharacter['relation']):ChatCharacter=>({id,userId:'owner',name:id,identity:'成年书店店主',voice:'短句',boundaries:'尊重隐私',isDefault:false,createdAt:0,updatedAt:0,relation});
test('a user relationship never implies peer kinship or permits a different story world',()=>{
 const a=character('a','lover'),b=character('b','family');assert.equal(sameMomentWorld(a,b),true);assert.equal(sameMomentWorld(a,a),false);
 const story={scenarioId:'first',scenarioTitle:'旧街',kind:'official' as const,aiName:'a',userName:'reader',importedAt:0,syncedMsgCount:0};
 const inStory={...a,story,storyMode:'in' as const};assert.equal(sameMomentWorld(inStory,b),false);assert.equal(sameMomentWorld(inStory,{...b,story:{...story,scenarioId:'other'},storyMode:'in'}),false);assert.equal(sameMomentWorld(inStory,{...b,story}),true);
 assert.equal(sameMomentWorld({...a,identity:'古代江湖剑客'},b),false);
});
test('peer prompts whitelist public persona/thread fields and omit private user relationship and memory',()=>{
 const a={...character('a','lover'),avatar:'PRIVATE_IMAGE_SENTINEL'},b=character('b','family');
 const payload=buildMomentPeerPayload({userId:'PRIVATE_OWNER_SENTINEL',author:a,candidates:[b],post:{text:'公开动态',at:1},comments:[{id:'c',author:'user',authorName:'读者',text:'公开评论',at:2,replyState:'failed'}],lang:'zh-CN'});
 const wire=JSON.stringify(payload);for(const secret of ['PRIVATE_IMAGE_SENTINEL','PRIVATE_OWNER_SENTINEL','relation','replyState','createdAt','memory'])assert.equal(wire.includes(secret),false);assert.ok(wire.includes('公开动态'));assert.ok(wire.includes('公开评论'));
});
