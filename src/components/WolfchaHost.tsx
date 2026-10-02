/**
 * 狼人杀 = wolfcha 子应用（Apache-2.0，署名见 src/wolfcha/LICENSE 与 docs/werewolf-porting.md）
 * 挂载方式对齐「千世书」：页面只做 lazy 加载 + 顶栏返回。
 *
 * 移动端适配要点：
 *  - 用 `100dvh`（动态视口高度）而不是 `100vh`：iOS Safari 的地址栏收起/展开会把 100vh 内容截断；
 *  - 顶栏做成**浮层**（absolute + 渐变），不占用游戏布局高度，让牌桌拿到完整视口；
 *  - 子应用自己的响应式（CSS 断点 + isMobile 动画）已经在编译好的 wolfcha.css 里，这里不重复实现。
 */
import { lazy, Suspense } from 'react';
import { ArrowLeft } from 'lucide-react';
import { t } from '../i18n';

const WolfchaApp = lazy(() => import('./WolfchaApp'));

export default function WolfchaHost({ onBack }: { onBack?: () => void }) {
  return (
    <div className="ww-scope fixed inset-0 z-40 bg-black h-[100dvh] w-full overflow-hidden">
      {/* 返回浮层：pointer-events 只落在按钮上，其余区域交给牌桌 */}
      {/* ⚠️ 层级必须高于子应用：它在 DOM 里排在我之后，两者都定位时它压住我
          实测桌面端对局内返回按钮被它的顶栏盖住、用户退不出去。
          另外按钮给**实底**，不依赖底层是深色还是浅色主题（桌面端是浅色羊皮纸）。 */}
      {/* safe-area：PWA/全面屏下别把「返回」压在状态栏/灵动岛下面 */}
      <div
        className="absolute top-0 left-0 right-0 z-[60] flex items-center gap-2 px-3 pb-2.5 text-xs pointer-events-none"
        style={{ paddingTop: 'max(10px, env(safe-area-inset-top))' }}
      >
        <button
          onClick={onBack}
          className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/65 px-3 py-1.5 text-white backdrop-blur-sm shadow-md hover:bg-black/80"
          aria-label={t('back')}
        >
          <ArrowLeft className="w-4 h-4" /> {t('back')}
        </button>
      </div>
      <div className="w-full h-full">
        <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-white/60 text-sm">加载狼人杀…</div>}>
          <WolfchaApp />
        </Suspense>
      </div>
    </div>
  );
}
