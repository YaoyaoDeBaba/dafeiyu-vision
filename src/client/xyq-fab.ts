/**
 * xyq-fab —— 「小云雀」快捷面板的**入口按钮**。
 *
 * ## 为什么需要新增这一颗（拆包时唯一的界面新增）
 *
 * 原实现里 `mountXyqQuick()` 只 `mount`（面板默认 `display:none`），
 * 真正打开它的是**形象小窗的菜单**（`onMenuAction('xyq')`，见本体 `main.ts:195`）。
 * 拆包之后那套菜单在 `dsh-avatar-dafeiyu` 里，而它的菜单回调只在它自己包内
 * （`widget.ts:96` 的 `onMenuAction` 由那个包的 `main.ts` 独占），本包拿不到，
 * 于是"面板在、打不开"。
 *
 * 这里给一颗同款的悬浮按钮（与鲸鱼按钮同一套视觉，落在它上面一格），
 * 点击就 `handle.open()`。样式刻意与 `vision-panel.ts` 的 `#dafeiyu-vision-fab`
 * 保持一致：同一页里两颗同功能的悬浮按钮不该长得不一样。
 *
 * 只做"打开 / 收拾"两件事：面板本身（`xyq-quick.ts`）一个字都没动。
 */

export interface XyqPanelHandle {
  open: () => void
  dispose: () => void
}

const STYLE_ID = 'dafeiyu-xyq-fab-style'

export function mountXyqFab(handle: XyqPanelHandle): () => void {
  const doc = (globalThis as { document?: Document }).document
  if (!doc || !doc.body) return () => undefined

  // 幂等：热重载时旧的样式先摘掉，否则会叠出两份（与 `xyq-quick.ts` 的 styleId 同一条处理）。
  doc.getElementById(STYLE_ID)?.remove()
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    #dafeiyu-xyq-fab { position: fixed; right: 20px; bottom: 140px; width: 44px; height: 44px; border-radius: 12px;
      border: 1px solid #1f3b63; background: #0d1117;
      color: #4b7bec; cursor: pointer; z-index: 2147483000; box-shadow: 0 4px 14px rgba(0,0,0,.3);
      display: flex; align-items: center; justify-content: center; font-size: 20px; }
    #dafeiyu-xyq-fab:hover { border-color: #4b7bec; }
  `
  doc.head?.appendChild(style)

  const fab = doc.createElement('button')
  fab.id = 'dafeiyu-xyq-fab'
  fab.type = 'button'
  fab.title = '小云雀：生成图片 / 视频'
  fab.textContent = '🎬'
  doc.body.appendChild(fab)

  const onClick = (event: Event): void => {
    /*
     * ⚠️ `stopPropagation` 是**必须**的，不是保险：
     * 快捷面板自己注册了一条 document 级的"点外面就关"监听（`xyq-quick.ts` 的 `onClick`
     * → `if (target && panel.contains(target)) return; panel.classList.remove('open')`）。
     * 这颗按钮**不在面板里**，所以同一次点击冒泡到 document 时会被那条监听判成"点在面板外面"，
     * 于是面板刚要出现就被关掉（点一下像没反应）。阻断冒泡 = 这一次点击不参与"点外面"的判定，
     * 之后点页面别处照常关面板。
     * 面板本身一个字没改：它的规则还是"点外面关"。
     */
    try {
      event.stopPropagation()
    } catch {
      /* ignore */
    }
    try {
      handle.open()
    } catch {
      /* 面板自己会兜；入口不许把页面带崩 */
    }
  }
  fab.addEventListener('click', onClick)

  return () => {
    try {
      fab.removeEventListener('click', onClick)
      fab.remove()
      style.remove()
    } catch {
      /* 页面可能已经卸载 */
    }
  }
}
