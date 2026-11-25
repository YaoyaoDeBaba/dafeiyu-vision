/**
 * xyq/start — 宿主接线：挂四条设置页路由、注册四个工具、注入使用提示。
 *
 * 与识图/记忆同一条纪律：软探测 `webServer` / `tools` / `systemPrompt`，
 * 任何一块挂不上都只少那一块，远控主链路不受影响；`stop()` 幂等。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { createXyqService, type XyqService } from './service.js'
import { resolveXyqConfigFile, readXyqConfig } from './config.js'
import {
  XYQ_BALANCE_ROUTE,
  XYQ_CONFIG_ROUTE,
  XYQ_DESCRIBE_ROUTE,
  XYQ_FILE_ROUTE,
  XYQ_GENERATE_ROUTE,
  XYQ_MODELS_ROUTE,
  XYQ_RESULT_ROUTE,
  XYQ_STATUS_ROUTE,
  xyqConfigHandler,
  xyqDescribeHandler,
  xyqFileHandler,
  xyqGenerateHandler,
  xyqQueryHandler,
  xyqResultHandler,
  type XyqRouteDeps,
} from './routes.js'
import { xyqTools } from './tools.js'
import { defaultCliRunner, locateXyqCli, resolveCliPath, type CliRunner } from './cli.js'
import { createJimengService } from './jimeng/service.js'
import type { LocateDeps } from './jimeng/cli.js'
import type { GenerationChannel } from './channel.js'
import { readXyqSkillBody, XYQ_SKILL_NAME } from './skill.js'
import { createCanvasCli } from './canvas/cli.js'
import { createCanvasService } from './canvas/service.js'
import { canvasTools } from './canvas/tools.js'
import { fileURLToPath } from 'node:url'

interface LooseContext {
  get?<T>(name: string, optional: true): T | undefined
  inject?(names: string[], callback: (scoped: unknown) => void): unknown
  effect?(execute: () => (() => unknown) | void): unknown
}

interface Registerable {
  register(route: {
    kind: 'exact'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => unknown
  }): () => void
}

export interface XyqHandle {
  stop(): void
  readonly probe: Record<string, string>
  readonly service: XyqService
}

// 提示文本的唯一一份（推送按钮也复用）。
import { xyqGuidance as guidanceText } from './guidance.js'

export function startXyq(
  ctx: LooseContext,
  deps: {
    dshHome: string
    log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
    run?: CliRunner
    resolveCli?: () => Promise<string | undefined>
    /** 测试注入：换掉即梦通道实现（不传就按本机现状探测）。 */
    jimengChannel?: GenerationChannel
    /** 测试注入：即梦 CLI 的定位依赖（假 exists/listDir 等）。 */
    jimengLocateDeps?: LocateDeps
    /** 即梦产物落盘目录；默认 <dshHome>/storages/dsh-remote-dafeiyu/jimeng-output。 */
    jimengOutDir?: string
  },
): XyqHandle {
  const probe: Record<string, string> = {}
  // 插件包根目录（dist/bundle/index.js → 上两级），用来找 assets/skills/<skill>/SKILL.md
  const packageRoot = ((): string => {
    try {
      return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    } catch {
      return process.cwd()
    }
  })()
  const skillAssetsRoot = path.join(packageRoot, 'assets', 'skills', XYQ_SKILL_NAME)
  const run = deps.run ?? defaultCliRunner
  const resolveCli =
    deps.resolveCli ??
    (() => resolveCliPath(run, { log: (message, fields) => deps.log(message, fields) }))
  const configFile = resolveXyqConfigFile(deps.dshHome)
  // 即梦通道：二进制按绝对路径 spawn（安装器不进 PATH），产物落 storages 里与云雀同层。
  const jimengChannel =
    deps.jimengChannel ??
    createJimengService({
      run,
      log: deps.log,
      outDir: deps.jimengOutDir ?? path.join(deps.dshHome, 'storages', 'dsh-remote-dafeiyu', 'jimeng-output'),
      ...(deps.jimengLocateDeps === undefined ? {} : { locateDeps: deps.jimengLocateDeps }),
    })
  // 即梦画布（只读起步）：**独立的 flag（--format json）与信封（{ok,data,error}）**，见 canvas/cli.ts
  const canvasCli = createCanvasCli({ run })
  const canvasService = createCanvasService({ cli: canvasCli, log: deps.log })
  // `locateCli` 是**纯定位**（不装）：云雀自愈默认只报错，装不装由调用方的 autoInstall 决定；
  // `resolveCli` 仍留在 call() 里（真正跑命令时的兜底）。
  const service = createXyqService({
    configFile,
    run,
    resolveCli,
    locateCli: () => locateXyqCli(),
    log: deps.log,
    channels: { jimeng: jimengChannel },
  })

  const disposers: Array<() => void> = []
  let unregister: (() => void) | undefined
  let started = false
  let stopped = false

  const outDir = path.join(deps.dshHome, 'storages', 'dsh-remote-dafeiyu', 'xyq-output')
  const routeDeps: XyqRouteDeps = { service, outDir, log: deps.log }
  const tryStart = (): void => {
    if (started || stopped) return
    started = true
    try {
      const registers: Array<[string, (request: IncomingMessage, response: ServerResponse) => unknown]> = [
        [XYQ_CONFIG_ROUTE, xyqConfigHandler(routeDeps)],
        [XYQ_STATUS_ROUTE, xyqQueryHandler('status', routeDeps)],
        [XYQ_BALANCE_ROUTE, xyqQueryHandler('balance', routeDeps)],
        [XYQ_MODELS_ROUTE, xyqQueryHandler('models', routeDeps)],
        [XYQ_DESCRIBE_ROUTE, xyqDescribeHandler(routeDeps)],
        [XYQ_GENERATE_ROUTE, xyqGenerateHandler(routeDeps)],
        [XYQ_RESULT_ROUTE, xyqResultHandler(routeDeps)],
        [XYQ_FILE_ROUTE, xyqFileHandler(routeDeps)],
      ]
      for (const [path, handler] of registers) disposers.push(web!.register({ kind: 'exact', path, handler }))
      unregister = () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
      probe.routes = 'registered'
    } catch (error) {
      probe.routes = `register threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
      started = false
      if (disposers.length > 0) {
        const registered = disposers.splice(0)
        unregister = () => {
          for (const dispose of registered) dispose()
        }
      }
    }
  }

  let web: Registerable | undefined
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
        for (const candidate of [args[0], ...args, ctx]) if (acceptWeb(pickFrom(candidate), 'via inject')) return
        probe.webServer = `${probe.webServer ?? 'none'} (inject fired, empty)`
      } catch (error) {
        probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
      }
    }) as never)
  } catch (error) {
    probe['injectThrew:webServer'] = String((error as Error)?.message ?? error).slice(0, 160)
  }

  // 工具：配置里关掉就不注册（改开关要重启，与识图同一条）
  const config = readXyqConfig(configFile)
  if (!config.enabled) {
    probe.tools = 'disabled-by-config'
  } else {
    try {
      const tools = ctx.get?.('tools', true) as { register?: (definition: Record<string, unknown>) => unknown } | undefined
      if (tools && typeof tools.register === 'function') {
        // `xyq_guide` 读的就是 skill 那份 SKILL.md —— 单一真源（同识图的做法）。
        for (const tool of [...xyqTools(service, { guideBody: () => readXyqSkillBody(skillAssetsRoot) }), ...canvasTools(canvasService, { maxCredits: config.canvasMaxCredits })]) tools.register(tool)
        probe.tools = 'registered'
      } else {
        probe.tools = 'no-tools'
      }
    } catch (error) {
      probe.tools = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
    try {
      const systemPrompt = ctx.get?.('systemPrompt', true) as
        | { section?: (definition: { name: string; order: number; text: string }) => unknown }
        | undefined
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        systemPrompt.section({ name: 'dafeiyu:xyq', order: 10095, text: guidanceText(config.freedom) })
        probe.section = 'registered'
      } else {
        probe.section = 'no-systemPrompt'
      }
    } catch (error) {
      probe.section = `threw: ${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
  }

  // 即梦通道：只探一次（只看装没装）；不可用只标这一条通道 + 一行日志，云雀完全不受影响。
  void (async () => {
    try {
      const status = await jimengChannel.probe()
      if (status.available) {
        probe.jimeng = `available:${status.cliPath}`
      } else {
        probe.jimeng = `unavailable:${status.reason}`
        deps.log('即梦通道不可用（小云雀不受影响）', { reason: status.reason })
      }
    } catch (error) {
      probe.jimeng = `probe threw:${String((error as Error)?.message ?? error).slice(0, 80)}`
      deps.log('即梦通道探测抛错（小云雀不受影响）', {
        message: String((error as Error)?.message ?? error).slice(0, 200),
      })
    }
    // 画布是**另一条 CLI**（dreamina-canvas）：各探各的，缺一个不影响另一个。
    // 放在即梦之后：它要多跑一次 `auth status`（子进程），别把 probe.jimeng 拖晚。
    try {
      const canvasPath = canvasCli.path()
      probe.canvas = canvasPath === undefined ? 'unavailable:没找到 dreamina-canvas' : `available:${canvasPath}`
      if (canvasPath === undefined) {
        deps.log('即梦画布不可用（短剧/云雀不受影响）', { hint: 'irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex' })
      } else {
        const canvasStatus = await canvasService.status()
        probe['canvas.auth'] =
          canvasStatus.ok === true
            ? canvasStatus.data?.loggedIn === true
              ? 'logged-in'
              : 'not-logged-in'
            : `unknown:${String(canvasStatus.message ?? '').slice(0, 110)}`
      }
    } catch (error) {
      probe.canvas = `probe threw:${String((error as Error)?.message ?? error).slice(0, 80)}`
    }
  })()

  return {
    probe,
    service,
    stop(): void {
      if (stopped) return
      stopped = true
      try {
        unregister?.()
      } catch {
        /* 停机不许抛 */
      }
      unregister = undefined
    },
  }
}
