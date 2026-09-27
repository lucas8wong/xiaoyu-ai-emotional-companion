/**
 * 图片上传 + 自选裁剪（纯前端，无第三方依赖）
 * - 选择图片后若自然尺寸超过阈值 → 自动进入裁剪工具
 * - 也可随时手动「裁切」重新调整选区
 * - 头像：锁定 1:1 正方形选区；聊天背景图：自由比例选区
 * - 结果统一用 canvas 输出为 JPEG data URL（降采样，避免撑爆 JSON）
 */
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Upload, Crop, X, Image as ImageIcon } from 'lucide-react';
import { t } from '../i18n';
import { pushDeepBackHandler } from '../lib/deepBack';

type CropBox = { x: number; y: number; w: number; h: number };
type DragType = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface ImageUploadCropProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  /** >0 时锁定裁剪宽高比（如 1 = 正方形）；undefined = 自由比例 */
  aspect?: number;
  /** 固定比例下输出边长（如 512）；自由比例时按最大宽/高缩放 */
  outputWidth?: number;
  /** 预览是否圆形裁剪（头像） */
  circle?: boolean;
  id?: string;
}

const RAW_MAX_BYTES = 8 * 1024 * 1024;
const AUTO_CROP_DIM = 2048; // 自然宽/高任一边超过则自动进入裁剪
const FREE_OUTPUT_MAX_W = 1536;
const FREE_OUTPUT_MAX_H = 1024;
const CROP_CONTAINER_H = 320;
const MIN_BOX = 48;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

