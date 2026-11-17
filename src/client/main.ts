/**
 * dsh-vision-dafeiyu —— 浏览器半边入口。
 *
 * ⚠️ `export const name` **必须等于包名**：`@deepseek-ai/dsh-client-modules` 按 loader entry 名
 * 索引这一半，名字对不上就静默不挂载（不报错、不崩，最难查）。
 * 三处必须一起对：本文件 / `cordis.patch.yml` 的 `name` / `package.json.name`。
 *
 * ## 这一半挂三样东西（对应拆包前的三处）
 *
 * | # | 东西 | 拆包前在哪 | 现在 |
 * |---|---|---|---|
 * | ① | 设置页两间房（「肥鱼识图」40 /「小云雀」50） | 本体 `dafeiyu-page.ts` 的两个写死 tab | `rooms.ts` → 本包注册 |
 * | ② | 聊天页右下角的鲸鱼按钮（FAB） | 本体 `main.ts` 的 `mountVisionFab` | 本文件挂 |
 * | ③ | 小云雀快捷面板 + 它的入口按钮 | 本体 `main.ts` 的 `mountXyqQuick`（由形象菜单打开） | 本文件挂 |
 *
 * ## 为什么不用 `inject`
 *
 * 本包不向宿主**要**任何服务：路由走 `fetch`（宿主侧挂的），React 走装载器的
 * platform seed（`react` / `react-dom/client`）。导出 `inject` 等于给这一半加一道
 * 服务闸门——那个服务没登记，整条 entry 就 **pending**（本体 `main.ts:48-69` 记着
 * 一次真实事故：`inject: []` 让 `apply()` 跑在槽位服务之前，面板直接不出现）。
 * 一个都不声明，这一半就一定会被激活。
 *
 * ## 所有失败都只降级、不抛
 *
 * 三块各自 `try/catch`：FAB 起不来不影响房间；房间起不来不影响 FAB；
 * 任何一块都不许让"整页起不来"。
 */
import { registerDafeiyuRooms, type RoomContainer, type RoomRenderers } from './rooms.js'
import { fallbackOnly, loadReact, mountReactTree, type ReactRuntime } from './react.js'
import { buildVisionTab } from './vision-tab.js'
import { buildXyqPanel } from './xyq-panel.js'
import { mountVisionFab } from './vision-panel.js'
import { mountXyqQuick } from './xyq-quick.js'
import { mountXyqFab } from './xyq-fab.js'

/** 必须与包的完整名一致：装载器按 loader entry 名（= 包名）来认这一半。 */
export const name = 'dsh-vision-dafeiyu'

/** 宿主没给 React 时画的那一行——**与本体 `dafeiyu-page.ts:300-308` 逐字一致**。 */
const FALLBACK_VISION = '肥鱼识图面板起不来（宿主没给 react hooks）。'
const FALLBACK_XYQ = '小云雀面板起不来（宿主没给 react hooks）。'

