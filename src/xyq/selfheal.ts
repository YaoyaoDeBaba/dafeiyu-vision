/**
 * xyq/intercept —— 通道的「调用前自愈」：CLI 没装就装、没登录就发起授权、缺 key 就说清填哪儿。
 *
 * 三条纪律（用户 2026-11-25 定的）：
 *   1. **只在被调用时触发**：插件启动 / probe 一律不装不登（探针只回答「现在有没有」）；
 *   2. **每一件自动动作留一行中文日志**（装了没装、登了没登），事后能复盘；
 *   3. **能关掉**：工具参数 autoInstall / autoLogin 传 false 时只报告、不动手——保守用法留口子。
 *
 * 防重复的三层（同一台机器上第二次调用不会重复下载）：
 *   a. 每次先 `locate()`：装过就命中，压根不会再走安装；
 *   b. 同进程内**单飞**（in-flight promise 复用）：并发的两次调用只下载一次；
 *   c. 失败**退避**（默认 10 分钟）：失败后短时间内不再重试，直接把上次的失败原因 + 手工命令回给用户。
 * 再加官方安装器自身的去重：画布 install.ps1 认已有 exe 就复用并挪位，短剧安装器把 release 落成
 * `jimeng-novel-<版本>-<平台>-<哈希>` 目录，同版本重复跑不会另起一份。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliRunner } from './cli.js'
import { locateJimengCli, type JimengCliPaths, type LocateDeps } from './jimeng/cli.js'
import { locateXyqCli, type LocateXyqOptions } from './cli.js'

export const CANVAS_INSTALL_URL = 'https://jimeng.jianying.com/canvas-cli/install.ps1'
export const NOVEL_CLI_URL = 'https://jimeng.jianying.com/novel-cli'

/** 装不上时给用户照着做的事（原文要能直接复制）。 */
export const MANUAL_INSTALL_CANVAS = '在 PowerShell 里跑：irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex'
export const MANUAL_INSTALL_NOVEL =
  '短剧 CLI（Windows / PowerShell，把下面整段粘进 PowerShell 跑）：' +
  '$s=(irm \'https://jimeng.jianying.com/novel-cli\'); $b=[regex]::Match($s,"DEFAULT_WINDOWS_INSTALLER_BASE64=\'([^\']+)\'").Groups[1].Value; $p=Join-Path $env:TEMP \'jimeng-novel-install.ps1\'; [IO.File]::WriteAllText($p,[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))); & $p'

export interface SelfHealDeps {
  run: CliRunner
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 定位函数（默认 locateJimengCli；测试注入假实现）。 */
  locate?: () => JimengCliPaths
  locateDeps?: LocateDeps
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  /** PowerShell 可执行文件（默认 powershell.exe）。 */
  powershell?: string
  /** 下载文本（默认全局 fetch；测试注入）。 */
  fetchText?: (url: string) => Promise<string>
  /** 写临时脚本（默认落 os.tmpdir 并自动清理；测试注入）。 */
  writeTempScript?: (name: string, content: string) => { file: string; cleanup: () => void }
  installTimeoutMs?: number
  statusTimeoutMs?: number
  loginTimeoutMs?: number
  now?: () => number
  installBackoffMs?: number
  loginBackoffMs?: number
}

export interface EnsureResult {
  ok: boolean
  message?: string
  cliPath?: string
}

function truncate(text: string, limit = 400): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

function defaultWriteTempScript(name: string, content: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jimeng-install-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, content, 'utf8')
  return {
    file,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不许影响结果 */
      }
    },
  }
}

