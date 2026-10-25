import {test} from 'node:test';import assert from 'node:assert/strict';
import {collectPublicPeerMemory,publicPeerMemoryPayload} from '../../api/services/momentPublicMemory.js';
import type {ChatCharacter} from '../../api/services/chatCharacter.js';
const now=Date.parse('2026-10-25T08:00:00Z'),person=(id:string,userId='owner'):ChatCharacter=>({id,userId,name:id,identity:'成年朋友',voice:'简短',boundaries:'尊重隐私',isDefault:false,createdAt:0,updatedAt:0});
const people=[person('a'),person('b'),person('c'),person('foreign','other')];
const source=()=>({id:'source',characterId:'a',characterName:'a',text:'招牌挂反了',at:now-7200000,releaseState:'published',comments:[{id:'visit',author:'character' as const,authorName:'b',characterId:'b',text:'这是在考验路人吗',at:now-7100000,peer:true},{id:'answer',author:'character' as const,authorName:'a',characterId:'a',text:'先倒着读吧',at:now-7000000,peer:true,replyToId:'visit'}]});
test('memory has exact public speakers and topic, survives source replay, and is pair/owner scoped',()=>{
 const p=source(),memory=collectPublicPeerMemory('owner','b',[p],people,now);assert.equal(memory.peers[0].characterId,'a');assert.equal(memory.peers[0].events[0].lines[0].speaker,'b');assert.equal(memory.peers[0].events[0].lines[1].text,'先倒着读吧');assert.equal(collectPublicPeerMemory('owner','c',[p],people,now).peers.length,0);assert.equal(collectPublicPeerMemory('other','b',[p],people,now).peers.length,0);assert.deepEqual(collectPublicPeerMemory('owner','b',JSON.parse(JSON.stringify([p])),people,now),memory);
});
test('user comments, user-directed AI replies, deleted chains, hidden/future/expired posts and user posts never become peer memories',()=>{
 const p:any=source();p.comments.push({id:'private-user',author:'user',authorName:'me',text:'PRIVATE_USER_SENTINEL',at:now-60000},{id:'private-reply',author:'character',characterId:'b',authorName:'b',text:'PRIVATE_CHAT_SENTINEL',replyToId:'private-user',at:now-50000});
 const m=collectPublicPeerMemory('owner','b',[p],people,now);assert.ok(!JSON.stringify(m).includes('PRIVATE_'));const version=m.version;p.comments[0].deletedAt=now-1;assert.equal(collectPublicPeerMemory('owner','b',[p],people,now).peers.length,0);assert.notEqual(collectPublicPeerMemory('owner','b',[p],people,now).version,version);
 for(const changed of [{...source(),author:'user' as const},{...source(),releaseState:'pending'},{...source(),at:now+1},{...source(),at:now-91*86400000}])assert.equal(collectPublicPeerMemory('owner','b',[changed],people,now).peers.length,0);
 assert.equal(collectPublicPeerMemory('owner','b',[source()],people.filter(p=>p.id!=='a'),now).peers.length,0);
});
test('likes remain likes, old sources stay stored, and bounded wire payload cannot leak extra fields',()=>{
 const p:any=source();p.comments=[];p.peerLikes=[{characterId:'b',characterName:'b',at:now-1}];const memory=collectPublicPeerMemory('owner','b',[p],people,now);assert.equal(memory.peers[0].events[0].kind,'like');assert.deepEqual(memory.peers[0].events[0].lines,[]);assert.equal(collectPublicPeerMemory('owner','b',[p],people,now,'source').peers.length,0);
 (memory as any).private='PRIVATE';const wire=JSON.stringify(publicPeerMemoryPayload(memory));assert.ok(!wire.includes('PRIVATE'));assert.ok(!wire.includes('version'));
});
test('duplicate historical comment IDs are read once without deleting history, and any tombstone wins',()=>{
 const p:any=source();p.comments.push({...p.comments[0]});const original=p.comments.length;assert.equal(collectPublicPeerMemory('owner','b',[p],people,now).peers[0].events.length,1);assert.equal(p.comments.length,original);p.comments[0].deletedAt=now-1;assert.equal(collectPublicPeerMemory('owner','b',[p],people,now).peers.length,0);
});
test('persona edits revoke draft bindings without sending persona-private fields as public history',()=>{
 const before=collectPublicPeerMemory('owner','a',[source()],people,now),edited=people.map(p=>p.id==='b'?{...p,voice:'改为克制'}:p),after=collectPublicPeerMemory('owner','a',[source()],edited,now);assert.notEqual(after.version,before.version);assert.deepEqual(publicPeerMemoryPayload(after),publicPeerMemoryPayload(before));
});
