/**
 * xyq/canvas/cli —— 即梦**画布** CLI（`dreamina-canvas`）的定位与信封解析。
 *
 * 和短剧 CLI（`jimeng-novel`）**不是同一套东西**，2026-11-25 真机实测的三条差异：
 *   1. flag：画布只认全局 `--format json`，**不认 `-j`**（给了会返回 code 2「unrecognized option」）；
 *   2. 信封：画布是 `{schemaVersion, ok, data, error:{code,message,diagnostics}}`，
 *      短剧是 `{status, data, error}`——所以 `jimeng/service.ts` 那份 `parseEnvelope` 不能复用；
 *   3. 命令名：节点列表是 **`node ls`**（不是 `node list`）。
 *
 * 本文件只做「找到它 + 跑一条 + 把信封解析成人话」，业务在 service.ts。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliRunner } from '../cli.js'
import { locateJimengCli, type LocateDeps } from '../jimeng/cli.js'

/** 画布信封（与短剧信封不同，别混）。 */
export interface CanvasEnvelope {
  schemaVersion?: string
  ok?: boolean
  data?: unknown
  error?: { code?: number | string; message?: string; diagnostics?: Array<{ detail?: string }> }
  /** 真机：
ode delete（不带 token）会在**顶层**回这份删除清单（不在 data 里）。 */
  deletionConfirmation?: unknown
}

export interface CanvasCliDeps {
  run: CliRunner
  /** 定位（默认复用即梦那套 locate：它会同时找 novel 与 canvas 两个二进制）。 */
  locate?: () => string | undefined
  locateDeps?: LocateDeps
  /** 可执行文件显式覆盖（排障口子）。 */
  executable?: string
  /** 判断文件是否存在（测试注入）。 */
  exists?: (file: string) => boolean
}

/** 找 `dreamina-canvas`：环境变量 → `<home>/bin` → `~/.local/bin` → PATH。 */
export function locateCanvasCli(deps: LocateDeps = {}): string | undefined {
  const env = deps.env ?? process.env
  const explicit = (env.DREAMINA_CANVAS_CLI ?? '').trim()
  if (explicit !== '' && (deps.exists ? deps.exists(explicit) : fs.existsSync(explicit))) return explicit
  return locateJimengCli(deps).canvas
}

function defaultExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 从 stdout 里取最后一个 JSON 信封（命令行可能夹着提示行）。 */
export function parseCanvasEnvelope(stdout: string): CanvasEnvelope | undefined {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === undefined) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const envelope: CanvasEnvelope = {}
      if (typeof parsed.schemaVersion === 'string') envelope.schemaVersion = parsed.schemaVersion
      if (typeof parsed.ok === 'boolean') envelope.ok = parsed.ok
      if ('data' in parsed) envelope.data = parsed.data
      if (parsed.error !== null && typeof parsed.error === 'object') envelope.error = parsed.error as CanvasEnvelope['error']
      if (parsed.deletionConfirmation !== undefined) envelope.deletionConfirmation = parsed.deletionConfirmation
      return envelope
    } catch {
      /* 继续往上找 */
    }
  }
  return undefined
}

/** 信封错误 → 一句中文（把 diagnostics 里那句也带上，那通常最具体）。 */
export function canvasErrorMessage(envelope: CanvasEnvelope, raw: string): string | undefined {
  if (envelope.ok !== false) return undefined
  const error = envelope.error
  const detail = (error?.diagnostics ?? [])
    .map((entry) => (typeof entry?.detail === 'string' ? entry.detail : ''))
    .filter((text) => text !== '')
    .join('；')
  const message = [error?.message, detail].filter((part) => typeof part === 'string' && part !== '').join('｜')
  // 「没选画布」是最常见的操作失误，翻成能照着做的一句话
  if (/no project id/i.test(`${message} ${raw}`)) {
    return '还没选中画布：先调 xyq_canvas({action:"canvases"}) 看列表，选一个把 projectId 作为 canvasId 传进来；或先在网页里选好当前画布。'
  }
  return message === '' ? `即梦画布命令失败（没有细节）：${String(raw).trim().slice(0, 200)}` : `即梦画布：${message.slice(0, 300)}`
}

/** 画布 CLI 的结果：要么信封，要么一句中文。 */
export interface CanvasCallResult {
  envelope?: CanvasEnvelope
  message?: string
}

export function createCanvasCli(deps: CanvasCliDeps) {
  const locate = (): string | undefined => {
    if (deps.executable !== undefined && deps.executable !== '') return deps.executable
    if (deps.locate !== undefined) return deps.locate()
    return locateCanvasCli(deps.locateDeps)
  }

  return {
    path(): string | undefined {
      return locate()
    },
    /**
     * 跑一条命令。**注意**：这里自动补 `--format json`（画布不认 `-j`），
     * 调用方只需要写子命令与参数。
     */
    async call(args: string[], timeoutMs = 60_000, options: { allowError?: boolean } = {}): Promise<CanvasCallResult> {
      const cli = locate()
      if (cli === undefined) {
        return {
          message:
            '没找到即梦画布 CLI（dreamina-canvas）。装它：在 PowerShell 里跑 `irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex`，装完再试。',
        }
      }
      const exists = deps.exists ?? defaultExists
      if (!exists(cli)) return { message: `即梦画布 CLI 路径不存在：${cli}` }
      const result = await deps.run([cli, ...args, '--format', 'json'], { env: {}, timeoutMs })
      const raw = `${result.stdout}\n${result.stderr}`
      if (result.timedOut) return { message: `即梦画布命令超时（${Math.round(timeoutMs / 1000)} 秒）` }
      // 真机：**错误信封会写到 stderr**（`No project ID was provided` 那条就是），所以两边都要看
      const envelope = parseCanvasEnvelope(result.stdout) ?? parseCanvasEnvelope(result.stderr)
      if (envelope === undefined) {
        return { message: `即梦画布没有返回可解析的 JSON：${raw.trim().slice(0, 240) || '（空输出）'}` }
      }
      const message = canvasErrorMessage(envelope, raw)
      if (message !== undefined && options.allowError !== true) return { message }
      return { envelope }
    },
  }
}

export type CanvasCli = ReturnType<typeof createCanvasCli>

/** 默认 home 别名，便于测试。 */
export const CANVAS_HOME = (): string => os.homedir()
export const canvasDefaultDir = (): string => path.join(os.homedir(), 'bin')
