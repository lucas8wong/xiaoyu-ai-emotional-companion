import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultMomentRhythm,defaultCharacterRhythm,parseMomentRhythm,rhythmSample,momentRestPlan,momentQuietAt,momentCharacterAwake,nextMomentBrowse,momentReactionDue} from '../../src/lib/momentRhythm.js';
const start=Date.parse('2026-10-26T00:00:00Z');
test('settings validate times, timezone, own overrides and construct clean canonical values',()=>{
 const s=defaultMomentRhythm();assert.deepEqual(parseMomentRhythm(s),s);
 for(const patch of [{timezone:'not/a/timezone'},{speed:'instant'},{quiet:{enabled:true,start:'25:00',end:'08:00'}},{quiet:{enabled:true,start:'08:00',end:'08:00'}},{characters:{x:{sleep:'01:00',wake:'02:00',browsing:'often',expression:'natural'}}}])assert.equal(parseMomentRhythm({...s,...patch}),null);
 assert.equal(parseMomentRhythm({...s,characters:JSON.parse('{"__proto__":{"sleep":"23:00","wake":"08:00","browsing":"often","expression":"natural"}}')}),null);
});
test('stable independent habits and day variations produce all-nighters with subsequent recovery',()=>{
 const s=defaultMomentRhythm(),days=new Set<string>();let night=false;
 assert.deepEqual(defaultCharacterRhythm('a','x'),defaultCharacterRhythm('a','x'));
 assert.notDeepEqual(defaultCharacterRhythm('a','x'),defaultCharacterRhythm('a','y'));
 for(let day=20700;day<21100;day++){
  const p=momentRestPlan('a','x',s,day);days.add(p.kind);assert.deepEqual(p,momentRestPlan('a','x',s,day));
  if(p.kind==='allNight'){night=true;assert.ok(p.start>=day*1440+1440+480);assert.ok(p.end-p.start>=360);}
 }
 assert.ok(night);assert.deepEqual([...days].sort(),['allNight','late','usual']);
 s.allowLateNights=false;for(let day=20700;day<20800;day++)assert.equal(momentRestPlan('a','x',s,day).kind,'usual');
});
test('explicit cross-midnight quiet time overrides even an all-nighter and uses chosen timezone',()=>{
 const s=defaultMomentRhythm();s.quiet={enabled:true,start:'23:30',end:'07:30'};
 for(const time of ['2026-10-26T15:30:00Z','2026-10-26T19:00:00Z','2026-10-26T23:29:59Z']){assert.equal(momentQuietAt(s,Date.parse(time)),true);assert.equal(momentCharacterAwake('a','x',s,Date.parse(time)),false);}
 assert.equal(momentQuietAt(s,Date.parse('2026-10-26T23:30:00Z')),false);
 s.timezone='America/New_York';assert.equal(momentQuietAt(s,Date.parse('2026-10-26T19:00:00Z')),false);
});
test('browsing allows seconds and hours, with independent actions and no guaranteed response',()=>{
 const s=defaultMomentRhythm();s.speed='fast';s.allowLateNights=false;let instantLike=false,instantComment=false,delayed=false;
 for(let i=0;i<1440;i+=3){const now=start+i*60000,seen=nextMomentBrowse('a','x',s,now);
  if(seen-now>3600000)delayed=true;
  if(seen!==now)continue;
  const like=momentReactionDue('a','x',s,now,'like','p'+i),comment=momentReactionDue('a','x',s,now,'comment','p'+i);
  if(like-now<=10000)instantLike=true;if(comment-now<=30000)instantComment=true;
  assert.equal(momentCharacterAwake('a','x',s,like),true);assert.equal(momentCharacterAwake('a','x',s,comment),true);
 }
 assert.ok(instantLike&&instantComment&&delayed);assert.ok(rhythmSample('a')>=0&&rhythmSample('a')<1);
});
test('DST boundaries, day sleep and quiet windows yield real future instants',()=>{
 const s=defaultMomentRhythm();s.timezone='America/New_York';s.characters.x={sleep:'08:00',wake:'16:00',browsing:'often',expression:'quiet'};s.allowLateNights=false;
 for(const day of ['2026-03-08T06:59:00Z','2026-11-01T05:59:00Z']){const now=Date.parse(day),due=momentReactionDue('a','x',s,now,'comment','dst');assert.ok(due>=now&&due<now+48*3600000);assert.equal(momentCharacterAwake('a','x',s,due),true);}
 assert.equal(momentCharacterAwake('a','x',s,Date.parse('2026-10-26T16:00:00Z')),false);
});