/** 从 novel-cli 的 sh 脚本里抠出内嵌的 Windows PowerShell 安装器（base64）。 */
export function extractWindowsInstaller(script: string): string | undefined {
  const match = script.match(/DEFAULT_WINDOWS_INSTALLER_BASE64='([A-Za-z0-9+/=]+)'/)
  if (!match || match[1] === undefined) return undefined
  try {
    return Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export function createJimengSelfHealer(deps: SelfHealDeps) {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const installTimeout = deps.installTimeoutMs ?? 120_000
  const statusTimeout = deps.statusTimeoutMs ?? 20_000
  const loginTimeout = deps.loginTimeoutMs ?? 60_000
  const installBackoff = deps.installBackoffMs ?? 10 * 60_000
  const loginBackoff = deps.loginBackoffMs ?? 5 * 60_000
  const powershell = deps.powershell ?? deps.env?.JIMENG_POWERSHELL ?? (platform === 'win32' ? 'powershell.exe' : 'powershell')
  const fetchText =
    deps.fetchText ??
    (async (url: string): Promise<string> => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
      return await response.text()
    })
  const writeTemp = deps.writeTempScript ?? defaultWriteTempScript
  const locate = (): JimengCliPaths => (deps.locate ?? (() => locateJimengCli(deps.locateDeps)))()

  let installInFlight: Promise<EnsureResult> | undefined
  let lastInstall: { at: number; ok: boolean; message: string } | undefined
  let loginInFlight: Promise<EnsureResult> | undefined
  let lastLogin: { at: number; message: string; deviceCode?: string } | undefined

  /** 跑一条命令并把输出截断（下载/安装的日志可能很长）。 */
  async function runQuiet(args: string[], timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
    const result = await deps.run(args, { env: {}, timeoutMs })
    const detail = truncate(`${result.stdout}\n${result.stderr}`)
    if (result.timedOut) return { ok: false, detail: `超时（${Math.round(timeoutMs / 1000)} 秒）${detail === '' ? '' : `：${detail}`}` }
    if (result.code !== 0) return { ok: false, detail: detail === '' ? `退出码 ${result.code}` : detail }
    return { ok: true, detail }
  }

  /** 装画布 CLI：官方 PowerShell 安装脚本（下载与落盘都在脚本里，路径 <home>/bin）。 */
  async function installCanvas(): Promise<{ ok: boolean; detail: string }> {
    const command = `irm '${CANVAS_INSTALL_URL}' | iex`
    return runQuiet([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-Command', command], installTimeout)
  }

  /** 装短剧 CLI：下载 sh，抠出内嵌的 PowerShell 安装器，落临时文件后执行，跑完删掉。 */
  async function installNovel(): Promise<{ ok: boolean; detail: string }> {
    let script: string
    try {
      script = await fetchText(NOVEL_CLI_URL)
    } catch (error) {
      return { ok: false, detail: `下载 ${NOVEL_CLI_URL} 失败：${String((error as Error)?.message ?? error)}` }
    }
    const installer = extractWindowsInstaller(script)
    if (installer === undefined) return { ok: false, detail: 'novel-cli 脚本里没找到内嵌的 Windows 安装器' }
    const temp = writeTemp('jimeng-novel-install.ps1', installer)
    try {
      return await runQuiet([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', temp.file], installTimeout)
    } finally {
      temp.cleanup()
    }
  }

  async function doInstall(): Promise<EnsureResult> {
    const current = locate()
    if (current.novel !== undefined) return { ok: true, cliPath: current.novel }
    if (platform !== 'win32') {
      const message = `这台机器不是 Windows，插件不自动跑安装脚本。请手工安装即梦 CLI 后重试。${MANUAL_INSTALL_NOVEL}`
      lastInstall = { at: now(), ok: false, message }
      return { ok: false, message }
    }
    deps.log('即梦 CLI 没装，开始自动安装（画布 + 短剧）', { platform })
    const canvas = await installCanvas()
    const novel = await installNovel()
    const after = locate()
    if (after.novel !== undefined) {
      deps.log('即梦 CLI 自动安装完成', { path: path.basename(after.novel) })
      lastInstall = { at: now(), ok: true, message: '' }
      return { ok: true, cliPath: after.novel }
    }
    const reasons: string[] = []
    if (!canvas.ok) reasons.push(`画布：${canvas.detail}`)
    if (!novel.ok) reasons.push(`短剧：${novel.detail}`)
    if (reasons.length === 0) {
      reasons.push('安装脚本跑完了，但没在 ~/.local/share/jimeng-novel/releases 下找到 jimeng-novel.exe')
      reasons.push('若提示文件被占用，把 %USERPROFILE%\\bin\\.dreamina-canvas.install.* 里的 dreamina-canvas_windows_amd64.exe 手动改名为 dreamina-canvas.exe')
    }
    const message = `即梦 CLI 自动安装失败：${reasons.join('；')}。${MANUAL_INSTALL_CANVAS}`
    deps.log('即梦 CLI 自动安装失败（云雀/其它功能不受影响）', { reason: truncate(reasons.join('；'), 200) })
    lastInstall = { at: now(), ok: false, message }
    return { ok: false, message }
  }

  /** 第一步：CLI 在不在；缺了并且允许，就装一次。 */
  async function ensureCli(autoInstall: boolean): Promise<EnsureResult> {
    const current = locate()
    if (current.novel !== undefined) return { ok: true, cliPath: current.novel }
    if (!autoInstall) {
      return {
        ok: false,
        message:
          '没找到即梦 CLI（jimeng-novel）。本次调用没开自动安装（autoInstall:false）：' +
          `需要自动装就再调一次并传 autoInstall:true；手工安装：${MANUAL_INSTALL_CANVAS}；${MANUAL_INSTALL_NOVEL}`,
      }
    }
    if (lastInstall !== undefined && !lastInstall.ok && now() - lastInstall.at < installBackoff) {
      return { ok: false, message: `${lastInstall.message}（${Math.ceil((installBackoff - (now() - lastInstall.at)) / 60_000)} 分钟内不再重试，避免反复下载）` }
    }
    if (installInFlight !== undefined) return installInFlight
    installInFlight = doInstall().finally(() => {
      installInFlight = undefined
    })
    return installInFlight
  }

  /**
   * 读一次登录态：true 已登录 / false 明确未登录 / undefined 读不出来（放行，不因读不出就拦人）。
   *
   * 判据用**现成的信封**，不另找探测命令（vision 部门 2026-11-25 实测）：
   *   `jimeng-novel credit get -j` 未登录时返回
   *   `{"status":"error","error":{"code":"AUTH_FAILED","details":{"auth":{"nextAction":"login"}}}}`，
   *   所以只认 `error.code === 'AUTH_FAILED'` 与 `details.auth.nextAction === 'login'`——
   *   顺手把余额那一趟也做完了，不多跑一条命令。
   */
  async function readLogin(cliPath: string): Promise<boolean | undefined> {
    const result = await deps.run([cliPath, 'credit', 'get', '-j'], { env: {}, timeoutMs: statusTimeout })
    const raw = result.stdout.trim()
    if (raw === '') return undefined
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const error = parsed.error !== null && typeof parsed.error === 'object' ? (parsed.error as Record<string, unknown>) : undefined
      const details = error?.details !== null && typeof error?.details === 'object' ? (error.details as Record<string, unknown>) : undefined
      const auth = details?.auth !== null && typeof details?.auth === 'object' ? (details.auth as Record<string, unknown>) : undefined
      if (error?.code === 'AUTH_FAILED' || auth?.nextAction === 'login') return false
      if (parsed.status === 'ok' || parsed.status === 'success') return true
      if (error === undefined && parsed.data !== undefined && parsed.data !== null) return true
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * 读「这次授权已经被服务端判过期」的信号。
   * 真机证据（2026-11-25）：`login --wait --device-code <旧码>` 返回
   * `{"error":{"code":"AUTH_FAILED","details":{"auth":{"code":40014,"reason":"authorization_expired","nextAction":"restart"}}}}`。
   * 只要看到 nextAction=restart / reason=authorization_expired / 40014，就必须**丢掉旧码重新发起**，
   * 否则会一直把死链接复述给用户（真 bug）。
   */
  function isExpiredAuth(text: string): boolean {
    const raw = text.trim()
    if (raw === '') return false
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const error = parsed.error !== null && typeof parsed.error === 'object' ? (parsed.error as Record<string, unknown>) : undefined
      const details = error?.details !== null && typeof error?.details === 'object' ? (error.details as Record<string, unknown>) : undefined
      const auth = details?.auth !== null && typeof details?.auth === 'object' ? (details.auth as Record<string, unknown>) : undefined
      if (auth?.nextAction === 'restart') return true
      if (auth?.reason === 'authorization_expired') return true
      if (auth?.code === 40014 || auth?.code === '40014') return true
      if (error?.code === 'AUTH_FAILED' && /过期|expired/i.test(String(error.message ?? ''))) return true
      return false
    } catch {
      return /authorization_expired|40014|nextAction\\?":\\?"restart/.test(raw)
    }
  }

  /**
   * 续等一次（CLI 侧只等 1 秒）：用来在「复用上次链接」之前确认那条待授权还活着。
   * 返回 expired / logged_in / pending / unknown——只有 expired 才需要重开。
   */
  async function probePending(cliPath: string, deviceCode: string): Promise<'expired' | 'logged_in' | 'pending' | 'unknown'> {
    const result = await deps.run(
      [cliPath, 'login', '--wait', '--device-code', deviceCode, '--timeout', '1s', '-j'],
      { env: {}, timeoutMs: 20_000 },
    )
    const raw = result.stdout.trim()
    if (raw === '') return 'unknown'
    if (isExpiredAuth(raw)) return 'expired'
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const data = parsed.data !== null && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>) : undefined
      if (data?.status === 'logged_in' || parsed.status === 'logged_in' || data?.loggedIn === true) return 'logged_in'
      return 'pending'
    } catch {
      return 'unknown'
    }
  }

  /** 发起浏览器授权：拿到链接与 nextCommand，**同会话内只发起一次**（失败退避 + 过期即重开）。 */
  async function startLogin(cliPath: string): Promise<EnsureResult> {
    if (loginInFlight !== undefined) return loginInFlight
    loginInFlight = runLogin(cliPath).finally(() => {
      loginInFlight = undefined
    })
    return loginInFlight
  }

  async function runLogin(cliPath: string): Promise<EnsureResult> {
    if (lastLogin !== undefined && now() - lastLogin.at < loginBackoff) {
      // 复用前先验一次：链接可能已经被服务端判过期（40014），那就不能再复述
      if (lastLogin.deviceCode !== undefined) {
        const state = await probePending(cliPath, lastLogin.deviceCode)
        if (state === 'logged_in') return { ok: true }
        if (state === 'expired') {
          deps.log('即梦授权已过期，改用 --restart 重新发起（不复用死链接）', { reason: 'authorization_expired' })
          lastLogin = undefined
          return doLogin(cliPath, true)
        }
      }
      return { ok: false, message: lastLogin.message }
    }
    return doLogin(cliPath, false)
  }

  async function doLogin(cliPath: string, restart: boolean): Promise<EnsureResult> {
    deps.log(
      restart ? '即梦授权过期，重新发起浏览器授权（--restart）' : '即梦没登录，自动发起浏览器授权（需要用户点链接）',
      { path: path.basename(cliPath) },
    )
    const args = [cliPath, 'login', '--non-interactive', ...(restart ? ['--restart'] : []), '-j']
    const result = await deps.run(args, { env: {}, timeoutMs: loginTimeout })
    // 服务端说这条待授权已经过期、且这次还没带 --restart：立刻重开一次（只重开一次，不递归）
    if (!restart && isExpiredAuth(result.stdout)) {
      deps.log('即梦授权被判过期，自动改用 --restart 重新发起', { reason: 'authorization_expired' })
      return doLogin(cliPath, true)
    }
    if (result.timedOut) {
      const message = `即梦授权发起超时（${Math.round(loginTimeout / 1000)} 秒）。手工：在终端跑「"${cliPath}" login --non-interactive」`
      lastLogin = { at: now(), message }
      return { ok: false, message }
    }
    let link = ''
    let nextCommand = ''
    let deviceCode = ''
    try {
      const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>
      const data = parsed.data !== null && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>) : undefined
      const challenge = data?.challenge !== null && typeof data?.challenge === 'object' ? (data.challenge as Record<string, unknown>) : undefined
      if (typeof challenge?.verificationUriComplete === 'string' && challenge.verificationUriComplete !== '') link = challenge.verificationUriComplete
      else if (typeof challenge?.verificationUri === 'string' && challenge.verificationUri !== '') link = challenge.verificationUri
      if (typeof data?.nextCommand === 'string' && data.nextCommand !== '') nextCommand = data.nextCommand
      if (typeof challenge?.deviceCode === 'string' && challenge.deviceCode !== '') deviceCode = challenge.deviceCode
      if (link === '' && data?.status === 'logged_in') return { ok: true }
    } catch {
      /* 解析不出来就走下面的手工路径 */
    }
    if (link === '') {
      const detail = truncate(`${result.stdout}\n${result.stderr}`)
      const message = `即梦授权没拿到链接（${detail === '' ? 'CLI 没有输出' : detail}）。手工：在终端跑「"${cliPath}" login --non-interactive」`
      lastLogin = { at: now(), message }
      return { ok: false, message }
    }
    const lines = [`即梦还没登录。**点这个链接授权**：${link}`, '授权完告诉我，我接着往下走（不用再问我别的）。']
    if (nextCommand !== '') lines.push(`授权后需要续等的命令：${nextCommand}`)
    const message = lines.join('\n')
    lastLogin = { at: now(), message, ...(deviceCode === '' ? {} : { deviceCode }) }
    return { ok: false, message }
  }

  return {
    ensureCli,
    readLogin,
    /** 第二步：授权在不在（只在确认「未登录」时发一次授权）。 */
    async ensureLogin(cliPath: string, autoLogin: boolean): Promise<EnsureResult> {
      const loggedIn = await readLogin(cliPath)
      if (loggedIn === true) return { ok: true }
      if (loggedIn === undefined) return { ok: true }
      if (!autoLogin) {
        return {
          ok: false,
          message: `即梦还没登录，本次调用关掉了自动授权（autoLogin:false）。手工：在终端跑「"${cliPath}" login --non-interactive」，再把返回的链接给用户点。`,
        }
      }
      return startLogin(cliPath)
    },
    /** 测试/排障用：清掉进程内的退避与单飞状态。 */
    reset(): void {
      installInFlight = undefined
      lastInstall = undefined
      loginInFlight = undefined
      lastLogin = undefined
    },
  }
}

export type JimengSelfHealer = ReturnType<typeof createJimengSelfHealer>
/**
 * 云雀（pippit-tool-cli）侧的安装口令。**默认不自动跑**——用户 2026-11-25 的规矩：
 * 云雀这条默认只报错，`autoInstall:true` 才真的去装；即梦那条才是默认装的。
 */
export const XYQ_MANUAL_INSTALL = '在终端跑：npx @pippit-dev/cli@latest install'
export const XYQ_INSTALL_PACKAGE = '@pippit-dev/cli@latest'
export const XYQ_INSTALL_SUBCOMMAND = 'install'

export interface XyqSelfHealDeps {
  run: CliRunner
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 纯定位（默认 locateXyqCli；测试注入）。 */
  locate?: () => string | undefined
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  installTimeoutMs?: number
  now?: () => number
  installBackoffMs?: number
}

export function createXyqSelfHealer(deps: XyqSelfHealDeps) {
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const installTimeout = deps.installTimeoutMs ?? 180_000
  const installBackoff = deps.installBackoffMs ?? 10 * 60_000
  const locate = deps.locate ?? (() => locateXyqCli({ env: deps.env, platform } satisfies LocateXyqOptions))
  // Windows 上 npx 是 npx.cmd：spawn 不经过 shell，直接用 'npx' 会 ENOENT。
  const npxCommand = deps.env?.XYQ_NPX ?? (platform === 'win32' ? 'npx.cmd' : 'npx')

  let inFlight: Promise<EnsureResult> | undefined
  let lastInstall: { at: number; ok: boolean; message: string } | undefined

  async function doInstall(): Promise<EnsureResult> {
    const found = locate()
    if (found !== undefined) return { ok: true, cliPath: found }
    deps.log('小云雀 CLI 没装，开始自动安装（npx @pippit-dev/cli@latest install）', { platform })
    const result = await deps.run([npxCommand, XYQ_INSTALL_PACKAGE, XYQ_INSTALL_SUBCOMMAND], {
      env: {},
      timeoutMs: installTimeout,
    })
    const detail = truncate(`${result.stdout}\n${result.stderr}`)
    if (result.timedOut) {
      const message = `小云雀 CLI 自动安装超时（${Math.round(installTimeout / 1000)} 秒）。手工安装：${XYQ_MANUAL_INSTALL}`
      deps.log('小云雀 CLI 自动安装失败：超时', { reason: 'timeout' })
      lastInstall = { at: now(), ok: false, message }
      return { ok: false, message }
    }
    const after = locate()
    if (after !== undefined) {
      deps.log('小云雀 CLI 自动安装完成', { path: path.basename(after) })
      lastInstall = { at: now(), ok: true, message: '' }
      return { ok: true, cliPath: after }
    }
    const reason = result.code === 0 ? '安装命令跑完了，但没找到 pippit-tool-cli（可能在别的目录）' : detail === '' ? `退出码 ${result.code}` : detail
    const message = `小云雀 CLI 自动安装失败：${reason}。手工安装：${XYQ_MANUAL_INSTALL}`
    deps.log('小云雀 CLI 自动安装失败（云雀工具仍可用但会报错）', { reason: truncate(reason, 200) })
    lastInstall = { at: now(), ok: false, message }
    return { ok: false, message }
  }

  return {
    /**
     * 第一步：CLI 在不在。**默认（autoInstall 不为 true）只报错**，不动手。
     * 失败退避 10 分钟，避免一次会话里反复跑 npx。
     */
    async ensureCli(autoInstall: boolean): Promise<EnsureResult> {
      const found = locate()
      if (found !== undefined) return { ok: true, cliPath: found }
      if (autoInstall !== true) {
        return {
          ok: false,
          message: `没找到 pippit-tool-cli（小云雀 CLI）。默认不会自动安装：本次调用没有传 autoInstall:true。手工安装：${XYQ_MANUAL_INSTALL}`,
        }
      }
      if (lastInstall !== undefined && !lastInstall.ok && now() - lastInstall.at < installBackoff) {
        return {
          ok: false,
          message: `${lastInstall.message}（${Math.ceil((installBackoff - (now() - lastInstall.at)) / 60_000)} 分钟内不再重试，避免反复下载）`,
        }
      }
      if (inFlight !== undefined) return inFlight
      inFlight = doInstall().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    reset(): void {
      inFlight = undefined
      lastInstall = undefined
    },
  }
}

export type XyqSelfHealer = ReturnType<typeof createXyqSelfHealer>
