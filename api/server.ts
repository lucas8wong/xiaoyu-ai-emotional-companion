/**
 * local server entry file, for local development
 */
import dotenv from 'dotenv';
dotenv.config();

import { spawn, type ChildProcess } from 'node:child_process';
import app from './app.js';
import { ensureEmbeddingReady } from './services/embedding.js';
import { ensureAsrReady } from './services/asr.js';
import { maybeGrantProTrialOnStartup } from './services/proTrial.js';
import { runReengagementCycle, isReengageEnabled } from './services/reengage.js';
import { runSelfHealCycle, selfHealMode, deleteAllowed } from './services/selfHeal.js';
import { quotaStore } from './services/quota.js';

/**
 * 可选：启动 faster-whisper 侧车（本地 CPU 亚秒级 ASR）。
 * 若已显式配置外部 `ASR_SIDECAR_URL`、或通过 `FASTER_WHISPER_ENABLED=0` 关闭、或 Python 不可用，则跳过——
 * /api/asr 会自然回退到 transformers.js Whisper，不影响服务。
 */
let sidecar: ChildProcess | null = null;
function maybeStartSidecar(): void {
  if (process.env.ASR_SIDECAR_URL) return; // 已用外部侧车
  if (process.env.FASTER_WHISPER_ENABLED === '0') return;
  try {
    const port = process.env.FASTER_WHISPER_PORT || '8001';
    const model = process.env.FASTER_WHISPER_MODEL || 'small';
    sidecar = spawn('python', ['scripts/faster_whisper_server.py'], {
      env: { ...process.env, FASTER_WHISPER_MODEL: model, FASTER_WHISPER_PORT: port, PYTHONUNBUFFERED: '1' },
      stdio: 'ignore',
      detached: false,
    });
    sidecar.on('error', (e) => {
      sidecar = null;
      console.warn('[ASR] faster-whisper sidecar spawn failed, using transformers.js:', e.message);
    });
    sidecar.on('exit', (code) => {
      console.warn('[ASR] faster-whisper sidecar exited:', code);
      sidecar = null;
    });
    console.log(`🎙 [ASR] faster-whisper sidecar started (${model} on :${port}); /api/asr will prefer it`);
  } catch (e) {
    sidecar = null;
    console.warn('[ASR] faster-whisper sidecar not started:', (e as Error)?.message);
  }
}

function stopSidecar(): void {
  try { sidecar?.kill(); } catch { /* 忽略 */ }
  sidecar = null;
}

/**
 * 可选的「陪伴式主动联系」定时器：按配置的间隔（默认 60 分钟）扫描一次。
 * 默认关闭（REENGAGE_ENABLED=0），需在 .env 显式开启才生效；开启后果自负（会真实发推送/邮件）。
 * 每次发送后写入冷却/每日预算/对象冷却，不会对同一用户或同一对象重复骚扰。
 */
function startReengageScheduler(): void {
  if (!isReengageEnabled()) {
    console.log('🌱 [Reengage] 定时主动找我未开启（REENGAGE_ENABLED=0），跳过。可用 POST /api/reengage/run 手动触发。');
    return;
  }
  const intervalMin = Number(process.env.REENGAGE_SCAN_INTERVAL_MIN || 60); // 扫描间隔（分钟）
  const intervalMs = Math.max(5, intervalMin) * 60 * 1000;
  const run = () => {
    runReengagementCycle({ apply: true }).then((s) => {
      console.log(`🌱 [Reengage] 主动找我完成: scanned=${s.scanned} candidates=${s.candidates} sent=${s.sent} errors=${s.errors}`);
    }).catch((e) => console.warn('🌱 [Reengage] 主动找我执行失败:', (e as Error)?.message));
  };
  // 启动后先跑一次，之后每 intervalMs 一次
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, 15_000);
  console.log(`🌱 [Reengage] 定时主动找我已开启，每 ${intervalMin} 分钟扫描一次。每天总上限由 REENGAGE_DAILY_CAP 控制，单用户每日预算/最小间隔/对象冷却由频率档控制。`);
}

