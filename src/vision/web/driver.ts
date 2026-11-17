/**
 * web/driver —— 网页版视觉的 CDP 驱动。
 *
 * 与 dev-kit `sprite/browser.ts` 的关系：同一套「起浏览器 + 连 CDP + Runtime.evaluate」骨架，
 * 但这里有三处**本质不同**，不能照抄：
 *
 * 1. **profile 必须持久**：登录态是全部前提。sprite 用 `mkdtempSync` 每次一份新 profile，
 *    这里反过来——`<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/<site>`，
 *    登录一次长期复用。
 * 2. **必须支持有头**：首次登录要人点，无头窗口没法登。
 * 3. **要多几个手**：`DOM.setFileInputFiles`（塞图）、`Input.insertText` / `dispatchKeyEvent`
 *    （打字回车）、`Page.captureScreenshot`（出错时留证据）。
 *
 * 不引 `ws` 依赖：DSH 宿主的 Node 是 22+，全局 `WebSocket` 够用；拿不到就直接报清楚
 * （比装一个只在老 Node 上才有用的依赖划算）。
 *
 * 进程纪律（照 sprite 的老账）：
 * - 子进程 `stdio: ignore`、`cwd` 钉在 profile 目录（别站进安装路径，否则 DSH 自更新换不掉目录）；
 * - 关闭时**杀整棵树**，`child.kill()` 只杀 broker 会留一堆 renderer 占端口；
 * - 父进程消失 → 看门狗杀树（否则宿主崩了浏览器会一直挂着）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

export type WebLog = (message: string, fields?: Record<string, string | number | boolean | undefined>) => void

export interface CdpClient {
  readonly port: number
  /** 页面里求值（awaitPromise + returnByValue），异常抛错。 */
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>
  /** 裸 CDP 调用（DOM.* / Input.* / Page.*）。 */
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  /** 导航并等 `readyState === 'complete'`（等不到不抛，交给后续判据）。 */
  goto(url: string, timeoutMs?: number): Promise<void>
  /** 截图落盘（出错留证据用；写不进去不抛）。 */
  screenshot(file: string): Promise<void>
  close(): Promise<void>
}

export interface LaunchOptions {
  /** 浏览器 profile 目录（必须持久；不存在会被创建）。 */
  profileDir: string
  /** 默认无头；首次登录传 false。 */
  headless?: boolean
  /** 显式可执行文件；不给就按常见路径找。 */
  executable?: string
  /** 等 CDP 起来的上限。 */
  readyTimeoutMs?: number
  log?: WebLog
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 常见浏览器路径（Windows）。找不到就让调用方报清楚。 */
export function findBrowser(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const env = (process.env.DAFEIYU_WEBVISION_BROWSER ?? '').trim()
  if (env !== '') return existsSync(env) ? env : undefined
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

function getJson(url: string, timeoutMs = 2_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('CDP 探测超时')))
    request.on('error', reject)
  })
}

/** 整棵树 kill：Windows 上 `taskkill /T /F`，其它平台退化成 kill 进程组。 */
function killTree(pid: number, log: WebLog): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch (error) {
    log('杀浏览器进程树失败', { pid, reason: String((error as Error)?.message ?? error) })
  }
}

/** 父进程消失就杀浏览器（宿主崩溃后别留孤儿窗口/端口）。 */
function startParentWatchdog(browserPid: number, log: WebLog): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      process.kill(browserPid, 0)
    } catch {
      clearInterval(timer)
      return
    }
    if (process.ppid === 1) {
      // 宿主没了（被 reparent 到 init/launcher）
      clearInterval(timer)
      killTree(browserPid, log)
    }
  }, 5_000)
  timer.unref?.()
  return timer
}

