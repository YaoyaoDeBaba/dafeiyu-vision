/**
 * vision/routes — 识图配置/识别/模型列表三条同域路由（**仅回环**）。
 *
 * 与远控那七条路由同一条守卫思路：只认 `localhost/127.0.0.1/::1` 的 Host，
 * 带 Origin 时只回声给「宿主自己」的 origin（`dsh-app:` 与环回 http(s)）。
 * 页面是 `dsh-app://` 上的跨源请求，所以 CORS 走 `applyCors` 同一份白名单。
 *
 * 请求体上限 25MB（base64 后的图片上限 20MB，剩余给 JSON 外壳）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
// 拆包说明（2026-11-16）：原来这里 import 的是本体 `src/pill/routes.ts` 那四个守卫。
// 独立包不能引本体代码，于是同一份实现搬到了 `../http/guards.js`（逐字照抄，只是换了位置）。
import { applyCors, preflight, hostIsLoopback, originIsLoopbackOrAbsent } from '../http/guards.js'
import type { VisionService } from './service.js'
import { VisionError } from './protocols.js'

export const VISION_CONFIG_ROUTE = '/api/dsh-remote-dafeiyu/vision/config'
export const VISION_RECOGNIZE_ROUTE = '/api/dsh-remote-dafeiyu/vision/recognize'
export const VISION_MODELS_ROUTE = '/api/dsh-remote-dafeiyu/vision/models'
/** 网页版（免 key）：探登录态。 */
export const VISION_WEB_STATUS_ROUTE = '/api/dsh-remote-dafeiyu/vision/web/status'
/** 网页版（免 key）：开有头窗口让用户登录。 */
export const VISION_WEB_LOGIN_ROUTE = '/api/dsh-remote-dafeiyu/vision/web/login'

/** 登录态缓存：探一次要起浏览器（几秒），设置页会频繁刷，别每次都真跑。 */
const statusCache = new Map<string, { at: number; value: Record<string, unknown> }>()
const STATUS_TTL_MS = 60_000

const MAX_BODY_BYTES = 25 * 1024 * 1024

export interface VisionRouteDeps {
  service: VisionService
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

function rejected(request: IncomingMessage): string | undefined {
  if (!hostIsLoopback(request.headers.host)) return 'host-not-loopback'
  if (!originIsLoopbackOrAbsent(request.headers.origin)) return 'origin-not-trusted'
  return undefined
}

function readBody(request: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: { ok: true; text: string } | { ok: false; status: number; error: string }): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: '请求太大（图片上限约 20MB）' })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    request.on('error', (error) => finish({ ok: false, status: 400, error: `读取请求失败：${String((error as Error)?.message ?? error)}` }))
  })
}

export function visionConfigHandler(deps: VisionRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      json(response, 200, { ok: true, config: deps.service.view(), storageFile: deps.service.configFile })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: '只支持 GET（读）/ POST（写）' })
      return
    }
    const body = await readBody(request)
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error })
      return
    }
    let parsed: unknown
    try {
      parsed = body.text === '' ? {} : JSON.parse(body.text)
    } catch {
      json(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const payload = (parsed && typeof parsed === 'object' ? parsed : {}) as { config?: unknown }
    const result = deps.service.save(payload.config !== undefined ? payload.config : parsed)
    if (!result.ok) {
      json(response, 500, { ok: false, error: result.error ?? '保存失败' })
      return
    }
    deps.log('识图配置已保存', { enabled: result.config?.enabled, model: result.config?.model })
    json(response, 200, { ok: true, config: result.config })
  }
}

export function visionRecognizeHandler(deps: VisionRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: '只支持 POST' })
      return
    }
    const body = await readBody(request)
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error })
      return
    }
    let parsed: { imageBase64?: unknown; mime?: unknown; prompt?: unknown }
    try {
      parsed = (body.text === '' ? {} : JSON.parse(body.text)) as typeof parsed
    } catch {
      json(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const imageBase64 = typeof parsed.imageBase64 === 'string' ? parsed.imageBase64 : ''
    if (imageBase64 === '') {
      json(response, 400, { ok: false, error: '缺少 imageBase64' })
      return
    }
    try {
      const text = await deps.service.recognize({
        base64: imageBase64,
        mime: typeof parsed.mime === 'string' && parsed.mime.trim() !== '' ? parsed.mime.trim() : 'image/png',
        prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
      })
      deps.log('识图完成', { chars: text.length })
      json(response, 200, { ok: true, text })
    } catch (error) {
      const status = error instanceof VisionError && error.status >= 400 ? 502 : 400
      const message = String((error as Error)?.message ?? error)
      deps.log('识图失败', { message: message.slice(0, 200) })
      json(response, status, { ok: false, error: message })
    }
  }
}

export function visionModelsHandler(deps: VisionRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'POST' && request.method !== 'GET') {
      json(response, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    try {
      const models = await deps.service.listModels()
      json(response, 200, { ok: true, models })
    } catch (error) {
      const status = error instanceof VisionError && error.status >= 400 ? 502 : 400
      json(response, status, { ok: false, error: String((error as Error)?.message ?? error) })
    }
  }
}

