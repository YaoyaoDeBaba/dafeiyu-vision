/**
 * xyq/routes — 设置页用的只读/配置路由（仅回环，写要 `x-drc-pair`）。
 *
 * 只暴露“设置页需要的”：配置（密钥脱敏）、登录状态、余额、模型列表。
 * 生成本身走工具调用，不在这里开第二条收费入口。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
// 拆包说明（2026-11-16）：原来 import 的是本体 `src/pill/routes.ts` 那四个守卫，
// 现在用本包 `../http/guards.js` 里逐字照抄的那一份（独立包不能引本体代码）。
import { applyCors, preflight, hostIsLoopback, originIsLoopbackOrAbsent } from '../http/guards.js'
import type { XyqService } from './service.js'
import type { CanvasService } from './canvas/service.js'
import { channelParamError, normalizeChannelId, type ChannelId } from './channel.js'

/**
 * 路由上的 channel 解析：**没传就用设置里的默认通道**（默认 xyq）。
 * 传了不认识的 → 400 中文原因（不静默回落，免得"以为在跑即梦、其实在跑云雀"）。
 */
function channelFrom(value: string | null, deps: { service: XyqService }): { channel: ChannelId; error?: string } {
  const fallback = deps.service.config().defaultChannel
  if (value === null || value.trim() === '') return { channel: fallback }
  const id = normalizeChannelId(value)
  return id === undefined ? { channel: fallback, error: channelParamError(value) } : { channel: id }
}

export const XYQ_CONFIG_ROUTE = '/api/dsh-remote-dafeiyu/xyq/config'
export const XYQ_STATUS_ROUTE = '/api/dsh-remote-dafeiyu/xyq/status'
export const XYQ_BALANCE_ROUTE = '/api/dsh-remote-dafeiyu/xyq/balance'
export const XYQ_MODELS_ROUTE = '/api/dsh-remote-dafeiyu/xyq/models'
export const XYQ_DESCRIBE_ROUTE = '/api/dsh-remote-dafeiyu/xyq/describe'
export const XYQ_GENERATE_ROUTE = '/api/dsh-remote-dafeiyu/xyq/generate'
export const XYQ_RESULT_ROUTE = '/api/dsh-remote-dafeiyu/xyq/result'
export const XYQ_FILE_ROUTE = '/api/dsh-remote-dafeiyu/xyq/file'
/** 即梦画布只读（设置页面板用）：?what=status|canvases|current|nodes */
export const XYQ_CANVAS_ROUTE = '/api/dsh-remote-dafeiyu/xyq/canvas'