function fitPoint(e: ReactPointerEvent, rect: DOMRect): { x: number; y: number } {
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export default function ImageUploadCrop({ label, hint, value, onChange, aspect, outputWidth, circle, id }: ImageUploadCropProps) {
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState('');
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [cw, setCw] = useState(0); // 裁剪容器内容宽度
  const [crop, setCrop] = useState<CropBox | null>(null);
  const [processing, setProcessing] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ type: DragType; sx: number; sy: number; box: CropBox } | null>(null);

  /**
   * 手机返回键 / 浏览器后退：裁剪弹层也是一层 → 先关掉它，而不是让调用方（如剧情模式）被整体退掉一层。
   * 只在开着的时候注册（挂载即「更深」→ 排在调用方处理器之后，先被问到）。
   */
  useEffect(() => {
    if (!open) return;
    return pushDeepBackHandler(() => { setOpen(false); return true; });
  }, [open]);

  // 计算图片在裁剪容器中的显示尺寸（object-contain 等比缩放，居中）
  const disp = nat.w > 0 && nat.h > 0 && cw > 0
    ? (() => {
        const s = Math.min(cw / nat.w, CROP_CONTAINER_H / nat.h);
        return { w: nat.w * s, h: nat.h * s };
      })()
    : { w: 0, h: 0 };
  // 自适应最小选区边长：极短/极窄图片时允许更小的选区，避免 clamp 越界
  const minBox = Math.max(1, Math.min(MIN_BOX, Math.min(disp.w, disp.h)));

  // 打开裁剪时测量容器宽度（响应容器/窗口变化）
  useLayoutEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    const update = () => setCw(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // 初始化选区（仅在第一次进入裁剪、选区为空时）
  useEffect(() => {
    if (!open || disp.w <= 0 || crop) return;
    if (aspect) {
      const side = Math.max(Math.min(MIN_BOX, Math.min(disp.w, disp.h)), Math.min(disp.w, disp.h) * 0.9);
      setCrop({ x: (disp.w - side) / 2, y: (disp.h - side) / 2, w: side, h: side });
    } else {
      const m = Math.max(4, Math.min(disp.w, disp.h) * 0.04);
      setCrop({ x: m, y: m, w: disp.w - 2 * m, h: disp.h - 2 * m });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, disp.w, disp.h, aspect]);

  /** 把「自然坐标」下的选区导出为 JPEG data URL（降采样到目标分辨率） */
  function exportNatural(im: HTMLImageElement, box: CropBox, natW: number, natH: number): string {
    const sx = clamp(Math.round(box.x), 0, natW - 1);
    const sy = clamp(Math.round(box.y), 0, natH - 1);
    const sw = clamp(Math.round(box.w), 1, natW - sx);
    const sh = clamp(Math.round(box.h), 1, natH - sy);
    let outW: number;
    let outH: number;
    if (aspect) {
      outW = outH = Math.max(1, outputWidth || 512);
    } else {
      outW = Math.min(Math.round(sw), FREE_OUTPUT_MAX_W);
      outH = Math.max(1, Math.round(outW * sh / sw));
      if (outH > FREE_OUTPUT_MAX_H) {
        outH = FREE_OUTPUT_MAX_H;
        outW = Math.max(1, Math.round(sw / sh * outH));
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, sx, sy, sw, sh, 0, 0, outW, outH);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  /** 把「显示坐标」下的选区映射回自然坐标后导出 */
  function exportBox(box: CropBox): string {
    const im = imgElRef.current;
    if (!im || disp.w <= 0 || disp.h <= 0) return '';
    const natBox = {
      x: box.x / disp.w * nat.w,
      y: box.y / disp.h * nat.h,
      w: box.w / disp.w * nat.w,
      h: box.h / disp.h * nat.h,
    };
    return exportNatural(im, natBox, nat.w, nat.h);
  }

  /** 小图（未超阈值）：直接以「默认选区」导出（头像居中裁方、背景整图） */
  function exportWhole(im: HTMLImageElement): string {
    const w = im.naturalWidth;
    const h = im.naturalHeight;
    const box: CropBox = aspect
      ? (() => { const side = Math.min(w, h); return { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side }; })()
      : { x: 0, y: 0, w, h };
    return exportNatural(im, box, w, h);
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = ''; // 允许再次选择同一文件
    if (!/^image\//.test(f.type)) { setErr(t('rpImgTypeError')); return; }
    if (f.size > RAW_MAX_BYTES) { setErr(t('rpImgSizeError')); return; }
    setErr('');
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const im = new Image();
      im.onload = () => {
        imgElRef.current = im;
        setSrc(url);
        setNat({ w: im.naturalWidth, h: im.naturalHeight });
        const tooBig = im.naturalWidth > AUTO_CROP_DIM || im.naturalHeight > AUTO_CROP_DIM;
        if (tooBig) {
          setCrop(null);
          setOpen(true);
        } else {
          const result = exportWhole(im);
          if (result) onChange(result);
          setOpen(false);
        }
      };
      im.src = url;
    };
    reader.readAsDataURL(f);
  }

  function onPointerDown(e: ReactPointerEvent, type: DragType) {
    if (!imgWrapRef.current || !crop) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = imgWrapRef.current.getBoundingClientRect();
    const p = fitPoint(e, rect);
    dragRef.current = { type, sx: p.x, sy: p.y, box: { ...crop } };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent) {
    const d = dragRef.current;
    if (!d || !imgWrapRef.current || disp.w <= 0 || disp.h <= 0) return;
    const rect = imgWrapRef.current.getBoundingClientRect();
    const p = fitPoint(e, rect);
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    const o = d.box;

    if (d.type === 'move') {
      const x = clamp(o.x + dx, 0, disp.w - o.w);
      const y = clamp(o.y + dy, 0, disp.h - o.h);
      setCrop({ x, y, w: o.w, h: o.h });
      return;
    }

    // 四角缩放
    let newLeft = o.x;
    let newTop = o.y;
    let newRight = o.x + o.w;
    let newBottom = o.y + o.h;
    if (d.type.includes('w')) newLeft = clamp(o.x + dx, 0, o.x + o.w - minBox);
    if (d.type.includes('e')) newRight = clamp(o.x + o.w + dx, o.x + minBox, disp.w);
    if (d.type.includes('n')) newTop = clamp(o.y + dy, 0, o.y + o.h - minBox);
    if (d.type.includes('s')) newBottom = clamp(o.y + o.h + dy, o.y + minBox, disp.h);

    if (aspect) {
      // 保持正方形：以对角为锚，取变动后的最小一致边长
      const side = Math.min(newRight - newLeft, newBottom - newTop);
      let x = o.x;
      let y = o.y;
      if (d.type.includes('w')) x = newRight - side; else x = newLeft;
      if (d.type.includes('n')) y = newBottom - side; else y = newTop;
      setCrop({ x, y, w: side, h: side });
    } else {
      setCrop({ x: newLeft, y: newTop, w: newRight - newLeft, h: newBottom - newTop });
    }
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  function onConfirm() {
    if (!crop) return;
    setProcessing(true);
    try {
      const result = exportBox(crop);
      if (result) onChange(result);
      setOpen(false);
    } finally {
      setProcessing(false);
    }
  }

  function onRemove() {
    onChange('');
    setSrc('');
    setNat({ w: 0, h: 0 });
    setErr('');
  }

  const inputId = id || 'img-crop-' + label.replace(/\s+/g, '-').toLowerCase();

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-gray-600">{label}</label>
      {hint && <p className="text-[11px] text-ink-soft leading-snug">{hint}</p>}
      {err && <p className="text-xs text-red-500">{err}</p>}
      <div className="flex items-center gap-3">
        {value ? (
          <div className={circle ? 'w-14 h-14 rounded-full overflow-hidden ring-1 ring-primary/20 flex-shrink-0' : 'w-16 h-16 rounded-xl overflow-hidden ring-1 ring-gray-200 flex-shrink-0'}>
            <img src={value} alt={label} loading="lazy" decoding="async" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className={circle ? 'w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0' : 'w-16 h-16 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0'}>
            <ImageIcon className="w-5 h-5 text-ink-soft" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={inputId} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-clay-border bg-white text-[12px] font-medium text-gray-600 hover:border-primary hover:text-primary-text transition-colors cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            {value ? t('rpImgReupload') : t('rpImgUpload')}
          </label>
          {value && (
            <button type="button" onClick={() => { setCrop(null); setOpen(true); }} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-clay-border bg-white text-[12px] font-medium text-gray-600 hover:border-primary hover:text-primary-text transition-colors">
              <Crop className="w-3.5 h-3.5" />
              {t('rpImgCrop')}
            </button>
          )}
          {value && (
            <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 px-2 py-2 rounded-xl text-ink-soft hover:text-red-500 transition-colors" aria-label={t('rpImgRemove')}>
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <input ref={fileRef} id={inputId} type="file" accept="image/*" className="hidden" onChange={onPickFile} />

      {open && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-base font-bold text-gray-800 flex items-center gap-1.5"><Crop className="w-4 h-4 text-primary" />{t('rpImgCrop')}</p>
              <button type="button" onClick={() => setOpen(false)} className="text-ink-soft hover:text-gray-600 p-1" aria-label={t('rpImgCropCancel')}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div ref={containerRef} className="relative w-full overflow-hidden rounded-xl bg-black/80" style={{ height: CROP_CONTAINER_H, touchAction: 'none' }}>
              {disp.w > 0 && (
                <div ref={imgWrapRef} className="absolute select-none" style={{ left: (cw - disp.w) / 2, top: (CROP_CONTAINER_H - disp.h) / 2, width: disp.w, height: disp.h }}>
                  <img src={src} alt="" draggable={false} className="w-full h-full object-fill" />
                  {crop && (
                    <div
                      className="absolute border-2 border-white"
                      style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', cursor: 'move' }}
                      onPointerDown={(e) => onPointerDown(e, 'move')}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                    >
                      {/* 四角缩放手柄 */}
                      {(['nw', 'ne', 'sw', 'se'] as DragType[]).map((t) => {
                        const posStyle = t === 'nw' ? { left: -5, top: -5 } : t === 'ne' ? { right: -5, top: -5 } : t === 'sw' ? { left: -5, bottom: -5 } : { right: -5, bottom: -5 };
                        return (
                          <div
                            key={t}
                            className="absolute w-2.5 h-2.5 rounded-full bg-white border border-gray-400"
                            style={{ ...posStyle, cursor: t.includes('n') ? (t.includes('w') ? 'nwse-resize' : 'nesw-resize') : (t.includes('w') ? 'nesw-resize' : 'nwse-resize') }}
                            onPointerDown={(e) => onPointerDown(e, t)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="text-[11px] text-ink-soft mt-2">{t('rpImgCropHint')}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setOpen(false)} className="flex-1 bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all">{t('rpImgCropCancel')}</button>
              <button type="button" onClick={onConfirm} disabled={processing || !crop} className="flex-1 bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary transition-all disabled:opacity-40">{t('rpImgCropConfirm')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
