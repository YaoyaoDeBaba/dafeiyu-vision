/**
 * vision/service — 配置落盘 + 识图调用 + 模型列表。宿主侧唯一碰网络的地方。
 *
 * 失败纪律：所有错误都带「下一步怎么做」的描述（`VisionError`），设置页原样显示给用户。
 * 网络请求全部带超时，宿主卡住时脚本不会悬着。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_VISION_CONFIG,
  isWebProtocol,
  normalizeVisionConfig,
  resolveProtocol,
  redactKey,
  toView,
  webSiteOf,
  type VisionConfig,
  type VisionConfigView,
} from './config.js'
import { buildRequest, VisionError, type ImageInput } from './protocols.js'
import { closeAll, loginSite, recognizeViaWeb, webStatus, type WebSiteId } from './web/index.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 三条与协议无关的前置判据（总开关 / 空图 / 太大）。 */
function assertUsable(config: VisionConfig, image: ImageInput): void {
  if (!config.enabled) {
    throw new VisionError('识图未开启：设置 → 大肥鱼 → 人设 → 识图，打开总开关', 0)
  }
  if (image.base64 === '') throw new VisionError('图片内容为空', 0)
  if (image.base64.length * 0.75 > MAX_IMAGE_BYTES) throw new VisionError('图片太大（上限 20MB），先压缩再发', 0)
}

/** 网页版（免 key）识图：拿本机浏览器里已登录的豆包 / Gemini。 */
export async function recognizeViaBrowser(
  config: VisionConfig,
  image: ImageInput,
  dshHome: string,
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): Promise<string> {
  assertUsable(config, image)
  const protocol = resolveProtocol(config)
  if (!isWebProtocol(protocol)) throw new VisionError('当前协议不是网页版', 0)
  const site: WebSiteId = webSiteOf(protocol)
  const prompt = typeof image.prompt === 'string' && image.prompt.trim() !== '' ? image.prompt.trim() : config.prompt
  const result = await recognizeViaWeb(
    site,
    { base64: image.base64, mime: image.mime, prompt, timeoutMs: config.timeoutMs },
    { dshHome, headless: config.webHeadless, log },
  )
  return result.truncated ? `${result.text}\n\n（网页版生成超时被截断：以上是已生成的部分，可加大超时或重试）` : result.text
}

/** 存储目录：`<dshHome>/storages/dsh-remote-dafeiyu`（与远控/人设的 storages 平级）。 */
export function visionDir(dshHome: string): string {
  return path.join(dshHome, 'storages', 'dsh-remote-dafeiyu')
}

export function visionConfigFile(dshHome: string): string {
  return path.join(visionDir(dshHome), 'vision.json')
}

/** 读配置。文件不存在/损坏都回落默认值（不抛：设置页靠它出界面）。 */
export function readVisionConfig(file: string): VisionConfig {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return normalizeVisionConfig(JSON.parse(raw) as unknown)
  } catch {
    return { ...DEFAULT_VISION_CONFIG }
  }
}

/** 写配置（原子替换：先写临时文件再 rename，避免半截 JSON）。 */
export function writeVisionConfig(file: string, config: VisionConfig): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function errorSnippet(body: string): string {
  const text = String(body ?? '').replace(/\s+/g, ' ').trim()
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/**
 * 识图：把图片交给外挂视觉模型，返回文本描述。
 * @param config 生效配置
 * @param image  base64 + mime（+ 单次指令）
 */
export async function recognize(config: VisionConfig, image: ImageInput): Promise<string> {
  assertUsable(config, image)
  if (config.apiKey.trim() === '') {
    throw new VisionError('识图还没配置 API Key：设置 → 大肥鱼 → 人设 → 识图里填外挂视觉模型的 key', 0)
  }

  const prepared = buildRequest(config, image)
  let response: Response
  try {
    response = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(config.timeoutMs) : undefined,
    })
  } catch (error) {
    const reason = String((error as Error)?.message ?? error)
    throw new VisionError(`连不上识图模型（${prepared.url}）：${reason}`, 0)
  }

  const raw = await response.text()
  if (!response.ok) {
    throw new VisionError(`识图模型返回 HTTP ${response.status}：${errorSnippet(raw) || '（空响应）'}`, response.status)
  }
  let json: unknown
  try {
    json = raw === '' ? {} : JSON.parse(raw)
  } catch {
    throw new VisionError(`识图模型返回的不是 JSON：${errorSnippet(raw)}`, response.status)
  }
  const text = prepared.extract(json)
  if (text === '') throw new VisionError('识图模型返回了空描述（换一张图或检查提示词）', response.status)
  return text
}

