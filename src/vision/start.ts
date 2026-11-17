/**
 * vision/start — 宿主侧接线：软探测 `webServer` 挂路由、provide 服务、注册 agent 工具、
 * 注入提示词段、把内置指南铺成 DSH skill。
 *
 * 与 `pill/start.ts` 同一条纪律：
 * 1. **不写 `inject:` 闸门**：这一半挂不上，远控/人设一行都不受影响。
 * 2. `stop()` 幂等；注销抛错只吞不抛。
 * 3. 任何失败都写进 `probe` + 一行日志，不静默。
 *
 * 0.1.6 起的两处关键变化（都是"agent 才是主入口"这条前提带来的）：
 * - **工具常注册**：以前只在启动时 `enabled` 才注册，导致"设置页打开识图后还得重启"。
 *   现在四个工具一直注册，开关是否开着由**调用时**实时判断（`recognize_image` 会报"识图未开启"）。
 * - **`tools` 是晚到服务**：`apply` 期间 `ctx.get('tools')` 可能还没有，所以轮询等它
 *   （最多 30 秒），而不是取一次没有就永远 `no-tools`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerVisionRoutes } from './routes.js'
import { createVisionService, type VisionService } from './service.js'
import { buildVisionTools } from './tools.js'
import { installBundledSkills, readVisionSkillBody, VISION_SKILL_NAME } from './skill.js'

interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  provide?(name: string, value: unknown): unknown
}

interface Registerable {
  register(route: { kind: 'exact'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }): () => void
}

interface ToolHost {
  register?: (definition: Record<string, unknown>) => unknown
}

export interface VisionHandle {
  stop(): void
  readonly probe: Record<string, string>
  readonly available: boolean
  readonly service: VisionService
  /** 给测试用：不启动轮询，手动喂一个 tools 服务。 */
  __attachTools?: (host: ToolHost) => boolean
}

/** 识图服务名：工具/别的插件软探测用。 */
export const VISION_SERVICE_NAME = 'dafeiyuVision'

/**
 * 提示词段：只说"有这能力、什么时候用、指南在哪"。
 *
 * 长内容在 skill 里（`assets/skills/dafeiyu-vision`），这段每个请求都占上下文，必须短。
 */
const GUIDANCE = [
  '## 识图能力',
  '你可以看懂图：调 `recognize_image({ image_path })` 把本地图片交给视觉能力，返回详细文本描述（含逐字转录），再基于描述回答。',
  '用户说「看看这张图 / 这个截图 / 这报错什么意思」并给出图片路径时用它；用户已经贴图的话你收到的是「【图片识别】」开头的文本，直接用，不要声称你看到了原图。',
  '识图走哪一路（API / 网页版免 key / 两路合并）由设置页决定；报错先看原文，完整指南见 skill `dafeiyu-vision`，或调 `vision_guide`。',
  '排障两件套：`vision_web_status` 查网页版登录态，`vision_web_login` 弹窗让用户登录（需要人在电脑前）。',
].join('\n')

/** 插件包根目录（dist/bundle/index.js → 上两级）。 */
function packageRoot(): string {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  } catch {
    return process.cwd()
  }
}

