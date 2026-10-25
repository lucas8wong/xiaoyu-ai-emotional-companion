import test from 'node:test';
import assert from 'node:assert/strict';
import {momentTaste,chooseMomentTopic,type TastePost} from '../../api/services/momentPreferences.js';
import {giftMomentDue,initialMomentDue,inMomentWakingHours} from '../../api/services/momentsScheduling.js';
const now=Date.parse('2026-10-25T04:00:00Z');
test('retained likes influence topics with bounded strength, decay and exploration',()=>{
 const rows:TastePost[]=Array.from({length:10},()=>({characterId:'a',at:now,likedByMe:true,topic:'books',style:'short'}));
 const taste=momentTaste(rows,'a',now);assert.equal(taste.topics[0].weight,2);assert.deepEqual(taste.styles,['short']);
 const picks=Array.from({length:100},(_,i)=>chooseMomentTopic(['books','music'],new Set(),taste,i/100));
 assert.equal(picks.filter(t=>t==='books').length,75);assert.equal(picks.filter(t=>t==='music').length,25);
 assert.equal(chooseMomentTopic(['books','music'],new Set(['books']),taste,0),'music');
 assert.ok(momentTaste([{...rows[0],at:now-21*86400000}],'a',now).topics[0].weight<.4);
 assert.equal(momentTaste([{...rows[0],at:now+1}],'a',now).topics.length,0);
 assert.equal(momentTaste([{...rows[0],at:now-91*86400000}],'a',now).topics.length,0);
 assert.equal(momentTaste(rows.map(p=>({...p,likedByMe:false})),'a',now).topics.length,0,'unlike removes influence');
 assert.equal(momentTaste([rows[0]],'b',now).topics[0].weight,.2,'another character gets only a weak interest hint');
});
test('gifts get immediate or minute-scale opportunities and normal life respects waking hours',()=>{
 assert.equal(giftMomentDue(now,.1),now);
 for(const d of [.2,.5,.999])assert.ok(giftMomentDue(now,d)>now&&giftMomentDue(now,d)<=now+5*60000);
 assert.ok(initialMomentDue(now,.5)>now);
 assert.equal(inMomentWakingHours(Date.parse('2026-10-25T19:00:00Z'),'Asia/Shanghai'),false);
 assert.equal(inMomentWakingHours(now,'Asia/Shanghai'),true);
});
