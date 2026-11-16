/**
 * dsh-vision-dafeiyu —— 「大肥鱼识图 + 小云雀」的**宿主侧**入口。
 *
 * 这一半干的事**与大肥鱼本体里那两段一模一样**（只把启动块搬了家）：
 *   ① `startVision`：识图配置/识别/模型列表三条回环路由 + `recognize_image` 工具 + 提示词段；
 *   ② `startXyq`：小云雀八条回环路由 + 四个工具（生图/生视频/余额/模型）+ 使用提示。
 *
 * 搬家时**一个字都没改**（路由前缀、请求体、错误文案、存储路径全照旧）：
 *   - 识图：`/api/dsh-remote-dafeiyu/vision/{config,recognize,models}`
 *   - 小云雀：`/api/dsh-remote-dafeiyu/xyq/*`
 *   - 存储：`<DSH_HOME>/storages/dsh-remote-dafeiyu/{vision.json,xyq.json,xyq-output/}`
 * 为什么必须不变：手机协议、本体其它代码、用户已配好的 key 都指着这些路径，
 * 改名只会制造迁移成本与"配好就失效"的投诉。
 *
 * 纪律（与本体一致）：
 * 1. **不导出 `inject`**——宿主没有 `webServer` / `tools` / `systemPrompt` 时只是少那一块，
 *    而不是整条 entry 永远 pending（`src/vision/start.ts` / `src/xyq/start.ts` 里全是软探测）。
 * 2. 两段各自 `try/catch`：一个新工具起不来，不许把另一半带走。
 * 3. `apply()` 绝不向外抛异常——宿主加载 bundle 时抛出会让整个 profile 起不来。
 * 4. `stop()` 幂等，停机抛错只吞不抛。
 */
import { startVision, type VisionHandle } from './vision/start.js'
import { startXyq, type XyqHandle } from './xyq/start.js'
import { resolveDshHome } from './paths.js'

interface LooseContext {
  get?: (name: string, strict?: boolean) => unknown
  inject?: (names: string[], callback: (scoped: unknown) => void) => void
  effect?: (factory: () => (() => void) | void) => void
  on?: (event: string, listener: () => void) => void
}

export function apply(ctx: LooseContext): void {
  const log = (message: string, extra?: Record<string, unknown>): void => {
    try {
      // eslint-disable-next-line no-console
      console.log(`[vision] ${message}`, extra ?? '')
    } catch {
      /* 日志不许抛 */
    }
  }

  const dshHome = resolveDshHome(process.env)

  /**
   * 识图（原 `src/index.ts:1620-1628`，一字未改）。
   *
   * 注意 `dshHome` 是**原样**传进去的（`visionDir` 自己是
   * `path.join(dshHome, 'storages', 'dsh-remote-dafeiyu')`）：与本体同一个存储位置。
   */
  let visionHandle: VisionHandle | undefined
  try {
    visionHandle = startVision(ctx as never, { dshHome, log })
  } catch (error) {
    visionHandle = undefined
    log('识图服务起不来（远控/人设不受影响）', {
      message: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }

  /** 小云雀（原 `src/index.ts:1589-1597`，一字未改）。 */
  let xyqHandle: XyqHandle | undefined
  try {
    xyqHandle = startXyq(ctx as never, { dshHome: resolveDshHome(process.env), log })
  } catch (error) {
    xyqHandle = undefined
    log('小云雀能力起不来（远控/识图/记忆不受影响）', {
      message: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }

  const stop = (): void => {
    // 与本体 `stop()` 里那两句同一个顺序、同一条纪律：停机动作不许拖住停机。
    try {
      visionHandle?.stop()
    } catch {
      /* 停机动作不许拖住停机 */
    }
    try {
      xyqHandle?.stop()
    } catch {
      /* 停机动作不许拖住停机 */
    }
  }

  // 生命周期：优先 effect（cordis 的标准写法），退而求其次挂 dispose 事件。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stop)
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', stop)
    }
  } catch {
    /* ignore */
  }
}
