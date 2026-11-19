/**
 * web/index —— 网页版视觉的生命周期与入口。
 *
 * 三条纪律，都是「不这么做就现场翻车」的那种：
 * 1. **一个站点只留一个浏览器**：同一个 profile 不能开两份（第二个进程会直接退出，CDP 连不上）；
 * 2. **串行**：网页版没有并发语义，两个请求同时发会互相污染对话页；队列深度上限 2，超了直接拒绝；
 * 3. **空闲自关**：默认 5 分钟没人用就关浏览器（省内存、也少一分风控面），下次用再起。
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchCdpBrowser, type CdpClient, type WebLog } from './driver.js'
import { askSite, isWebSiteId, pollTrue, probeLogin, SITES, type AskResult, type WebSiteId } from './sites.js'
import { VisionError } from '../protocols.js'

/** profile 目录：`<dshHome>/storages/dsh-remote-dafeiyu/webvision/<site>`（与 vision.json 同域）。 */
export function webProfileDir(dshHome: string, site: WebSiteId): string {
  return path.join(dshHome, 'storages', 'dsh-remote-dafeiyu', 'webvision', site)
}

export interface WebOptions {
  dshHome: string
  headless?: boolean
  /** 请求之间的最小间隔（礼貌 + 降风控）。 */
  minGapMs?: number
  /** 空闲多久关浏览器。 */
  idleMs?: number
  /** 在哪个「项目」里发起会话（豆包支持，留空=不指定）。 */
  project?: string
  log?: WebLog
}

interface Runtime {
  client?: CdpClient
  chain: Promise<unknown>
  pending: number
  lastUsed: number
  idleTimer?: NodeJS.Timeout
  /** 登录用有头窗口时记下，避免下一次请求误以为可以继续用 */
  headless?: boolean
}

const runtimes = new Map<WebSiteId, Runtime>()
const MAX_QUEUE = 2

function runtimeOf(site: WebSiteId): Runtime {
  let runtime = runtimes.get(site)
  if (!runtime) {
    runtime = { chain: Promise.resolve(), pending: 0, lastUsed: 0 }
    runtimes.set(site, runtime)
  }
  return runtime
}

function scheduleIdleClose(site: WebSiteId, options: WebOptions): void {
  const runtime = runtimeOf(site)
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer)
  const idleMs = options.idleMs ?? 5 * 60_000
  runtime.idleTimer = setTimeout(() => {
    void closeSite(site, options.log)
  }, idleMs)
  runtime.idleTimer.unref?.()
}

export async function closeSite(site: WebSiteId, log?: WebLog): Promise<void> {
  const runtime = runtimes.get(site)
  if (!runtime) return
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer)
    runtime.idleTimer = undefined
  }
  const client = runtime.client
  runtime.client = undefined
  if (client) {
    log?.('关闭网页版浏览器', { site })
    await client.close().catch(() => undefined)
  }
}

export async function closeAll(log?: WebLog): Promise<void> {
  for (const site of runtimes.keys()) await closeSite(site, log)
}

async function ensureBrowser(site: WebSiteId, options: WebOptions, headless: boolean): Promise<CdpClient> {
  const runtime = runtimeOf(site)
  /*
   * **有实例就复用，绝不因为"无头/有头不一致"重开**（2026-11-19 修的坑）：
   * 用户在登录窗口里打字时，设置页只要刷新一次登录态，就会把那个窗口关掉重开无头实例——
   * 表现是"登录窗口自己消失了"。headless 只是启动偏好，不影响能不能用。
   */
  if (runtime.client) {
    runtime.lastUsed = Date.now()
    return runtime.client
  }
  const profileDir = webProfileDir(options.dshHome, site)
  fs.mkdirSync(profileDir, { recursive: true })
  const client = await launchCdpBrowser({
    profileDir,
    headless,
    log: options.log,
  })
  runtime.client = client
  runtime.headless = headless
  runtime.lastUsed = Date.now()
  return client
}

/** 网页版识图：塞图 → 提问 → 抽回答。同一个站点的请求串行。 */
export async function recognizeViaWeb(
  site: WebSiteId,
  input: { base64: string; mime: string; prompt: string; timeoutMs: number },
  options: WebOptions,
): Promise<AskResult> {
  const runtime = runtimeOf(site)
  if (runtime.pending >= MAX_QUEUE) {
    throw new VisionError(`${SITES[site].label}还在处理上一个请求（网页版一次只能跑一个），等它答完再试`, 429)
  }
  runtime.pending += 1
  const gap = Math.max(0, (options.minGapMs ?? 5_000) - (Date.now() - runtime.lastUsed))
  const task = runtime.chain
    .catch(() => undefined)
    .then(async () => {
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
      const client = await ensureBrowser(site, options, options.headless !== false)
      try {
        return await askSite(client, SITES[site], {
          base64: input.base64,
          mime: input.mime,
          prompt: input.prompt,
          timeoutMs: input.timeoutMs,
          project: options.project,
          log: options.log,
        })
      } finally {
        runtime.lastUsed = Date.now()
        scheduleIdleClose(site, options)
      }
    })
    .finally(() => {
      runtime.pending = Math.max(0, runtime.pending - 1)
    })
  runtime.chain = task.catch(() => undefined)
  return task as Promise<AskResult>
}

