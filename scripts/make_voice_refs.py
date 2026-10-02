"""
生成音色参考音频（方案②"自举"，2026-09-15）

⚠️ 为什么不能提交仓库：参考音频在 `third_party/voice-refs/`，而 **`third_party/` 被 .gitignore 忽略**
   （与 VoxCPM 模型目录同属本机资产）。换机器/重装后跑一次本脚本即可重建；
   否则 /tts 会因 reference 找不到而 400 → 逐级回退 CosyVoice（未部署）→ msedge（音色不同）。

🔴 为什么脚本里要"测基频 + 重试"（2026-09-15 用户反馈"语音性别应与主角性别一致"）：
   文本音色设计对**性别**的遵循度很不可靠，实测 8 个参考里有 5 个音区是反的：
   `steady-m`/`deep-m`（**30 部剧本里 23 部在用**）实际落在 ~232/235Hz 的**女声区**，
   而 `bright-f`/`cool-f` 反而是 ~128/136Hz 的**男声区**。
   所以现在**生成后立刻测 F0，落在目标音区才收**，不合格就换一句参考文本重生成（换文本 = 换 seed）。
   判据：男声 < 165Hz（deep 更严 < 150），女声 ≥ 165Hz。

用法：python scripts/make_voice_refs.py [--only gentle-f,warm-f]
"""
import json, urllib.request, base64, os, sys, io, wave
import numpy as np

SIDE = os.environ.get("VOXCPM_URL", "http://127.0.0.1:8003").rstrip("/") + "/tts"
REF_DIR = os.path.join("third_party", "voice-refs")

# 候选参考文本：内容中性、自然口语。换一句 = 换 seed（seed = hash(音色, 文本)）
REF_TEXTS = [
    "今天的风很轻，路边的树影一直在动。",
    "窗外的雨停了，空气里有青草的味道。",
    "街角的灯刚刚亮起，行人慢慢走过。",
    "他把杯子放在桌上，抬头看了我一眼。",
    "我记得那天的阳光很好，街上的人都在笑，只有我们两个人沉默着往前走。",
    "她说这句话的时候声音很轻，像是怕被谁听见，又像是说给自己听的。",
    "夜色一点一点沉下来，远处的灯次第亮起，把整条街照得温暖而安静。",
    "如果时间可以停在这一刻，我希望它停得久一点，再久一点。",
]

# 音色参考的**强化设计串**（只用于生成参考音频；线上 storyVoice.ts 的 design 不参与剧情配音，
# 因为剧情走克隆路径，所以这里可以放心加 masculine / feminine / deep pitch 这类词）
PRESETS = [
    ("gentle-f",   "female",  170, "young adult female voice, feminine, soft and gentle tone, clear and natural"),
    ("warm-f",     "female",  170, "young adult female voice, feminine, warm and clear tone"),
    ("bright-f",   "female",  170, "young adult female voice, feminine, bright and lively tone"),
    ("cool-f",     "female",  170, "young adult female voice, feminine, calm and cool tone"),
    ("steady-m",   "male",    160, "adult male voice, masculine, warm and magnetic tone, chest resonance"),
    ("deep-m",     "male",    150, "adult male voice, masculine, very deep and low pitch, chest resonance"),
    ("youthful-m", "male",    160, "young adult male voice, masculine, clear and bright tone"),
    ("calm-n",     "neutral", 165, "adult voice, calm and intellectual tone"),
]


def post(payload, timeout=300):
    req = urllib.request.Request(SIDE, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return base64.b64decode(json.loads(r.read())["audioBase64"])


def f0_median(raw: bytes) -> float:
    """自相关法测基频中位数（Hz）。男声 85–155 / 女声 165–255，分界取 165。"""
    with wave.open(io.BytesIO(raw)) as w:
        sr = w.getframerate()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    if a.size == 0:
        return 0.0
    a /= (np.abs(a).max() + 1e-9)
    win, hop = int(0.04 * sr), int(0.02 * sr)
    lo, hi = int(sr / 320), int(sr / 70)
    f0s = []
    for i in range(0, len(a) - win, hop):
        seg = a[i:i + win]
        if np.sqrt((seg ** 2).mean()) < 0.05:
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, mode="full")[win - 1:]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        lag = int(np.argmax(ac[lo:hi])) + lo
        if ac[lag] < 0.3:
            continue
        f0s.append(sr / lag)
    return float(np.median(f0s)) if f0s else 0.0


