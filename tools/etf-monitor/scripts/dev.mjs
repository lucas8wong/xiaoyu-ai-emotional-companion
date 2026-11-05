import { wranglerInteractive } from './common.mjs';
try {
  wranglerInteractive(['d1', 'migrations', 'apply', 'qqqm-spym-monitor', '--local']);
  wranglerInteractive(['dev', '--test-scheduled', '--port', '8787']);
} catch (error) { console.error(error.message); process.exitCode = 1; }