/** 插件版本：只写进 skill 的版本标记（幂等判据是指纹，不是它）。 */
function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function startVision(
  ctx: LooseContext,
  deps: { dshHome: string; log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void },
): VisionHandle {
  const service = createVisionService(deps.dshHome, deps.log)
  const probe: Record<string, string> = {}
  const skillAssetsRoot = path.join(packageRoot(), 'assets', 'skills', VISION_SKILL_NAME)
  let web: Registerable | undefined
  let unregister: (() => void) | undefined
  let started = false
  let stopped = false
  let toolsRegistered = false
  let toolPoll: NodeJS.Timeout | undefined

  // ── 内置 skill（指南真源）──
  // 放这里是因为 startVision 是插件启动时唯一稳定拿到 dshHome 的地方。
  try {
    const installed = installBundledSkills({
      dshHome: deps.dshHome,
      assetsRoot: path.join(packageRoot(), 'assets', 'skills'),
      version: packageVersion(),
      log: deps.log,
    })
    probe.skills = installed.ok ? `installed(${installed.installed.length})` : `skipped: ${installed.reason ?? 'unknown'}`
  } catch (error) {
    probe.skills = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }

  // ── 工具注册（晚到服务，轮询）──
  const attachTools = (host: ToolHost | undefined): boolean => {
    if (toolsRegistered || !host || typeof host.register !== 'function') return false
    try {
      const definitions = buildVisionTools(service, { guideBody: () => readVisionSkillBody(skillAssetsRoot), log: deps.log })
      for (const definition of definitions) host.register(definition)
      toolsRegistered = true
      probe.tools = `registered(${definitions.length})`
      return true
    } catch (error) {
      probe.tools = `threw: ${String((error as Error)?.message ?? error).slice(0, 120)}`
      return false
    }
  }
  if (!attachTools(ctx.get?.('tools', true) as ToolHost | undefined)) {
    probe.tools = probe.tools ?? 'pending'
    let waited = 0
    toolPoll = setInterval(() => {
      waited += 500
      if (stopped || toolsRegistered) {
        if (toolPoll) clearInterval(toolPoll)
        toolPoll = undefined
        return
      }
      if (attachTools(ctx.get?.('tools', true) as ToolHost | undefined)) {
        if (toolPoll) clearInterval(toolPoll)
        toolPoll = undefined
        deps.log('识图工具已注册（tools 服务晚到）', { waitedMs: waited })
        return
      }
      if (waited >= 30_000) {
        if (toolPoll) clearInterval(toolPoll)
        toolPoll = undefined
        probe.tools = 'no-tools（等了 30 秒）'
        deps.log('没拿到 tools 服务，识图工具没注册（识图路由与界面不受影响）')
      }
    }, 500)
    toolPoll.unref?.()
  }

  // ── 提示段：只在启动时已开启才注入（关着就别往上下文里塞东西）──
  try {
    const systemPrompt = ctx.get?.('systemPrompt', true) as
      | { section?: (definition: { name: string; order: number; text: string }) => unknown }
      | undefined
    if (!service.enabled()) {
      probe.section = 'disabled'
    } else if (systemPrompt && typeof systemPrompt.section === 'function') {
      systemPrompt.section({ name: 'dafeiyu:vision', order: 10100, text: GUIDANCE })
      probe.section = 'registered'
    } else {
      probe.section = 'no-systemPrompt'
    }
  } catch (error) {
    probe.section = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }

  // ── 路由（三条识图 + 两条网页版）──
  const tryStart = (): void => {
    if (started || stopped || !web) return
    started = true
    try {
      unregister = registerVisionRoutes(web, { service, log: deps.log })
      probe.routes = 'registered'
    } catch (error) {
      probe.routes = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      started = false
      deps.log('识图路由注册失败（远控/人设不受影响）', { message: String((error as Error)?.message ?? error).slice(0, 200) })
      return
    }
    deps.log('识图路由已挂上')
  }

  const acceptWeb = (value: unknown, via: string): boolean => {
    if (!value || typeof value !== 'object') return false
    if (typeof (value as Registerable).register !== 'function') {
      probe.webServer = 'object without register()'
      return false
    }
    web = value as Registerable
    probe.webServer = via
    tryStart()
    return true
  }

  const pickFrom = (source: unknown): unknown => {
    if (!source || typeof source !== 'object') return undefined
    const asContext = source as { get?: (n: string, optional: true) => unknown }
    if (typeof asContext.get === 'function') {
      try {
        const got = asContext.get('webServer', true)
        if (got) return got
      } catch {
        /* 这个候选没有该服务 */
      }
    }
    try {
      return (source as Record<string, unknown>)['webServer']
    } catch {
      return undefined
    }
  }

  try {
    const found = ctx.get?.('webServer', true)
    if (found) acceptWeb(found, 'via get')
    else probe.webServer = 'none'
  } catch (error) {
    probe.webServer = `get threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }
  try {
    ctx.inject?.(['webServer'], ((...args: unknown[]) => {
      try {
        for (const candidate of [args[0], ...args, ctx]) {
          if (acceptWeb(pickFrom(candidate), 'via inject')) return
        }
        probe.webServer = `${probe.webServer ?? 'none'} (inject fired, empty)`
      } catch (error) {
        probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
      }
    }) as never)
  } catch (error) {
    probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
  }

  // provide：工具/别的插件能软探测到识图服务。
  try {
    ctx.provide?.(VISION_SERVICE_NAME, {
      get enabled(): boolean {
        return service.enabled()
      },
      recognize: (image: { base64: string; mime: string; prompt?: string }) => service.recognize(image),
      describe: () => service.describe(),
    })
    probe.provide = 'ok'
  } catch (error) {
    probe.provide = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    if (toolPoll) {
      clearInterval(toolPoll)
      toolPoll = undefined
    }
    const off = unregister
    unregister = undefined
    try {
      off?.()
    } catch {
      /* 宿主可能已经先一步把 webServer 拆了 */
    }
    if (started) deps.log('识图路由已停')
    // 网页版浏览器是子进程，卸载时必须一起收掉，否则会留孤儿窗口/端口
    void service.dispose().catch(() => undefined)
  }

  return {
    stop,
    probe,
    service,
    __attachTools: attachTools,
    get available() {
      return !stopped && started && probe.routes === 'registered'
    },
  }
}
