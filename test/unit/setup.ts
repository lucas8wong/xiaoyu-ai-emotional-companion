import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 将进程工作目录切到临时目录，确保 store 单例读写 temp/data 而非真实 data/。
 * 必须在「动态 import 任何 store」之前调用（store 在 import 时用 process.cwd() 定位数据目录）。
 */
export function setupTempCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cure-test-'));
  process.chdir(dir);
  return dir;
}
