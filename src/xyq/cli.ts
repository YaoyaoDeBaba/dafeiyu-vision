/**
 * xyq/cli — 找官方 `pippit-tool-cli` 并执行它（唯一的外部依赖）。
 *
 * 为什么走 CLI 而不是自己实现 HTTP：小云雀的 API 文档把「文件上传 → 提交 → 轮询 → 下载」
 * 都封在 CLI 里，官方也明确建议 Agent 直接调 CLI（见 /cli 页面与 skills）。
 * 自己拼 HTTP 等于把鉴权、签名、字段映射再实现一遍，而且版本一变就坏。
 *
 * 定位顺序：
 *   1. `~/.cache/pippit-tool-cli/xyq-skill/<platform>/current/.../pippit-tool-cli[.exe]`
 *      （skill 的 ensure-cli 装的）
 *   2. 跑一次 `~/.agents/skills/xyq-skill/scripts/ensure-cli.js`，从它最后一行 JSON 里取 `cli_path`
 *   3. 都没有就返回 undefined，由调用方给出“请先安装”的明确错误
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CliRunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type CliRunner = (args: string[], options: { env: Record<string, string>; timeoutMs: number }) => Promise<CliRunResult>

function platformDir(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win32-${arch}`
  if (process.platform === 'darwin') return `darwin-${arch}`
  return `linux-${arch}`
}

function binaryNameFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'pippit-tool-cli.exe' : 'pippit-tool-cli'
}

function binaryName(): string {
  return binaryNameFor(process.platform)
}

export interface LocateXyqOptions {
  env?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
}

/**
 * **纯定位**：只回答「pippit-tool-cli 在哪」，装不装是别人的事（与 resolveCliPath 的区别就在这）。
 * 顺序：环境变量 XYQ_CLI_PATH → 官方 skill 缓存位置 → PATH。
 * 为什么要它：2026-11-25 起「自动安装」必须显式开关，默认只报错——
 * 所以自愈的第一步不能复用会顺手装一遍的 resolveCliPath。
 */
export function locateXyqCli(options: LocateXyqOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const platform = options.platform ?? process.platform
  const exists =
    options.exists ??
    ((file: string): boolean => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })
  const candidates: Array<string | undefined> = [env.XYQ_CLI_PATH, ...cachedCliCandidates(home)]
  const name = binaryNameFor(platform)
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim() === '') continue
    candidates.push(path.join(dir, name))
  }
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && exists(candidate)) return candidate
  }
  return undefined
}

/** 已知的 CLI 位置（不做存在性检查之外的任何事）。 */
export function cachedCliCandidates(home = os.homedir()): string[] {
  const base = path.join(home, '.cache', 'pippit-tool-cli', 'xyq-skill', platformDir(), 'current')
  return [
    path.join(base, 'node_modules', '@pippit-dev', 'cli', 'bin', binaryName()),
    path.join(base, 'node_modules', '.bin', binaryName()),
  ]
}

export function ensureCliScript(home = os.homedir()): string {
  return path.join(home, '.agents', 'skills', 'xyq-skill', 'scripts', 'ensure-cli.js')
}

export const defaultCliRunner: CliRunner = (args, options) =>
  new Promise<CliRunResult>((resolve) => {
    const child = spawn(cliPathForRun(args), args.slice(1), {
      env: { ...process.env, ...options.env },
      windowsHide: true,
      // 同 sprite/browser.ts 的理由：**别继承宿主的工作目录**。
      // 子进程以某个目录为 cwd 时，Windows 不允许把那个目录改名；DSH 自更新恰恰要把
      // `D:\FeiYu` 改成 `D:\FeiYu.old-*`，一个还活着的子进程就能让安装器连试 10 次
      // `error 32` 后放弃（2026-11-12 现场就是这样）。CLI 跑完就退，但别赌它来得及。
      cwd: os.tmpdir(),
    } as never)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}${String((error as Error)?.message ?? error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })

/**
 * runner 的 args[0] 是要执行的 CLI 路径（约定见 service 的调用）。
 * 这样测试可以塞一个假 runner，而生产 runner 只需要 spawn 那个路径。
 */
function cliPathForRun(args: string[]): string {
  return args[0] ?? ''
}

/**
 * 云雀 CLI 安装的默认超时：**180 秒**。
 * 比即梦那条（`selfheal.ts` 的 installTimeoutMs，默认 120 秒）更长，原因不同：
 *   - 云雀走 `npx @pippit-dev/cli@latest install`，首次要拉 npm 包 + 通用 Skill + 短剧 Skill，
 *     受 npm registry 网络波动影响，120 秒经常不够；
 *   - 即梦走官方 CDN 的 PowerShell 安装器（单个二进制 + skill 包），体积固定、120 秒够，
 *     超时给太长只会让用户多等。
 * 两处都是「超时就放弃 + 输出截断 + 失败给手工命令」，不许无限挂着。
 */
export const XYQ_INSTALL_TIMEOUT_MS = 180_000

/** stdout 可能很长（npm 安装日志）：只留尾部 64KB 再解析，避免把整个日志塞进内存/日志。 */
export function truncateTail(text: string, limit = 64 * 1024): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** 跑 ensure-cli，从最后一行 JSON 里取 cli_path。 */
export async function installCli(
  run: CliRunner,
  options: { home?: string; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const home = options.home ?? os.homedir()
  const script = ensureCliScript(home)
  if (!fs.existsSync(script)) return undefined
  const result = await run([process.execPath, script], { env: {}, timeoutMs: options.timeoutMs ?? XYQ_INSTALL_TIMEOUT_MS })
  if (result.timedOut) return undefined
  const lines = truncateTail(result.stdout).split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as { cli_path?: unknown }
      if (typeof parsed.cli_path === 'string' && parsed.cli_path !== '') return parsed.cli_path
    } catch {
      /* 不是 JSON 行，继续往上找 */
    }
  }
  return undefined
}

/** 返回可执行的 CLI 路径（先缓存命中，再尝试装一次）。 */
export async function resolveCliPath(
  run: CliRunner,
  options: { home?: string; log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void } = {},
): Promise<string | undefined> {
  const home = options.home ?? os.homedir()
  for (const candidate of cachedCliCandidates(home)) {
    if (fs.existsSync(candidate)) return candidate
  }
  const installed = await installCli(run, { home })
  if (installed !== undefined && fs.existsSync(installed)) {
    options.log?.('小云雀 CLI 已安装', { path: path.basename(installed) })
    return installed
  }
  return undefined
}
