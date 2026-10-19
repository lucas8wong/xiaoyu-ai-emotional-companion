import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
const POLICY = 'android-media-v1';
type Plan = { kind: 'image'; edge: number; quality: number; format: 'webp' | 'jpeg' } | { kind: 'audio' };

export function androidMediaPlan(relative: string): Plan | undefined {
  // Keep UI artwork, pixel skins, QR codes, fonts, video and speech effects intact.
  if (/^assets\/[^/]+\.webp$/i.test(relative)) return { kind: 'image', edge: 1280, quality: 78, format: 'webp' };
  if (/^img\/.*\.(webp|jpe?g)$/i.test(relative)) return { kind: 'image', edge: 1600, quality: 82, format: /webp$/i.test(relative) ? 'webp' : 'jpeg' };
  if (/^(music|bgm)\/.*\.mp3$/i.test(relative)) return { kind: 'audio' };
  return undefined;
}

export async function compactAndroidImage(input: Buffer, plan: Extract<Plan, { kind: 'image' }>): Promise<Buffer> {
  const meta = await sharp(input, { animated: true }).metadata();
  if ((meta.pages || 1) > 1) return input;
  const image = sharp(input).rotate().resize({ width: plan.edge, height: plan.edge, fit: 'inside', withoutEnlargement: true });
  const output = await (plan.format === 'webp' ? image.webp({ quality: plan.quality, alphaQuality: 100, effort: 5 }) : image.jpeg({ quality: plan.quality, mozjpeg: true })).toBuffer();
  // Do not introduce another encoding generation for negligible savings.
  if (output.length >= input.length * 0.95) return input;
  const after = await sharp(output).metadata();
  if (!after.width || !after.height || Math.max(after.width, after.height) > plan.edge) throw new Error('Invalid optimized image');
  return output;
}

type Options = { root: string; cache: string; ffmpeg: string; ffprobe: string };
type AudioInfo = { streams: Array<{ codec_name: string; channels: number; sample_rate: string; bit_rate?: string }>; format: { duration: string } };
export async function optimizeAndroidBundle(options: Options) {
  const root = path.resolve(options.root);
  // This helper may only modify isolated generated builds, never public/ or user data.
  if (path.dirname(root) !== path.resolve('temp') || !path.basename(root).startsWith('android-web-')) throw new Error('Expected an isolated Android build directory');
  const cache = path.resolve(options.cache);
  if (cache !== path.resolve('temp/android-media-cache')) throw new Error('Unexpected media cache');
  await fs.mkdir(cache, { recursive: true });
  const ffmpegVersion = (await run(options.ffmpeg, ['-version'])).stdout.split('\n')[0];
  await run(options.ffprobe, ['-version']);
  const encoder = JSON.stringify({ policy: POLICY, sharp: sharp.versions, ffmpegVersion });
  const probe = async (file: string): Promise<AudioInfo> => JSON.parse((await run(options.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,sample_rate,bit_rate:format=duration', '-of', 'json', file])).stdout);
  const files: string[] = [];
  const collect = async (dir: string) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('Symlink in bundle');
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await collect(file); else files.push(file);
    }
  };
  await collect(root);
  const report = { policy: POLICY, files: files.length, changed: 0, beforeBytes: 0, afterBytes: 0, images: 0, audio: 0, cacheHits: 0 };
  let next = 0;
  // Bound libvips/encoder memory instead of running thousands of transforms at once.
  sharp.concurrency(1);
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const plan = androidMediaPlan(relative);
      const size = (await fs.stat(file)).size;
      report.beforeBytes += size;
      if (!plan) { report.afterBytes += size; continue; }
      const input = await fs.readFile(file);
      const key = crypto.createHash('sha256').update(encoder).update(JSON.stringify(plan)).update(input).digest('hex');
      const cached = path.join(cache, key + path.extname(file));
      let output: Buffer | undefined;
      // Cache entries have their own digest, so a truncated/corrupted entry is rebuilt.
      try {
        const bytes = await fs.readFile(cached);
        const hash = (await fs.readFile(cached + '.sha256', 'utf8')).trim();
        if (crypto.createHash('sha256').update(bytes).digest('hex') === hash) { output = bytes; report.cacheHits++; }
      } catch { /* cache miss */ }
      if (!output) {
        if (plan.kind === 'image') output = await compactAndroidImage(input, plan);
        else {
          const before = await probe(file);
          const source = before.streams[0];
          output = input;
          // Only high-bitrate background music is transcoded; retain stereo and duration.
          if (source?.codec_name === 'mp3' && Number(source.bit_rate) > 144000) {
            const temporary = cached + '.' + crypto.randomUUID() + '.encoding.mp3';
            try {
              await run(options.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-map', '0:a:0', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '128k', '-threads', '1', temporary], { timeout: 120000 });
              const after = await probe(temporary);
              const target = after.streams[0];
              if (!target || target.channels !== source.channels || target.sample_rate !== source.sample_rate || Math.abs(Number(after.format.duration) - Number(before.format.duration)) > 0.1) throw new Error('Audio continuity check failed: ' + relative);
              // Full decode catches truncation beyond the header/duration probe.
              await run(options.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', temporary, '-f', 'null', '-'], { timeout: 120000 });
              const bytes = await fs.readFile(temporary);
              if (bytes.length < input.length * 0.95) output = bytes;
            } finally { await fs.rm(temporary, { force: true }); }
          }
        }
        await fs.writeFile(cached, output);
        await fs.writeFile(cached + '.sha256', crypto.createHash('sha256').update(output).digest('hex'));
      }
      if (output.length < input.length) {
        // fs.cp preserves read-only artwork flags on Windows; only this generated copy
        // becomes writable. Original public/ and source artwork remain untouched.
        await fs.chmod(file, 0o666);
        await fs.writeFile(file, output);
        report.changed++;
        if (plan.kind === 'image') report.images++; else report.audio++;
      }
      report.afterBytes += output.length;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // Nothing was deleted, renamed or replaced with an external download dependency.
  for (const file of files) await fs.access(file);
  return report;
}