export interface XyqRouteDeps {
  service: XyqService
  /** 生成的产物目录（file 路由只允许读这下面）。 */
  outDir: string
  /** 即梦画布只读服务（0.9.0）；没装画布 CLI 时为 undefined，路由如实回 unavailable。 */
  canvas?: CanvasService
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 16 * 1024) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function xyqConfigHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      json(response, 200, { ok: true, config: deps.service.view() })
      return
    }
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }
    if (String(request.headers['x-drc-pair'] ?? '') === '') {
      json(response, 403, { ok: false, error: 'missing x-drc-pair' })
      return
    }
    try {
      const body = JSON.parse(await readBody(request)) as unknown
      json(response, 200, { ok: true, config: deps.service.update(body) })
    } catch (error) {
      json(response, 400, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** status / balance / models 三条只读路由。 */
export function xyqQueryHandler(kind: 'status' | 'balance' | 'models', deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { ok: false, error: '只支持 GET' })
      return
    }
    try {
      if (kind === 'status') {
        json(response, 200, await deps.service.status())
        return
      }
      if (kind === 'balance') {
        const picked = channelFrom(new URL(request.url ?? '/', 'http://localhost').searchParams.get('channel'), deps)
        if (picked.error !== undefined) {
          json(response, 400, { ok: false, error: picked.error })
          return
        }
        json(response, 200, { ...(await deps.service.balance(picked.channel)), channel: picked.channel })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const type = url.searchParams.get('type') === 'image' ? 'image' : 'video'
      const picked = channelFrom(url.searchParams.get('channel'), deps)
      if (picked.error !== undefined) {
        json(response, 400, { ok: false, error: picked.error })
        return
      }
      const models = await deps.service.models(type, picked.channel, { autoInstall: url.searchParams.get('autoInstall') === 'true' })
      json(response, 200, { ...models, channel: picked.channel })
    } catch (error) {
      deps.log('小云雀查询路由失败', { kind, message: String((error as Error)?.message ?? error).slice(0, 160) })
      json(response, 500, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /xyq/describe?name=&type=`：模型的比例/分辨率/时长等选项。 */
export function xyqDescribeHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) return json(response, 403, { ok: false, error: denied })
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: '只支持 GET' })
    const url = new URL(request.url ?? '/', 'http://localhost')
    const name = (url.searchParams.get('name') ?? '').trim()
    const type = url.searchParams.get('type') === 'video' ? 'video' : 'image'
    if (name === '') return json(response, 400, { ok: false, error: '缺少 name' })
    try {
      json(response, 200, await deps.service.describe(name, type))
    } catch (error) {
      json(response, 500, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `POST /xyq/generate`：提交生图/生视频任务（不等待完成）。 */
export function xyqGenerateHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) return json(response, 403, { ok: false, error: denied })
    if (request.method !== 'POST') return json(response, 405, { ok: false, error: '只支持 POST' })
    if (String(request.headers['x-drc-pair'] ?? '') === '') return json(response, 403, { ok: false, error: 'missing x-drc-pair' })
    try {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>
      const type = body.type === 'video' ? 'video' : 'image'
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (prompt === '' || model === '') return json(response, 400, { ok: false, error: 'prompt 与 model 必填' })
      try {
        const { mkdirSync } = await import('node:fs')
        mkdirSync(deps.outDir, { recursive: true })
      } catch {
        /* 目录删了就删了，下载时会报错 */
      }
      const sessionKey = typeof body.sessionKey === 'string' && body.sessionKey !== '' ? body.sessionKey : 'xyq-panel'
      const picked = channelFrom(typeof body.channel === 'string' ? body.channel : null, deps)
      if (picked.error !== undefined) return json(response, 400, { ok: false, error: picked.error })
      /*
       * 即梦通道没有「提交→再轮询」两段：它的一次性命令自带 `--wait`，所以这里**同步**跑完再回文件。
       * 返回形状多带 `mode:'sync'` 与 `files`，面板/手机按这个分支处理（云雀那条仍然是 threadId）。
       */
      if (picked.channel !== 'xyq') {
        const images = Array.isArray(body.images) ? body.images.filter((value): value is string => typeof value === 'string' && value !== '') : []
        const result =
          type === 'video'
            ? await deps.service.generateVideo({
                prompt,
                model,
                channel: picked.channel,
                images,
                outDir: deps.outDir,
                ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
                ...(typeof body.ratio === 'string' ? { ratio: body.ratio } : {}),
                autoInstall: body.autoInstall === true,
              })
            : await deps.service.generateImage({
                prompt,
                model,
                channel: picked.channel,
                images,
                outDir: deps.outDir,
                ...(typeof body.ratio === 'string' ? { ratio: body.ratio } : {}),
                ...(typeof body.count === 'number' ? { count: body.count } : {}),
                autoInstall: body.autoInstall === true,
              })
        json(response, result.ok ? 200 : 502, { ...result, channel: picked.channel, mode: 'sync' })
        return
      }
      const result =
        type === 'video'
          ? await deps.service.startVideo({
              prompt,
              model,
              sessionKey,
              ...(typeof body.duration === 'number' ? { duration: body.duration } : {}),
              ...(typeof body.ratio === 'string' ? { ratio: body.ratio } : {}),
              ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
            })
          : await deps.service.startImage({
              prompt,
              model,
              sessionKey,
              ...(typeof body.ratio === 'string' ? { ratio: body.ratio } : {}),
              ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
              ...(typeof body.count === 'number' ? { count: body.count } : {}),
            })
      json(response, result.ok ? 200 : 502, result)
    } catch (error) {
      json(response, 400, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /xyq/result?threadId=&runId=`：查一次任务状态。 */
export function xyqResultHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) return json(response, 403, { ok: false, error: denied })
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: '只支持 GET' })
    const url = new URL(request.url ?? '/', 'http://localhost')
    const threadId = (url.searchParams.get('threadId') ?? '').trim()
    const runId = (url.searchParams.get('runId') ?? '').trim()
    if (threadId === '' || runId === '') return json(response, 400, { ok: false, error: '缺少 threadId / runId' })
    try {
      json(response, 200, await deps.service.queryOnce(threadId, runId, deps.outDir))
    } catch (error) {
      json(response, 500, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}

/** `GET /xyq/file?path=`：把生成的文件读给面板预览（只允许 outDir 下的文件）。 */
export function xyqFileHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied) return json(response, 403, { ok: false, error: denied })
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: '只支持 GET' })
    const url = new URL(request.url ?? '/', 'http://localhost')
    const target = (url.searchParams.get('path') ?? '').trim()
    if (target === '') return json(response, 400, { ok: false, error: '缺少 path' })
    const path = await import('node:path')
    const fs = await import('node:fs')
    const resolved = path.resolve(target)
    const root = path.resolve(deps.outDir)
    if (!resolved.startsWith(root + path.sep)) return json(response, 403, { ok: false, error: 'path-escape' })
    try {
      const data = fs.readFileSync(resolved)
      const ext = path.extname(resolved).toLowerCase()
      const mime = ext === '.mp4' ? 'video/mp4' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.byteLength })
      if (request.method === 'HEAD') response.end()
      else response.end(data)
    } catch {
      json(response, 404, { ok: false, error: '文件不存在' })
    }
  }
}