function swallow(message: string, error: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[vision] ${message}`, error)
  } catch {
    /* 日志不许抛 */
  }
}

/**
 * 房间的装修方案：把搬过来的那一栏（React 组件）挂进宿主给的容器。
 *
 * 组件**每次挂载现建一份**（`buildVisionTab` / `buildXyqPanel` 是工厂，内部闭包持有
 * `createElement` 与 hooks）：切走再切回来就是一棵新树，不会有上一轮的残留状态。
 */
function makeRenderers(): RoomRenderers {
  const render = (
    container: RoomContainer,
    build: (runtime: ReactRuntime) => (() => unknown) | undefined,
    fallback: string,
  ): (() => void) => {
    const runtime = loadReact()
    if (runtime === undefined) return fallbackOnly(container, fallback)
    let component: (() => unknown) | undefined
    try {
      component = build(runtime)
    } catch (error) {
      swallow('分栏组件构建失败（已吞掉）', error)
      return fallbackOnly(container, fallback)
    }
    return mountReactTree(runtime, container, component, fallback)
  }
  return {
    vision: (container) =>
      render(container, (runtime) => buildVisionTab({ createElement: runtime.createElement, hooks: runtime.hooks }), FALLBACK_VISION),
    xyq: (container) =>
      render(container, (runtime) => buildXyqPanel({ createElement: runtime.createElement, hooks: runtime.hooks }), FALLBACK_XYQ),
  }
}

/**
 * 跟着"形象在不在"同步入口可见性 —— **不用定时器**（2026-11-17 · 性能）。
 *
 * 原来是每秒一次的 setInterval：两次 getElementById + 可能写 hidden，从页面打开一直跑到
 * 插件卸载——DSH 开着一天就转一天。本体在 0.9.0-dafeiyu.103 已为同一件事改过口径
 * （不许用定时器做兜底同步，改 MutationObserver + 事件），这里对齐：
 *   1. `dafeiyu:rooms-ready`：住客（形象）晚于本包挂载时会派发；
 *   2. DOM 观察：形象小窗被移除/重建（客户端重挂、热重载）。
 * rAF 合并，一次变化最多算一次；没有 rAF 的环境（测试夹具）直接同步跑。
 * 返回清理函数：卸载时必须断开，否则每挂一次叠一份。
 */
function watchFabVisibility(sync: () => void): () => void {
  const scope = globalThis as {
    addEventListener?: (type: string, fn: () => void) => void
    removeEventListener?: (type: string, fn: () => void) => void
    requestAnimationFrame?: (cb: () => void) => unknown
    MutationObserver?: new (cb: () => void) => { observe: (node: unknown, options: unknown) => void; disconnect: () => void }
    document?: { body?: unknown }
  }
  let queued = false
  const run = (): void => {
    queued = false
    try {
      sync()
    } catch {
      /* 同步失败只影响"自动收起" */
    }
  }
  const schedule = (): void => {
    if (queued) return
    queued = true
    try {
      const raf = scope.requestAnimationFrame
      if (typeof raf === 'function') raf(run)
      else run()
    } catch {
      run()
    }
  }
  try {
    scope.addEventListener?.('dafeiyu:rooms-ready', schedule)
  } catch {
    /* 没有事件就算了 */
  }
  let observer: { disconnect?: () => void } | undefined
  try {
    const MO = scope.MutationObserver
    const body = scope.document?.body
    if (MO && body) {
      const mo = new MO(schedule)
      mo.observe(body, { childList: true, subtree: true })
      observer = mo
    }
  } catch {
    /* 没有 MutationObserver 就只靠事件那一条 */
  }
  return () => {
    try {
      scope.removeEventListener?.('dafeiyu:rooms-ready', schedule)
    } catch {
      /* ignore */
    }
    try {
      observer?.disconnect?.()
    } catch {
      /* ignore */
    }
  }
}

export function apply(): (() => void) | void {
  // ① 两间房。宿主版本旧（没有 `window.__dafeiyuRooms`）时 registerDafeiyuRooms 静默返回
  //    undefined —— 那不是故障，别 console.error。
  let rooms: { stop: () => void } | undefined
  void registerDafeiyuRooms(makeRenderers())
    .then((handle) => {
      rooms = handle
    })
    .catch((error: unknown) => swallow('房间注册失败（已吞掉）', error))

  // ② 聊天页那颗鲸鱼按钮。`injectText` 不传：本包拿不到本体的"会话注入"通道
  //    （那是 `ctx.sessions` 那一侧的东西），FAB 按设计退化成"看结果 + 复制"。
  //    要接回注入，得本体把通道暴露成跨包可用的形状（见交付报告）。
  let visionCleanup: (() => void) | undefined
  try {
    visionCleanup = mountVisionFab({})
  } catch (error) {
    swallow('识图按钮挂载抛错（已吞掉）', error)
  }

  /*
   * 有悬浮形象时，本包的两颗独立入口按钮（右下角的识图 FAB 与 🎬 云雀按钮）都收起来：
   * 那两个动作已经在形象的右键菜单里（由宿主派发 `dafeiyu:action`），再放两个按钮是重复入口，
   * 视觉上挤且容易点错。**没装/没启用形象**时才各自露出。
   *
   * "有没有形象"只认宿主房间注册表（`has('avatar')`）——住客自己宣布"我在"是唯一权威事实。
   * 每秒看一次：形象是别的包，装/卸/启停都不通知我们。
   */
  const VISION_FAB_ID = 'dafeiyu-vision-fab'
  const XYQ_FAB_ID = 'dafeiyu-xyq-fab'
  const avatarPresent = (): boolean => {
    try {
      const host = (globalThis as { __dafeiyuRooms?: { has?: (id: string) => boolean } }).__dafeiyuRooms
      if (typeof host?.has === 'function') {
        if (host.has('avatar') === true) return true
      }
    } catch {
      /* 注册表不可用：走下面的 DOM 兜底 */
    }
    // 兜底：注册表没给答案时，看形象小窗本体在不在（元素 id 是形象包的公开契约）。
    // 有它说明形象装着且挂上了，独立入口就该收起来。
    try {
      return globalThis.document?.getElementById('dafeiyu-avatar-widget') != null
    } catch {
      return false
    }
  }
  const syncFabVisibility = (): void => {
    const hide = avatarPresent()
    for (const id of [VISION_FAB_ID, XYQ_FAB_ID]) {
      const el = document.getElementById(id) as { hidden?: boolean } | null
      // 值没变就别写：写 hidden 会让宿主重算样式，白做
      if (el && el.hidden !== hide) el.hidden = hide
    }
  }
  /*
   * 宿主派发的菜单动作（2026-11-16 · 0.1.2）。
   *
   * 形象小窗的右键菜单在**形象包**里，它只负责派发 `dafeiyu:action`（detail.id）；
   * 宿主的接收端对这个包的动作是**空转**（能力已随包迁出），所以由本包自己接：
   *   `vision` → 点一下识图按钮（等价于用户点它）
   *   `xyq`    → 点一下云雀按钮
   * 用 click 而不是另开一套 open()，是为了让"菜单打开"和"按钮打开"走**同一条**路径，
   * 不会出现两种入口行为不一样（上一次就是这个坑：面板在、点了没反应）。
   */
  const onHostAction = (event: Event): void => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id
    if (id !== 'vision' && id !== 'xyq') return
    try {
      const target = globalThis.document?.getElementById(id === 'vision' ? VISION_FAB_ID : XYQ_FAB_ID)
      if (target && typeof (target as { click?: () => void }).click === 'function') {
        ;(target as unknown as { click: () => void }).click()
      }
    } catch {
      /* 打不开就什么都不做：绝不因为一个菜单项把页面搞崩 */
    }
  }
  try {
    globalThis.addEventListener?.('dafeiyu:action', onHostAction)
  } catch {
    /* 没有 window 就算了 */
  }

  /*
   * 入口收起的同步（2026-11-17 · 性能）。
   *
   * 原来是每秒一次定时器（每秒两次 getElementById + 可能写 hidden），
   * 从页面打开一直跑到插件卸载——DSH 开着一天就转一天。本体在 0.9.0-dafeiyu.103 已经为
   * 同一件事改过口径（**不许用定时器做兜底同步**，改 MutationObserver + 事件），这里对齐：
   *   · `dafeiyu:rooms-ready`（形象晚挂载）
   *   · DOM 观察（形象小窗被增删/重建），rAF 合并，没有常驻节拍
   */
  let stopFabSync: (() => void) | undefined
  try {
    syncFabVisibility()
    stopFabSync = watchFabVisibility(syncFabVisibility)
  } catch {
    /* 观察器起不来只影响"自动收起"，按钮照常在 */
  }

  // ③ 小云雀快捷面板 + 入口按钮。面板默认隐藏，只有点了 🎬 才出现。
  let xyqQuick: ReturnType<typeof mountXyqQuick> | undefined
  let xyqFabCleanup: (() => void) | undefined
  try {
    xyqQuick = mountXyqQuick()
    xyqFabCleanup = mountXyqFab(xyqQuick)
  } catch (error) {
    swallow('小云雀快捷面板挂载抛错（已吞掉）', error)
  }

  return () => {
    try {
      stopFabSync?.()
    } catch {
      /* 清理不许抛 */
    }
    try {
      globalThis.removeEventListener?.('dafeiyu:action', onHostAction)
    } catch {
      /* 清理不许抛 */
    }
    try {
      rooms?.stop()
    } catch {
      /* 注销不许抛 */
    }
    try {
      visionCleanup?.()
    } catch {
      /* 清理不许抛 */
    }
    try {
      xyqFabCleanup?.()
    } catch {
      /* 清理不许抛 */
    }
    try {
      xyqQuick?.dispose()
    } catch {
      /* 清理不许抛 */
    }
  }
}