const WEB_SITES = ['doubao', 'gemini'] as const
type WebSite = (typeof WEB_SITES)[number]

function parseWebSite(value: unknown): WebSite | undefined {
  return typeof value === 'string' && (WEB_SITES as readonly string[]).includes(value) ? (value as WebSite) : undefined
}

/**
 * 网页版登录态：`GET /vision/web/status?site=doubao|gemini|both[&fresh=1]`。
 * 探一次要起无头浏览器（3~8 秒），所以结果缓存 60 秒；`fresh=1` 强制重探。
 */
export function visionWebStatusHandler(deps: VisionRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      json(response, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const raw = (url.searchParams.get('site') ?? 'both').toLowerCase()
    const fresh = url.searchParams.get('fresh') === '1'
    const sites: WebSite[] = raw === 'both' ? [...WEB_SITES] : (() => {
      const one = parseWebSite(raw)
      return one ? [one] : []
    })()
    if (sites.length === 0) {
      json(response, 400, { ok: false, error: `site 只能是 ${WEB_SITES.join(' / ')} / both` })
      return
    }
    const results: Array<Record<string, unknown>> = []
    for (const site of sites) {
      const cached = statusCache.get(site)
      if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
        results.push({ ...cached.value, cached: true })
        continue
      }
      try {
        const value = (await deps.service.webStatus(site)) as Record<string, unknown>
        statusCache.set(site, { at: Date.now(), value })
        results.push({ ...value, cached: false })
      } catch (error) {
        results.push({ site, label: site, loggedIn: false, error: String((error as Error)?.message ?? error) })
      }
    }
    json(response, 200, { ok: true, sites: results })
  }
}

/**
 * 网页版登录：`POST /vision/web/login {site, waitMs?}`。
 * 会**弹一个有头浏览器窗口**（这是必须的：无头窗口没法登 Google/字节），等用户登完。
 * 默认最多等 150 秒；超时返回 `loggedIn:false` 而不是报错（用户可能只是慢）。
 */
export function visionWebLoginHandler(deps: VisionRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: '只支持 POST' })
      return
    }
    const body = await readBody(request)
    if (!body.ok) {
      json(response, body.status, { ok: false, error: body.error })
      return
    }
    let parsed: { site?: unknown; waitMs?: unknown } = {}
    try {
      parsed = (body.text === '' ? {} : JSON.parse(body.text)) as typeof parsed
    } catch {
      json(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const site = parseWebSite(parsed.site)
    if (!site) {
      json(response, 400, { ok: false, error: `site 必须是 ${WEB_SITES.join(' / ')}` })
      return
    }
    const waitMs = typeof parsed.waitMs === 'number' && Number.isFinite(parsed.waitMs)
      ? Math.min(Math.max(Math.round(parsed.waitMs), 30_000), 300_000)
      : 150_000
    try {
      deps.log('打开网页版登录窗口', { site, waitMs })
      const result = await deps.service.webLogin(site, waitMs)
      statusCache.delete(site)
      deps.log('网页版登录结果', { site, loggedIn: result.loggedIn })
      json(response, 200, { ok: true, site, ...result })
    } catch (error) {
      json(response, 500, { ok: false, site, error: String((error as Error)?.message ?? error) })
    }
  }
}

/** 注册路由并返回注销函数（与 `registerPillRoutes` 同款：一起挂、一起回滚）。 */export function registerVisionRoutes(
  webServer: { register(route: { kind: 'exact'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => unknown }): () => void },
  deps: VisionRouteDeps,
): () => void {
  const definitions = [
    { kind: 'exact' as const, path: VISION_CONFIG_ROUTE, handler: visionConfigHandler(deps) },
    { kind: 'exact' as const, path: VISION_RECOGNIZE_ROUTE, handler: visionRecognizeHandler(deps) },
    { kind: 'exact' as const, path: VISION_MODELS_ROUTE, handler: visionModelsHandler(deps) },
    { kind: 'exact' as const, path: VISION_WEB_STATUS_ROUTE, handler: visionWebStatusHandler(deps) },
    { kind: 'exact' as const, path: VISION_WEB_LOGIN_ROUTE, handler: visionWebLoginHandler(deps) },
  ]
  const off: Array<() => void> = []
  const wrapped = definitions.map((definition) => ({
    ...definition,
    handler: (request: IncomingMessage, response: ServerResponse) => {
      applyCors(request, response)
      if (preflight(request, response)) return
      if (request?.method === 'OPTIONS') {
        response.writeHead(204)
        response.end()
        return
      }
      return definition.handler(request, response)
    },
  }))
  try {
    for (const definition of wrapped) off.push(webServer.register(definition))
  } catch (error) {
    for (const unregister of off.splice(0)) {
      try {
        unregister()
      } catch {
        /* 回滚途中再抛就没别的办法了 */
      }
    }
    throw error
  }
  return () => {
    for (const unregister of off) {
      try {
        unregister()
      } catch {
        /* 宿主可能已经先一步拆了 webServer */
      }
    }
  }
}
