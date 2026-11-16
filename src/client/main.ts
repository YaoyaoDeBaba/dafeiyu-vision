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