interface PageTarget {
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

/**
 * 起浏览器 → 连第一个 page target → 返回可用的 CdpClient。
 *
 * 注意：**同一个 profile 不能同时开两份**（浏览器会复用已存在的实例，新进程直接退出），
 * 所以调用方（web/index.ts）必须保证一个站点同一时间只有一个驱动实例。
 */
export async function launchCdpBrowser(options: LaunchOptions): Promise<CdpClient> {
  const log = options.log ?? ((): void => undefined)
  const executable = findBrowser(options.executable)
  if (!executable) {
    throw new Error('找不到 Edge/Chrome：可以用环境变量 DAFEIYU_WEBVISION_BROWSER 指定可执行文件路径')
  }
  const headless = options.headless !== false
  mkdirSync(options.profileDir, { recursive: true })
  const port = await freePort()
  const args = [
    headless ? '--headless=new' : '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    // 关掉 Edge 的账号同步/首次弹窗：新 profile 首启动会弹 edge://sync-confirmation-dialog，
    // 那个内部页会抢走 page target（见下面 isHttpPage 的注释）。
    '--disable-sync',
    '--no-service-autorun',
    '--disable-features=Translate,OptimizationHints,msSyncConsent,SigninInterception',
    '--mute-audio',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.profileDir}`,
    '--lang=zh-CN',
    'about:blank',
  ]
  const child: ChildProcess = spawn(executable, args, {
    stdio: 'ignore',
    windowsHide: headless,
    cwd: options.profileDir,
  })
  if (typeof child.pid === 'number') startParentWatchdog(child.pid, log)

  let closed = false
  let watchdog: NodeJS.Timeout | undefined
  /**
   * 关浏览器。**必须优雅关**：登录态（cookie）要落盘才留得住。
   * 2026-11-17 实测教训：`taskkill /F` 关掉的窗口，下一次启动 profile 里就是未登录
   * ——用户白登一次。所以先 `Browser.close` 等它自己退，超时才杀树。
   */
  const cleanup = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (watchdog) clearInterval(watchdog)
    try {
      await Promise.race([
        (socket.readyState === 1 ? (socket.send(JSON.stringify({ id: -1, method: 'Browser.close' })), Promise.resolve()) : Promise.resolve()),
        wait(2_000),
      ])
      // 等进程真的退出（最多 4 秒），别在它写 profile 时砍下去
      for (let i = 0; i < 40; i += 1) {
        if (!child.pid) break
        try {
          process.kill(child.pid, 0)
        } catch {
          break
        }
        await wait(100)
      }
    } catch {
      /* 优雅关失败就退回强杀 */
    }
    if (typeof child.pid === 'number') killTree(child.pid, log)
    await wait(150)
  }

  const readyTimeout = options.readyTimeoutMs ?? 25_000
  const deadline = Date.now() + readyTimeout
  let target: PageTarget | undefined
  /**
   * 只认 http(s) 的页面：Edge 首次启动一个新 profile 时会弹出
   * `edge://sync-confirmation-dialog/`（"我们在你所有设备上同步浏览数据"）这类内部页，
   * 它也是 `type: 'page'`，抢在真页面前面。2026-11-17 实测踩到过：
   * 连上去 evaluate 的是那个对话框，永远找不到输入框。
   */
  const isHttpPage = (row: PageTarget): boolean =>
    row.type === 'page' && typeof row.webSocketDebuggerUrl === 'string' && /^https?:/i.test(row.url ?? '')
  while (Date.now() < deadline) {
    try {
      const list = (await getJson(`http://127.0.0.1:${port}/json/list`)) as PageTarget[]
      target = list.find(isHttpPage)
      if (target) break
      // 过半还没 http 页，就退回"随便一个 page"（至少能连上并自己导航）
      if (Date.now() > deadline - readyTimeout / 2) {
        const any = list.find((row) => row.type === 'page' && typeof row.webSocketDebuggerUrl === 'string')
        if (any) {
          target = any
          break
        }
      }
    } catch {
      /* 还没起来 */
    }
    await wait(200)
  }
  if (!target?.webSocketDebuggerUrl) {
    await cleanup()
    throw new Error(
      `浏览器没起来（端口 ${port}，等了 ${Math.round(readyTimeout / 1000)} 秒）。` +
        '常见原因：这个 profile 已经被另一个窗口占着（先全部关掉再试）',
    )
  }

  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket
  if (typeof WebSocketCtor !== 'function') {
    await cleanup()
    throw new Error('宿主 Node 版本过低（没有全局 WebSocket，需要 22+），网页版视觉不可用')
  }

  const socket = new WebSocketCtor(target.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  socket.addEventListener('message', (event: MessageEventLike) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(String(event.data)) as typeof message
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP 错误'))
    else waiter.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const [id, waiter] of pending) {
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(new Error('CDP 连接断了（浏览器被关掉？）'))
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('连不上 CDP WebSocket')))
    setTimeout(() => reject(new Error('连不上 CDP WebSocket（10s）')), 10_000)
  })

  const call = <T = unknown>(method: string, params?: unknown, timeoutMs = 20_000): Promise<T> => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
    })
  }

  const evaluate = async <T>(expression: string, timeoutMs = 30_000): Promise<T> => {
    const result = await call<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: false },
      timeoutMs,
    )
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面执行出错'
      throw new Error(String(detail).slice(0, 400))
    }
    return result?.result?.value as T
  }

  try {
    await call('Page.enable', {}, 10_000).catch(() => undefined)
    await call('Runtime.enable', {}, 10_000).catch(() => undefined)
    await call('DOM.enable', {}, 10_000).catch(() => undefined)
    await call('Network.enable', {}, 10_000).catch(() => undefined)
  } catch {
    /* 老浏览器上个别域开不了不影响 evaluate */
  }

  /**
   * 抹掉无头指纹：`--headless=new` 的 UA 里带 `HeadlessChrome/`，豆包的风控认这个。
   * 2026-11-17 实测：带着它发一次图，服务端直接把登录态作废（下一次打开就是未登录，
   * cookie 明明还在磁盘上）；换成正常 UA 后同一个无头浏览器就能匿名拿到正确答案。
   *
   * 用浏览器**自己的**版本号去拼（不硬编码版本），Edge 升级也不会漂。
   */
  if (headless) {
    try {
      const raw = await evaluate<string>('navigator.userAgent', 5_000)
      if (typeof raw === 'string' && raw.includes('HeadlessChrome')) {
        await call('Network.setUserAgentOverride', { userAgent: raw.replace('HeadlessChrome', 'Chrome') }, 5_000)
      }
    } catch {
      /* 抹不掉也继续（只是风控面大一点） */
    }
  }

  return {
    port,
    evaluate,
    call,
    async goto(url, timeoutMs = 40_000) {
      await call('Page.navigate', { url }, timeoutMs).catch(() => undefined)
      const dl = Date.now() + timeoutMs
      while (Date.now() < dl) {
        const state = await evaluate<string>('document.readyState').catch(() => 'loading')
        if (state === 'complete') return
        await wait(300)
      }
    },
    async screenshot(file) {
      try {
        const shot = await call<{ data?: string }>('Page.captureScreenshot', { format: 'png' }, 15_000)
        if (shot?.data) {
          const fs = await import('node:fs')
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
        }
      } catch {
        /* 截图是证据，不是功能 */
      }
    },
    async close() {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      await cleanup()
    },
  }
}

/** 最小 WebSocket 形状（避免依赖 DOM 的类型定义）。 */
interface WebSocketLike {
  readonly readyState?: number
  addEventListener(type: string, listener: (event: never) => void): void
  send(data: string): void
  close(): void
}
interface MessageEventLike {
  data: unknown
}

/** 浏览器可执行文件找不到时给用户看的提示（设置页直接显示这句）。 */
export function browserMissingHint(): string {
  return `找不到 Edge/Chrome（找过常见安装路径）。装一个 Edge，或设环境变量 DAFEIYU_WEBVISION_BROWSER=${path.join('…', 'msedge.exe')}，或临时目录 ${os.tmpdir()}`
}
