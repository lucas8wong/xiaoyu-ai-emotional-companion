import { wrangler } from './common.mjs';
try {
  const result = wrangler(['deploy', '--dry-run', '--outdir', '.build']);
  console.log(result.stdout);
} catch (error) { console.error(error.message); process.exitCode = 1; }
