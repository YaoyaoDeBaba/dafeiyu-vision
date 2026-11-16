/**
 * client/rooms —— 向大肥鱼宿主「房间管理器」领**两间**房：设置页的「肥鱼识图」与「小云雀」。
 *
 * ## 背景（2026-11-16 · 大肥鱼 .84 的房间注册制）
 *
 * 设置页不再是"五个写死的 tab"，而是"本体三块 + 若干住客"。住客在**另一个包**里，
 * 不能 import 本体代码，于是两边只有一个最小契约：
 *
 * ```ts
 * window.__dafeiyuRooms.register({
 *   id: 'vision',            // [a-z0-9][a-z0-9-]{1,31}，全页唯一
 *   label: '肥鱼识图',        // tab 上显示的字
 *   order: 40,               // 越小越靠前
 *   mount(container) { … ; return () => { … } },   // 切走 / 卸载时本体调它
 * })
 * ```
 *
 * 本体在 `apply` 最前面把注册表挂出来并派发 `dafeiyu:rooms-ready`；
 * 住客先起来也没关系——这里 `waitForRooms()` 监听那个事件（两端都留 1500ms 超时）。
 *
 * ## 四条纪律（前三条直接来自验收）
 *
 * 1. 拿不到注册表 = **宿主版本旧** → 静默放弃，返回 `undefined`；
 *    **不许 console.error**（那是降级，不是故障，一行红字会把真故障埋掉）。
 * 2. `mount` 返回的清理函数必须真的干净：React 树要 `unmount`、节点要摘、定时器要清
 *    （验收会盯"切走 tab 后定时器归零"，见 `stats`）。
 * 3. `mount` 自己兜住错误：抛出去只会让宿主显示"这个模块起不来"，我们更想在自己那一栏说清楚。
 * 4. 注册本身可以失败（`register` 抛、id 不合法）：**两间房互不牵连**，
 *    一间挂不上另一间照旧。
 *
 * ## 为什么 mount 工厂是**注入**的
 *
 * 这个文件既要在浏览器里跑，也要能在 `node:test` 的 vm 沙箱里被单测
 * （判据：两间房都注册了 / 拿不到宿主不抛 / 清理函数真被调用）。
 * 渲染那一半（React + createRoot）在 `main.ts` 里接进来，这里只认"给我一个容器、还我一个清理函数"。
 */

/** 容器的最小形状（刻意不写 `HTMLElement`：vm 沙箱里给的是假节点）。 */
export interface RoomContainer {
  appendChild: (node: unknown) => unknown
}

/** 一间房：住客提供全部内容，宿主只提供容器与生命周期。 */
export interface DafeiyuRoom {
  id: string
  label: string
  order?: number
  mount: (container: RoomContainer) => void | (() => void)
}

/** 注册表对外的形状（`window.__dafeiyuRooms`，本体 `client/rooms.ts` 提供）。 */
export interface RoomHost {
  version?: number
  register: (room: DafeiyuRoom) => () => void
}

/**
 * 本包要的两间房——**id / label / order 就是契约本身**，别处不许再写一遍。
 *
 * `order` 40 / 50 沿用本体分栏定稿的顺序：本体自己的四栏是 10/20/30/无，
 * 「肥鱼识图」排在「Agent 团队」之后、「小云雀」之前。
 */
export const ROOM_DEFINITIONS: ReadonlyArray<{ id: string; label: string; order: number }> = [
  { id: 'vision', label: '肥鱼识图', order: 40 },
  { id: 'xyq', label: '小云雀', order: 50 },
]

/** 每间房怎么装修：给容器、还清理函数（由 `main.ts` 用 React 实现）。 */
export type RoomRenderers = Record<string, (container: RoomContainer) => (() => void) | void>

/**
 * 自证用的计数器：验收要求"切走 tab 后定时器归零"。
 *
 * `mounted` / `disposed` 由这里维护（每挂一次 +1、每清一次 +1）；
 * `timerAlive` 由具体房的实现自己维护（React 那半用不上定时器，恒为 false，
 * 但**字段要在**——宿主侧与验收脚本按同一个名字读）。
 */
interface RoomStats {
  mounted: number
  disposed: number
  timerAlive: boolean
}

const STATS_KEY = '__dafeiyuVisionRoomStats'