/**
 * `GET /xyq/canvas?what=status|canvases|current|nodes[&canvasId=&type=&status=&query=&limit=&offset=]`
 *
 * 设置页面板用，**只读**：写操作（建画布/建节点/跑/删）不在这里开，避免面板成为收费入口。
 */
export function xyqCanvasHandler(deps: XyqRouteDeps) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCors(request, response)
    if (preflight(request, response)) return
    const denied = rejected(request)
    if (denied !== undefined) {
      json(response, 403, { ok: false, error: denied })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { ok: false, error: '只支持 GET（画布只读）' })
      return
    }
    const canvas = deps.canvas
    if (canvas === undefined) {
      json(response, 200, { ok: false, unavailable: true, error: '没装即梦画布 CLI（dreamina-canvas），画布面板不可用' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const what = (url.searchParams.get('what') ?? 'status').trim()
    try {
      if (what === 'status') {
        const result = await canvas.status()
        json(response, 200, result)
        return
      }
      if (what === 'canvases') {
        json(response, 200, await canvas.canvases())
        return
      }
      if (what === 'current') {
        json(response, 200, await canvas.current())
        return
      }
      if (what === 'nodes') {
        const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
        const offsetParam = Number.parseInt(url.searchParams.get('offset') ?? '', 10)
        const result = await canvas.nodes({
          ...(url.searchParams.get('canvasId') === null ? {} : { canvasId: String(url.searchParams.get('canvasId')) }),
          ...(url.searchParams.get('type') === null ? {} : { type: String(url.searchParams.get('type')) }),
          ...(url.searchParams.get('status') === null ? {} : { status: String(url.searchParams.get('status')) }),
          ...(url.searchParams.get('query') === null ? {} : { query: String(url.searchParams.get('query')) }),
          ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
          ...(Number.isFinite(offsetParam) ? { offset: offsetParam } : {}),
        })
        json(response, 200, result)
        return
      }
      json(response, 400, { ok: false, error: `what 只能是 status / canvases / current / nodes，收到的是「${what}」` })
    } catch (error) {
      deps.log('画布只读路由失败', { what, message: String((error as Error)?.message ?? error).slice(0, 160) })
      json(response, 500, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
}