def ok_for(kind: str, f0: float, cut: float) -> bool:
    if f0 <= 0:
        return False
    if kind == "male":
        return f0 < cut            # 男声：低于分界（deep 要求更低）
    if kind == "female":
        return f0 >= 165           # 女声：不低于 165Hz
    return True                    # 中性不设限


TARGET_F0 = {"male": 125.0, "female": 195.0, "neutral": 0.0}


def pitch_fix(raw: bytes, kind: str, f0: float) -> tuple[bytes, float]:
    """兜底：用 ffmpeg rubberband **保共振峰**变调，把参考拉进目标音区。
    为什么需要（2026-09-15）：换文本（换 seed）试完仍可能不合格
    文本音色设计对性别本来就不可靠，这是最后一道保障。变调过的参考只用来定音色，
    音高对了、共振峰保留，克隆出来的性别也就对了。"""
    import subprocess, tempfile
    target = TARGET_F0.get(kind, 0.0)
    if target <= 0 or f0 <= 0:
        return raw, f0
    ratio = target / f0
    if 0.97 <= ratio <= 1.03:
        return raw, f0
    with tempfile.TemporaryDirectory() as td:
        src, dst = os.path.join(td, "in.wav"), os.path.join(td, "out.wav")
        open(src, "wb").write(raw)
        try:
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                            "-af", f"rubberband=pitch={ratio:.4f}:formant=preserved",
                            "-ar", "48000", "-ac", "1", dst], check=True, timeout=180)
            fixed = open(dst, "rb").read()
        except Exception as e:  # ffmpeg 不在/失败 → 保留原样并如实记录
            print(f"    [warn] 变调失败（保留原音频）: {e}")
            return raw, f0
    return fixed, f0_median(fixed)


args = sys.argv[1:]
verify_only = "--verify-only" in args
only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
os.makedirs(REF_DIR, exist_ok=True)

manifest = []
for name, kind, cut, design in PRESETS:
    if only and name not in only:
        continue
    if verify_only:
        # 只体检：量现有文件、重建清单，不改动任何音频
        p = os.path.join(REF_DIR, name + ".wav")
        if not os.path.exists(p):
            print(f'{name:11s} 目标={kind:7s} (缺文件)')
            manifest.append({"name": name, "kind": kind, "f0": 0, "ok": False, "text": "", "design": design, "pitchCorrected": None})
            continue
        f0 = f0_median(open(p, "rb").read())
        txt_path = os.path.join(REF_DIR, name + ".txt")
        text = open(txt_path, encoding="utf-8").read().strip() if os.path.exists(txt_path) else ""
        good = ok_for(kind, f0, cut)
        manifest.append({"name": name, "kind": kind, "f0": round(f0, 1), "ok": good, "text": text, "design": design, "pitchCorrected": None})
        print(f'{name:11s} 目标={kind:7s} F0={f0:6.1f}Hz  {"OK " if good else "FAIL"}  (只校验)')
        continue
    best = None
    for text in REF_TEXTS:
        raw = post({"text": text, "voice": design, "cfg_value": 2.0, "inference_timesteps": 10})
        f0 = f0_median(raw)
        if best is None or abs(f0 - 165) < abs(best[1] - 165):
            best = (raw, f0, text)
        if ok_for(kind, f0, cut):
            break
    raw, f0, text = best
    corrected = False
    if not ok_for(kind, f0, cut):
        raw2, f0b = pitch_fix(raw, kind, f0)
        if raw2 is not raw:
            corrected = True
            print(f'    [变调] {f0:.1f}Hz → {f0b:.1f}Hz（目标 {TARGET_F0.get(kind)}Hz，保共振峰）')
            raw, f0 = raw2, f0b
    open(os.path.join(REF_DIR, name + ".wav"), "wb").write(raw)
    open(os.path.join(REF_DIR, name + ".txt"), "w", encoding="utf-8").write(text)
    good = ok_for(kind, f0, cut)
    manifest.append({"name": name, "kind": kind, "f0": round(f0, 1), "ok": good,
                     "text": text, "design": design, "pitchCorrected": corrected})
    print(f'{name:11s} 目标={kind:7s} F0={f0:6.1f}Hz  {"OK " if good else "FAIL"}  文本="{text}"')

json.dump(manifest, open(os.path.join(REF_DIR, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
bad = [m for m in manifest if not m["ok"]]
print("\n参考库:", REF_DIR)
print("不合格:", "无" if not bad else ", ".join('%s(%sHz)' % (b["name"], b["f0"]) for b in bad))
