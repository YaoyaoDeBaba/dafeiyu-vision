/**
 * vision — 大肥鱼「看懂图」的宿主侧：外挂视觉模型配置与识图调用。
 *
 * 为什么不自己训练/内置图像能力：DeepSeek 文本模型没有视觉。这一层干的事和社区
 * `dsh-vision` 同一个思路——把图片交给一个**外挂视觉模型**（OpenAI 兼容 /
 * Responses / Anthropic / Gemini / 自定义），拿回文本描述，再让大肥鱼基于描述回答。
 *
 * 纪律：
 * 1. 配置只落自己的存储目录（`~/.dsh/storages/dsh-remote-dafeiyu/vision.json`），
 *    **不碰人设的 `dsh-persona-dafeiyu/`**（那是另一条兼容边界）。
 * 2. API Key 永不回显（`redactKey`），设置页只显示末尾几位。
 * 3. 识图请求在宿主（Node）侧发起：不受浏览器 CORS 限制，也不把 key 发给页面。
 * 4. 任何失败都收敛成带说明的错误，绝不静默吞掉——「识图不上」必须有可查的原因。
 */

/**
 * 协议。`auto` 按 apiBase 猜，猜错时用户可在设置页手动指定。
 *
 * `web-doubao` / `web-gemini`（0.1.3 新增）不是 HTTP 协议：它们**不用 key**，
 * 而是拿本机浏览器里已登录的网页版去识图（见 `web/`）。这两者不吃 `apiBase` / `apiKey`，
 * 只吃 `webHeadless`。
 */
export type VisionProtocol =
  | 'auto'
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'custom'
  | 'web-doubao'
  | 'web-gemini'

/** 走浏览器（网页版）的协议。 */
export type WebVisionProtocol = 'web-doubao' | 'web-gemini'

export function isWebProtocol(protocol: VisionProtocol): protocol is WebVisionProtocol {
  return protocol === 'web-doubao' || protocol === 'web-gemini'
}

/** 网页版协议 → 站点 id。 */
export function webSiteOf(protocol: WebVisionProtocol): 'doubao' | 'gemini' {
  return protocol === 'web-doubao' ? 'doubao' : 'gemini'
}

export interface VisionConfig {
  /** 总开关。关掉时：不注册工具、不注入提示词段、路由只读配置。 */
  enabled: boolean
  /** 识图模型的基础地址（打到 /v1 这一步，具体路径由协议决定）。 */
  apiBase: string
  apiKey: string
  model: string
  protocol: VisionProtocol
  /** 识图提示词（skill）：告诉视觉模型「怎么描述这张图」。 */
  prompt: string
  timeoutMs: number
  /** 仅 `custom`：请求体 JSON 模板（`{{model}}` `{{prompt}}` `{{image}}` `{{dataUrl}}` `{{mime}}`）。 */
  requestTemplate: string
  /** 仅 `custom`：从响应 JSON 取文本的点号路径，如 `choices.0.message.content`。 */
  responsePath: string
  /**
   * 仅网页版（免 key）：识图时用不用无头浏览器。
   * 默认 true。个别网络/风控环境下网页版会要求有头窗口，那时改成 false（会弹出真窗口）。
   */
  webHeadless: boolean
  /**
   * 仅网页版：在哪个「项目」里发起会话（豆包有项目功能，留空=不指定）。
   * 目的：让识图会话自动归到某个项目下，不污染「最近」列表。
   */
  webProject: string
  /**
   * 「白嫖豆包」：打开后识图走**本机浏览器里已登录的网页版**，不需要 API Key。
   *
   * 这是设置页的主开关（0.1.5 起）；`protocol` 只负责 API 那一路。
   * 兼容旧配置：`protocol` 是 `web-*` 的会被规整成 `freeDoubao: true` + 对应 `webSite`。
   */
  freeDoubao: boolean
  /** 网页版走哪个站点（默认豆包；Gemini 目前站点侧不稳定）。 */
  webSite: WebSiteKey
  /**
   * 识图模式：
   * - `single`：只用一路（白嫖开着就是网页版，关着就是 API）；
   * - `composite`：网页版与 API **都跑**，两边结果合并（一路失败不影响另一路）。
   */
  mode: VisionMode
}

/** 网页版站点。 */
export type WebSiteKey = 'doubao' | 'gemini'
/** 识图模式。 */
export type VisionMode = 'single' | 'composite'

export const DEFAULT_VISION_PROMPT =
  '你是一名专业的图像识别助手。请仔细观察用户提供的图片，用中文给出详细、结构化的描述：' +
  '① 整体是什么（截图/照片/图表/UI 界面等）；② 关键内容与布局；' +
  '③ 图中所有可见文字逐字转录（代码、报错、按钮文案都不要漏）；' +
  '④ 如果这是屏幕截图，重点描述界面上的报错、弹窗、按钮状态。'

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  enabled: false,
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  protocol: 'auto',
  prompt: DEFAULT_VISION_PROMPT,
  timeoutMs: 60_000,
  requestTemplate: '',
  responsePath: '',
  webHeadless: true,
  webProject: '',
  freeDoubao: false,
  webSite: 'doubao',
  mode: 'single',
}