function statsOf(): RoomStats {
  const scope = globalThis as unknown as Record<string, RoomStats | undefined>
  if (scope[STATS_KEY] === undefined) scope[STATS_KEY] = { mounted: 0, disposed: 0, timerAlive: false }
  return scope[STATS_KEY] as RoomStats
}

/**
 * 等宿主把注册表挂出来（本体的 client 可能比我们晚加载）。拿不到就静默放弃。
 *
 * ⚠️ 两个出口都**只 resolve**：没有 `window` 的（vm 沙箱 / 宿主侧）直接给 `undefined`；
 * 有 window 但 1500ms 内没等到事件，也 resolve `undefined`。
 * 任何一步抛出都吞掉——这条路径专门跑在"宿主版本旧"这种常态上。
 */
export function waitForRooms(ms = 1500): Promise<RoomHost | undefined> {
  const scope = globalThis as unknown as { __dafeiyuRooms?: RoomHost }
  if (scope.__dafeiyuRooms) return Promise.resolve(scope.__dafeiyuRooms)
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      try {
        globalThis.removeEventListener?.('dafeiyu:rooms-ready', finish)
      } catch {
        /* ignore */
      }
      resolve(scope.__dafeiyuRooms)
    }
    try {
      globalThis.addEventListener?.('dafeiyu:rooms-ready', finish)
    } catch {
      resolve(undefined)
      return
    }
    // 没有 addEventListener（vm 沙箱）时 setTimeout 仍然在：到点就 resolve undefined。
    setTimeout(finish, ms)
  })
}

/** `mount` 的包装：计一次挂载、返回一个**真的干净**、且幂等的清理函数。 */
function mountWith(stats: RoomStats, render: ((container: RoomContainer) => (() => void) | void) | undefined) {
  return (container: RoomContainer): (() => void) => {
    stats.mounted += 1
    let dispose: (() => void) | undefined
    if (render !== undefined) {
      try {
        const returned = render(container)
        if (typeof returned === 'function') dispose = returned
      } catch (error) {
        // 装修崩了：把原因写在**这一栏**里（宿主那一栏照常渲染，其余 tab 不受影响）。
        try {
          const node = container as unknown as { textContent?: unknown }
          node.textContent = `这个模块起不来：${String((error as Error)?.message ?? error).slice(0, 160)}`
        } catch {
          /* 假容器没有 textContent：忽略 */
        }
      }
    }
    let cleaned = false
    return () => {
      if (cleaned) return
      cleaned = true
      try {
        dispose?.()
      } catch {
        /* 清理不许抛：它跑在宿主的 switch tab 路径上 */
      }
      stats.disposed += 1
      stats.timerAlive = false
    }
  }
}

/**
 * 把两间房登记进宿主注册表。
 *
 * 单间失败只丢那一间（`register` 抛 / id 撞了），并返回一个把**已登记**的都撤掉的 `stop`。
 * 用 vm 单测时直接调它：传一个假 host 就能验"id/label 对不对""清理函数有没有被调用"。
 */
export function registerRooms(host: RoomHost, renderers: RoomRenderers): { stop: () => void } {
  const stats = statsOf()
  const disposers: Array<() => void> = []
  for (const definition of ROOM_DEFINITIONS) {
    const render = renderers[definition.id]
    try {
      const unregister = host.register({
        id: definition.id,
        label: definition.label,
        order: definition.order,
        mount: mountWith(stats, render),
      })
      if (typeof unregister === 'function') disposers.push(unregister)
    } catch {
      /* 这一间挂不上：另一间照旧（宿主版本旧、id 撞了都走这里） */
    }
  }
  return {
    stop(): void {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 注销不许抛 */
        }
      }
    },
  }
}

/**
 * 等注册表 → 登记两间房。拿不到注册表就**静默返回 undefined**（宿主版本旧，不算故障）。
 *
 * `main.ts` 的 `apply` 用这个；测试里用 `registerRooms`（省掉那 1500ms 等待）。
 */
export async function registerDafeiyuRooms(
  renderers: RoomRenderers,
  ms = 1500,
): Promise<{ stop: () => void } | undefined> {
  const host = await waitForRooms(ms)
  if (host === undefined) return undefined
  try {
    return registerRooms(host, renderers)
  } catch {
    return undefined
  }
}
