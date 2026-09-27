import { accountStore } from '../api/services/accounts.js';
import { reengageStore } from '../api/services/reengage.js';
import { activityStore } from '../api/services/activity.js';

const name = process.argv[2] || 'lixt';
const u = accountStore.listAll().find((a) => (a.username || '').toLowerCase() === name.toLowerCase());
if (!u) { console.log('USER_NOT_FOUND:', name); process.exit(0); }
const id = u.userId;
console.log('userId=', id, 'username=', u.username, 'email=', u.email);
const r = reengageStore.get(id);
console.log('reengage=', r ? JSON.stringify({ sentCount: r.sentCount, lastSentAt: r.lastSentAt, optedOut: r.optedOut, events: r.events }, null, 2) : 'none');
const a = activityStore.get(id);
console.log('activity lastActiveAt=', a?.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString('zh-CN') : null, 'lastFeature=', a?.lastFeature, 'chatCount=', a?.chatCount, 'loginCount=', a?.loginCount);