/**
 * 登录会话本体：进站点 → **把窗口顶到前台** → 轮询登录态。
 *
 * 单独抽出来是为了能测（假 CdpClient 就能钉住"必须置顶"这条，2026-11-18 的故障正是没置顶：
 * 窗口开了但被 DSH 主窗口盖住，用户以为"什么都没弹"）。
 */
export async function runLoginSession(
  client: CdpClient,
  site: WebSiteId,
  options: { waitMs?: number; log?: WebLog } = {},
): Promise<{ loggedIn: boolean; waitedMs: number }> {
  const startedAt = Date.now()
  const deadline = Date.now() + (options.waitMs ?? 180_000)
  await client.goto(SITES[site].loginUrl)
  await client.bringToFront()
  options.log?.('登录窗口已弹出并置顶', { site })

  /*
   * 必须先等**页面渲染完**再判登录：页面刚打开那一瞬，豆包的「登录」按钮还没渲出来，
   * "没有登录按钮"就会被误判成"已登录"（2026-11-19 实测：等 0.5 秒就报 loggedIn:true，
   * 而那条 profile 明明是未登录）。判据还要连续两次为真（约 4 秒），挡掉首屏抖动。
   */
  const ready = await pollTrue(client, `!!document.querySelector(${JSON.stringify(SITES[site].editorSelector)})`, 25_000)
  let loggedIn = false
  if (ready) {
    let streak = 0
    while (Date.now() < deadline) {
      const now = await client.evaluate<boolean>(SITES[site].loginProbe).catch(() => false)
      streak = now ? streak + 1 : 0
      if (streak >= 2) {
        loggedIn = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  } else {
    options.log?.('登录窗口里页面没渲染出来（找不到输入框），继续等', { site })
  }
  // 登录后可能跳到别的页，再顶一次（用户要接着在新页面里操作）
  await client.bringToFront().catch(() => undefined)
  return { loggedIn, waitedMs: Date.now() - startedAt }
}

/**
 * 登录：必须有头窗口，等用户点到登录成功为止。
 * 认证信息会留在 profile 里；成功后窗口留 2 分钟（用户可能还想检查一下），然后自关。
 */
export async function loginSite(
  site: WebSiteId,
  options: WebOptions & { waitMs?: number },
): Promise<{ loggedIn: boolean; waitedMs: number }> {
  const runtime = runtimeOf(site)
  const alreadyBusy = runtime.client !== undefined || runtime.pending > 0
  if (alreadyBusy) await closeSite(site, options.log)

  const client = await ensureBrowser(site, options, false)
  try {
    const result = await runLoginSession(client, site, { waitMs: options.waitMs, log: options.log })
    runtime.lastUsed = Date.now()
    scheduleIdleClose(site, { ...options, idleMs: 120_000 })
    return result
  } catch (error) {
    await closeSite(site, options.log)
    throw error
  }
}

/** 探登录态（会起无头浏览器，慢；路由层要缓存）。 */
export async function webStatus(
  site: WebSiteId,
  options: WebOptions,
): Promise<{ site: WebSiteId; label: string; loggedIn: boolean; profileDir: string; profileExists: boolean; url?: string; error?: string }> {
  const profileDir = webProfileDir(options.dshHome, site)
  const base = { site, label: SITES[site].label, profileDir, profileExists: fs.existsSync(profileDir) }
  try {
    const client = await ensureBrowser(site, options, true)
    const probe = await probeLogin(client, SITES[site])
    /*
     * 探完就关（2026-11-19 用户实测踩到）：探测用的无头实例会**一直占着 profile**，
     * 用户紧接着点「登录」时，有头窗口会把请求交给它然后自己退出 —— 表现就是"点了没反应"。
     * 只有当时开的是无头实例才关；有头登录窗口开着时不能关，那是用户正在用的。
     */
    const runtime = runtimeOf(site)
    if (runtime.headless === true) await closeSite(site, options.log)
    else scheduleIdleClose(site, options)
    return { ...base, loggedIn: probe.loggedIn, url: probe.url }
  } catch (error) {
    return { ...base, loggedIn: false, error: String((error as Error)?.message ?? error) }
  }
}

export { SITES, isWebSiteId, type AskResult, type WebSiteId }