/**
 * 🩺 自愈巡检定时器（2026-09-18 新增）：扫描所有剧情会话找出「坏在哪」并做白名单修复，
 * 结果写进运营端「🩺 自愈 / 修复记录」卡（`GET /api/payment/admin/self-heal`）。
 *
 * 模式（`SELF_HEAL`）：`apply`（默认，会真的修；改前备份到 temp/self-heal-backup/）
 * / `dry`（只观察记录、一行数据不动）/ `off`（完全不跑）。
 * 间隔 `SELF_HEAL_INTERVAL_MIN` 默认 15 分钟；单次修复上限 `SELF_HEAL_MAX_REPAIRS` 默认 50；
 * 内容删除类（历史里的失败兜底文案）默认只报告，需 `SELF_HEAL_DELETE=1` 才自动执行。
 * 边界：只有 `/api/roleplay/session` 这条链路的会话在扫描范围内；聊一聊侧暂不涉及。
 */
function startSelfHealScheduler(): void {
  const mode = selfHealMode();
  if (mode === 'off') {
    console.log('🩺 [SelfHeal] 已关闭（SELF_HEAL=off），跳过定时巡检。可用 POST /api/payment/admin/self-heal/run 手动触发。');
    return;
  }
  const intervalMin = Number(process.env.SELF_HEAL_INTERVAL_MIN || 15);
  const intervalMs = Math.max(5, intervalMin) * 60 * 1000;
  const run = () => {
    runSelfHealCycle().then((s) => {
      if (s.detected === 0 && s.scanned % 20 !== 1) return; // 平静时不刷屏：每 20 次报一次"一切正常"
      console.log(`🩺 [SelfHeal] 巡检完成(${s.mode}${s.applied ? '·已应用' : '·未应用'}) 扫描=${s.scanned} 跳过测试设备=${s.skippedTest} 发现=${s.detected} 已修=${s.fixed} 已缓解=${s.mitigated} 待人工=${s.needsHuman} 待下一轮=${s.pending} 失败=${s.failed}${s.backup ? ' 备份=' + s.backup.split(/[\\/]/).pop() : ''}`);
    }).catch((e) => console.warn('🩺 [SelfHeal] 巡检失败:', (e as Error)?.message));
  };
  setTimeout(() => {
    run();
    setInterval(run, intervalMs);
  }, 20_000);
  console.log(`🩺 [SelfHeal] 已开启（模式 ${mode}，每 ${intervalMin} 分钟一次；内容删除类${deleteAllowed() ? '已允许' : '默认只报告'}）。`);
}

/**
 * start server with port
 */
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
  // 老用户 7 天 Pro 体验：.env 设 PRO_TRIAL_DAYS 且未执行过则一次性对现有注册用户授予
  maybeGrantProTrialOnStartup();
  // 启动 faster-whisper 侧车（可选，自动回退）
  maybeStartSidecar();
  // 可选：场景化召回定时器（默认关闭）
  startReengageScheduler();
  // 🩺 自愈巡检（默认开启；SELF_HEAL=off 关闭、=dry 只观察）
  startSelfHealScheduler();
  // 预热本地 embedding 模型（后台加载，不阻塞启动；用于「全量记忆召回」）
  ensureEmbeddingReady().then((ok) => {
    console.log(`🧠 [Embedding] semantic-recall model ${ok ? 'ready' : 'unavailable (fallback to recent-window)'}`);
  }).catch(() => { /* 忽略 */ });
  // 预热本地语音识别 Whisper 模型（后台加载，不阻塞启动；用于「语音输入」）
  ensureAsrReady().then((ok) => {
    console.log(`🎙 [ASR] whisper model ${ok ? 'ready' : 'unavailable (voice input disabled)'}`);
  }).catch(() => { /* 忽略 */ });
});

/**
 * close server
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received');
  stopSidecar();
  try { quotaStore.flushNow(); } catch { /* 忽略 */ }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received');
  stopSidecar();
  try { quotaStore.flushNow(); } catch { /* 忽略 */ }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