/** 设置页看到的配置：key 打码。 */
export interface VisionConfigView extends Omit<VisionConfig, 'apiKey'> {
  apiKeySet: boolean
  apiKeyHint: string
}

/** 只留末尾四位：`sk-…abcd`。空串原样。 */
export function redactKey(key: string): string {
  const value = String(key ?? '')
  if (value === '') return ''
  if (value.length <= 8) return '********'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

export function toView(config: VisionConfig): VisionConfigView {
  return {
    enabled: config.enabled,
    apiBase: config.apiBase,
    model: config.model,
    protocol: config.protocol,
    prompt: config.prompt,
    timeoutMs: config.timeoutMs,
    requestTemplate: config.requestTemplate,
    responsePath: config.responsePath,
    webHeadless: config.webHeadless,
    webProject: config.webProject,
    freeDoubao: config.freeDoubao,
    webSite: config.webSite,
    mode: config.mode,
    apiKeySet: config.apiKey !== '',
    apiKeyHint: redactKey(config.apiKey),
  }
}

const PROTOCOLS: readonly VisionProtocol[] = [
  'auto',
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
  'custom',
  'web-doubao',
  'web-gemini',
]

function cleanString(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/** 把设置页/配置文件来的脏对象规整成合法配置。**不抛**：坏值各自回落默认。 */
export function normalizeVisionConfig(input: unknown, base: VisionConfig = DEFAULT_VISION_CONFIG): VisionConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  let protocol = typeof raw.protocol === 'string' && (PROTOCOLS as readonly string[]).includes(raw.protocol)
    ? (raw.protocol as VisionProtocol)
    : base.protocol
  let freeDoubao = typeof raw.freeDoubao === 'boolean' ? raw.freeDoubao : base.freeDoubao
  let webSite: WebSiteKey = raw.webSite === 'gemini' || raw.webSite === 'doubao' ? raw.webSite : base.webSite

  // 旧配置迁移（0.1.3/0.1.4 把「网页版」写在 protocol 里）：挪到 freeDoubao + webSite，protocol 回到 auto
  if (isWebProtocol(protocol)) {
    freeDoubao = true
    webSite = webSiteOf(protocol)
    protocol = 'auto'
  }

  const timeout = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
    ? Math.min(Math.max(Math.round(raw.timeoutMs), 5_000), 300_000)
    : base.timeoutMs
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    apiBase: cleanString(raw.apiBase, base.apiBase, 500) || base.apiBase,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 500) : base.apiKey,
    model: cleanString(raw.model, base.model, 200) || base.model,
    protocol,
    prompt: cleanString(raw.prompt, base.prompt, 4_000) || base.prompt,
    timeoutMs: timeout,
    requestTemplate: cleanString(raw.requestTemplate, base.requestTemplate, 8_000),
    responsePath: cleanString(raw.responsePath, base.responsePath, 200),
    webHeadless: typeof raw.webHeadless === 'boolean' ? raw.webHeadless : base.webHeadless,
    webProject: cleanString(raw.webProject, base.webProject, 100),
    freeDoubao,
    webSite,
    mode: raw.mode === 'composite' ? 'composite' : raw.mode === 'single' ? 'single' : base.mode,
  }
}

/**
 * 这次识图要跑哪几路。
 *
 * - 白嫖关着 → 只跑 API；
 * - 白嫖开着 + 单一 → 只跑网页版；
 * - 白嫖开着 + 复合 → 两路都跑（**网页版与 API 并行**，各自独立，一路失败不影响另一路）。
 */
export function planRecognition(config: VisionConfig): { webSite: WebSiteKey | null; api: boolean } {
  if (!config.freeDoubao) return { webSite: null, api: true }
  return { webSite: config.webSite, api: config.mode === 'composite' }
}

// ── 按 apiBase 猜协议（与 dsh-vision 同一套判据；网页版协议不参与猜）────────
export function detectProtocol(apiBase: string): Exclude<VisionProtocol, 'auto' | 'custom' | WebVisionProtocol> {
  const lower = String(apiBase ?? '').toLowerCase()
  if (lower.includes('anthropic')) return 'anthropic'
  if (lower.includes('generativelanguage') || lower.includes('googleapis') || lower.includes('gemini')) return 'gemini'
  if (lower.includes('/responses')) return 'openai-responses'
  return 'openai-chat'
}

export function resolveProtocol(config: VisionConfig): Exclude<VisionProtocol, 'auto'> {
  return config.protocol === 'auto' ? detectProtocol(config.apiBase) : config.protocol
}