/** 拉模型列表（设置页「连接拉取」用）。拿不到就抛，由路由转成 4xx。 */
export async function listModels(config: VisionConfig): Promise<string[]> {
  const base = String(config.apiBase ?? '').replace(/\/+$/, '')
  const url = `${base}/models`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
    })
  } catch (error) {
    throw new VisionError(`拉模型列表失败（${url}）：${String((error as Error)?.message ?? error)}`, 0)
  }
  const raw = await response.text()
  if (!response.ok) throw new VisionError(`拉模型列表失败 HTTP ${response.status}：${errorSnippet(raw)}`, response.status)
  try {
    const json = JSON.parse(raw) as { data?: Array<{ id?: unknown }> }
    const models = Array.isArray(json.data)
      ? json.data.map((item) => (typeof item?.id === 'string' ? item.id : '')).filter((id) => id !== '')
      : []
    if (models.length === 0) throw new VisionError('模型列表是空的（这个接口可能不支持 /models）', 0)
    return models
  } catch (error) {
    if (error instanceof VisionError) throw error
    throw new VisionError(`模型列表解析失败：${errorSnippet(raw)}`, response.status)
  }
}

/** `/api` 路由与工具共用的一张快照。 */
export interface VisionService {
  readonly dir: string
  readonly configFile: string
  current(): VisionConfig
  view(): VisionConfigView
  save(input: unknown): { ok: boolean; config?: VisionConfigView; error?: string }
  enabled(): boolean
  recognize(image: ImageInput): Promise<string>
  listModels(): Promise<string[]>
  /** 网页版：探登录态（会起/复用无头浏览器）。 */
  webStatus(site: WebSiteId): Promise<Record<string, unknown>>
  /** 网页版：开有头窗口等用户登录。 */
  webLogin(site: WebSiteId, waitMs?: number): Promise<{ loggedIn: boolean; waitedMs: number }>
  /** 关掉所有网页版浏览器（插件卸载时调）。 */
  dispose(): Promise<void>
  describe(): Record<string, unknown>
}

export function createVisionService(
  dshHome: string,
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void,
): VisionService {
  const dir = visionDir(dshHome)
  const configFile = visionConfigFile(dshHome)
  let config = readVisionConfig(configFile)

  return {
    dir,
    configFile,
    current: () => config,
    view: () => toView(config),
    save(input) {
      const next = normalizeVisionConfig(input, config)
      if (!writeVisionConfig(configFile, next)) {
        return { ok: false, error: '配置写不进去（检查磁盘/权限）' }
      }
      config = next
      return { ok: true, config: toView(config) }
    },
    enabled: () => config.enabled,
    recognize: (image) =>
      isWebProtocol(resolveProtocol(config))
        ? recognizeViaBrowser(config, image, dshHome, log)
        : recognize(config, image),
    listModels: () => listModels(config),
    webStatus: (site) => webStatus(site, { dshHome, headless: config.webHeadless, log }),
    webLogin: (site, waitMs) => loginSite(site, { dshHome, headless: false, waitMs, log }),
    dispose: () => closeAll(log),
    describe: () => {
      const protocol = resolveProtocol(config)
      return {
        enabled: config.enabled,
        protocol,
        webSite: isWebProtocol(protocol) ? webSiteOf(protocol) : null,
        configured: isWebProtocol(protocol) ? true : config.apiKey !== '',
        apiKeyHint: redactKey(config.apiKey),
        model: config.model,
      }
    },
  }
}
