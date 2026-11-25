/**
 * xyq/channel —— 「生成通道」抽象：同一批工具底下可以挂多条后端。
 *
 * 为什么要这一层（2026-11-25）：小云雀之外又接了即梦（画布 CLI + 短剧 CLI），
 * 两条链路**参数形状相近、能力与计费完全不同**。如果直接在 service 里 if/else，
 * 以后再来第三条（或换个名字）就得再动一遍工具层；所以先把「通道」这个形状钉死：
 *
 *   - 通道只认三类输入：生图 / 生视频 / 查额度（外加查模型）；
 *   - 每个通道自己回答「我现在能不能用」（probe），不可用时给**中文原因 + 下一步命令**；
 *   - 通道寻址一律用 `ChannelId`，默认 `'xyq'`——老调用不带 channel 时行为与改动前逐字一致。
 *
 * 纪律：
 * 1. **通道名不许写死在后端实现里**：即梦的实现只认 `'jimeng'`，域名叫什么由调用方决定；
 * 2. `probe()` 永远不抛（找不到 CLI 是「不可用」，不是异常）——上层拿到的是给人看的中文；
 * 3. 不可用**只影响这一条通道**，另一条照常工作（软探测，见 start.ts）。
 */

export const XYQ_CHANNEL_IDS = ['xyq', 'jimeng'] as const

/** 通道 id。业务默认值永远是 `'xyq'`（保持老行为）。 */
export type ChannelId = (typeof XYQ_CHANNEL_IDS)[number]

export const XYQ_CHANNEL_LABELS: Record<ChannelId, string> = {
  xyq: '小云雀',
  jimeng: '即梦',
}

/** 生图入参：两条通道共用的那一份形状（谁多了什么由各自实现自己吃）。 */
export interface ChannelImageInput {
  prompt: string
  model?: string
  images?: string[]
  ratio?: string
  count?: number
  outDir?: string
  sessionKey?: string
}

/** 生视频入参。 */
export interface ChannelVideoInput {
  prompt: string
  model?: string
  duration?: number
  ratio?: string
  images?: string[]
  outDir?: string
  sessionKey?: string
}

export interface ChannelGenerateResult {
  ok: boolean
  message?: string
  files?: string[]
  webLink?: string
  /** 任务 id（云雀是 thread/run，即梦是 thread_id/run_id 或 nodeId）。 */
  taskId?: string
}

export interface ChannelBalanceResult {
  ok: boolean
  totalRemain?: string
  message?: string
}

export interface ChannelModelsResult {
  ok: boolean
  models?: Array<{ key: string; name: string }>
  message?: string
}

/** 探测结果：可用就报**绝对路径**（插件要 spawn，不能赌 PATH）；不可用就报中文原因。 */
export type ChannelProbe =
  | { id: ChannelId; label: string; available: true; cliPath: string }
  | { id: ChannelId; label: string; available: false; reason: string; hint?: string }

/** 「调用前自愈」的开关（用户 2026-11-25 要求：自动动作必须能关掉）。 */
export interface ChannelPreflightOptions {
  /** 缺 CLI 时自动装（默认 true）。false = 只报告 + 给手工命令。 */
  autoInstall?: boolean
  /** 未登录时自动发起浏览器授权（默认 true）。false = 只报告 + 给手工命令。 */
  autoLogin?: boolean
}

/**
 * 自愈结果：
 * - ok=true  → 可以用（notes 是做过的事，给日志/回包用）；
 * - ok=false → 本次调用不能继续，message 是**给人看的中文**（含下一步命令/链接）。
 */
export type ChannelPreflight =
  | { ok: true; notes?: string[] }
  | { ok: false; message: string; needsUser?: boolean }

export interface GenerationChannel {
  readonly id: ChannelId
  readonly label: string
  /** 永远不抛：装没装、能不能跑，都落成一个 ChannelProbe。 */
  probe(): Promise<ChannelProbe>
  /**
   * 调用前自愈（可选实现）：顺序固定——CLI 在不在 → 账号/授权在不在 → 凭据在不在。
   * 不实现就等于「没这层」，老通道行为不变。
   */
  preflight?(options: ChannelPreflightOptions): Promise<ChannelPreflight>
  generateImage(input: ChannelImageInput): Promise<ChannelGenerateResult>
  generateVideo(input: ChannelVideoInput): Promise<ChannelGenerateResult>
  balance(): Promise<ChannelBalanceResult>
  models(kind: 'video' | 'image'): Promise<ChannelModelsResult>
}

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === 'string' && (XYQ_CHANNEL_IDS as readonly string[]).includes(value)
}

/**
 * 把工具入参里的 channel 归一成 ChannelId。
 * - 没传 / 空串 → `'xyq'`（老调用原样工作）
 * - 传了不认识的 → undefined（由调用方给中文报错，别静默回落到云雀）
 */
export function normalizeChannelId(value: unknown): ChannelId | undefined {
  if (value === undefined || value === null) return 'xyq'
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return 'xyq'
  return isChannelId(trimmed) ? trimmed : undefined
}

/** channel 传错时的统一中文文案（工具层直接 throw 这句）。 */
export function channelParamError(value: unknown): string {
  return `channel 只能是 ${XYQ_CHANNEL_IDS.join(' / ')}（默认 xyq），收到的是「${String(value)}」`
}

/** 不可用通道 → 一句用户能照着做的中文（带**绝对路径**与命令）。 */
export function unavailableMessage(probe: ChannelProbe): string {
  if (probe.available) return ''
  const hint = probe.hint !== undefined && probe.hint !== '' ? ` 下一步：${probe.hint}` : ''
  return `${probe.label}通道不可用：${probe.reason}${hint}`
}

/** 纯展示用：`小云雀（xyq）`。 */
export function channelTitle(id: ChannelId): string {
  return `${XYQ_CHANNEL_LABELS[id]}（${id}）`
}
