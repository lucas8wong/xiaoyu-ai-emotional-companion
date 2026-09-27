/**
 * 音色参考库一致性（方案②"自举参考音频"）：
 * 每个 VOICE_PRESETS 的 id 都必须在侧车参考库里有对应的 `{id}.wav` + `{id}.txt`。
 *
 * 为什么值得为它写测试：预设 id 就是传给侧车的 `reference` 名。
 * 一旦新增预设却忘了生成参考（或改了文件名），`/tts` 会 400 → 静默逐级回退到 msedge，
 * **听起来只是"声音变了个样"**，很难察觉是自己漏了一步。这个测试把它变成一条硬失败。
 *
 * ⚠️ 参考库在 `third_party/voice-refs/`（**被 .gitignore 忽略**，本机资产），
 *    所以目录不存在时**跳过文件检查**（新克隆的仓库还没跑生成脚本），只校验 id 命名合法性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VOICE_PRESETS } from '../../src/lib/storyVoice.js';

const REF_DIR = join(process.cwd(), 'third_party', 'voice-refs');
const hasLib = existsSync(REF_DIR);

test('音色预设 id 必须能当参考名用（小写 kebab-case，无路径字符）', () => {
  assert.ok(VOICE_PRESETS.length >= 6, '预设数量异常');
  for (const p of VOICE_PRESETS) {
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `预设 id 不合法: ${p.id}`);
  }
  const ids = VOICE_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '预设 id 有重复');
});

test('每个预设都要有对应参考音频 + 文字稿（缺了会静默退化成 msedge）', { skip: !hasLib }, () => {
  for (const p of VOICE_PRESETS) {
    const wav = join(REF_DIR, p.id + '.wav');
    const txt = join(REF_DIR, p.id + '.txt');
    assert.ok(existsSync(wav), `缺参考音频: third_party/voice-refs/${p.id}.wav（跑 scripts/make_voice_refs.py）`);
    assert.ok(existsSync(txt), `缺文字稿: third_party/voice-refs/${p.id}.txt（必须与音频内容一致，否则克隆会输出截断的垃圾）`);
    assert.ok(statSync(wav).size > 20000, `参考音频过小: ${p.id}`);
    assert.ok(readFileSync(txt, 'utf8').trim().length > 4, `文字稿为空: ${p.id}`);
  }
});

/**
 * 🔴 参考音频的**性别音区**必须与预设声明一致。
 *
 * 为什么必须有这条（2026-09-15 用户反馈"语音性别应该按主角性别设置"）：
 * 逻辑与数据其实都对（30 部剧本的 ai.gender 齐全、零不匹配），**坏在生成的参考音频上** ——
 * 实测 8 个里 5 个音区是反的，而 `steady-m`/`deep-m`（30 部里 23 部在用）恰好是 ~232/235Hz 的**女声区**，
 * 于是"男角色听到女声"。生成脚本现在会**测 F0 不合格就换文本重生成、再不行保共振峰变调**，
 * 并把结果写进 manifest.json；这条测试就是防止有人重生成参考时又把它弄回去。
 */
test('参考音频的性别音区必须与预设一致（manifest.ok 全为 true）', { skip: !hasLib }, () => {
  const mf = join(REF_DIR, 'manifest.json');
  assert.ok(existsSync(mf), '缺 manifest.json（跑 scripts/make_voice_refs.py 生成）');
  const m = JSON.parse(readFileSync(mf, 'utf8')) as Array<{ name: string; kind: string; f0: number; ok: boolean }>;
  const byId = new Map(m.map((x) => [x.name, x]));
  for (const p of VOICE_PRESETS) {
    const row = byId.get(p.id);
    assert.ok(row, `manifest 缺条目: ${p.id}（重跑 scripts/make_voice_refs.py）`);
    assert.ok(row!.ok, `参考音频音区不合格: ${p.id} 实测 ${row!.f0}Hz（目标 ${row!.kind}）`);
    if (row!.kind === 'male') assert.ok(row!.f0 > 0 && row!.f0 < 165, `${p.id} 应为男声区，实测 ${row!.f0}Hz`);
    if (row!.kind === 'female') assert.ok(row!.f0 >= 165, `${p.id} 应为女声区，实测 ${row!.f0}Hz`);
  }
});
