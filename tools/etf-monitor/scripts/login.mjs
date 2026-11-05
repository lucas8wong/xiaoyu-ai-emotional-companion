import { wranglerInteractive } from './common.mjs';
try { wranglerInteractive(['login', '--browser=false']); }
catch (error) { console.error(error.message); process.exitCode = 1; }
