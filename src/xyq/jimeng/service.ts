/**
 * xyq/jimeng/service —— 即梦通道的实现（`GenerationChannel` 的 jimeng 那一份）。
 *
 * 只用**短剧/一体化 CLI**（`jimeng-novel`）的三个一次性命令，映射关系与云雀那套一一对应：
 *   生图     `jimeng-novel generate-image --model <key> --prompt <p> [--image] [--ratio] [--generate-image-count] --wait N --out <dir>/ -j`
 *   生视频   `jimeng-novel generate-video --model <key> --prompt <p> [--duration] [--image] --wait N --out <dir>/ -j`
 *   查额度   `jimeng-novel credit get -j`（返回 `data.balance`）
 *   查模型   `jimeng-novel model list --type image|video -j`（返回 `data.items[].key/name`）
 * 为什么选这些而不是 `node create/run`（画布语义）：一次性命令自带「提交→带 --wait 等待→下载」，
 * 与云雀 generate-image + query-result 的节奏同形，工具层不用为两条通道写两套轮询。
 *
 * 输出信封：`{status,data,error,context}`。鉴权失败不是异常而是 `error.code='AUTH_FAILED'`，
 * 这里必须把它翻成**用户能照做的一步**（含绝对路径的 login 命令），不许静默失败。
 */
import os from 'node:os'
import path from 'node:path'
import type { CliRunner } from '../cli.js'
import type {
  ChannelBalanceResult,
  ChannelGenerateResult,
  ChannelImageInput,
  ChannelModelsResult,
  ChannelPreflight,
  ChannelPreflightOptions,
  ChannelProbe,
  ChannelVideoInput,
  GenerationChannel,
} from '../channel.js'
import { createJimengSelfHealer, type JimengSelfHealer } from '../selfheal.js'
import { JIMENG_INSTALL_HINT, locateJimengCli, type JimengCliPaths, type LocateDeps } from './cli.js'

export interface JimengServiceDeps {
  run: CliRunner
  /** 定位函数（默认走 locateJimengCli；测试注入固定路径）。 */
  locate?: () => JimengCliPaths
  locateDeps?: LocateDeps
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  /** 产物落盘目录，必须是**绝对路径**：CLI 子进程的 cwd 在 tmp 里（见 ../cli.ts 的理由）。 */
  outDir?: string
  defaultImageModel?: string
  defaultVideoModel?: string
  /** 单次命令里 CLI 自己最多等多久（秒）。超时就返回 running，由调用方再查。 */
  waitImageSec?: number
  waitVideoSec?: number
  /** 测试注入：换掉自愈器。 */
  healer?: JimengSelfHealer
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  fetchText?: (url: string) => Promise<string>
  writeTempScript?: (name: string, content: string) => { file: string; cleanup: () => void }
  installTimeoutMs?: number
}

interface Envelope {
  status?: string
  data?: unknown
  error?: { code?: string; message?: string; hint?: string }
}

function parseEnvelope(stdout: string): Envelope | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === undefined) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed !== null && typeof parsed === 'object') {
        const envelope: Envelope = {}
        if (typeof parsed.status === 'string') envelope.status = parsed.status
        if ('data' in parsed) envelope.data = parsed.data
        if (parsed.error !== null && typeof parsed.error === 'object') envelope.error = parsed.error as Envelope['error']
        return envelope
      }
    } catch {
      /* 不是 JSON 行：命令行可能夹着提示行，继续往上找 */
    }
  }
  return undefined
}

const MEDIA_EXT = /\.(mp4|mov|webm|mkv|png|jpe?g|webp|gif|bmp|mp3|wav|m4a)$/i

/** 从任意 JSON 里捞出「像产物文件」的字符串（CLI 各命令的字段名不统一，别赌一个键）。 */
export function collectMediaPaths(node: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 8 || node === null || node === undefined) return acc
  if (typeof node === 'string') {
    if (MEDIA_EXT.test(node) && !acc.includes(node)) acc.push(node)
    return acc
  }
  if (Array.isArray(node)) {
    for (const item of node) collectMediaPaths(item, acc, depth + 1)
    return acc
  }
  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) collectMediaPaths(value, acc, depth + 1)
  }
  return acc
}

function pickNumber(node: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 6 || node === null || node === undefined) return undefined
  if (typeof node === 'number' && Number.isFinite(node)) return node
  if (typeof node === 'string' && node.trim() !== '' && Number.isFinite(Number(node))) return Number(node)
  if (typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickNumber(item, keys, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = node as Record<string, unknown>
  for (const key of keys) {
    const found = pickNumber(record[key], keys, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function loginHint(cliPath: string): string {
  return `在终端跑「"${cliPath}" login --non-interactive」，把返回的授权链接发给用户点开（浏览器里确认后，按返回的 nextCommand 续等即完成登录）`
}

/** CLI 的信封错误 → 一句中文。鉴权类必须带下一步命令。 */
function envelopeMessage(envelope: Envelope, cliPath: string, raw: string): string | undefined {
  const error = envelope.error
  if (error === undefined) {
    if (envelope.status === 'error') return raw.trim() === '' ? '即梦 CLI 返回了错误（没有细节）' : raw.trim().slice(0, 300)
    return undefined
  }
  const code = error.code ?? ''
  const text = `${error.message ?? ''} ${error.hint ?? ''} ${raw}`
  if (code === 'AUTH_FAILED' || /not_logged_in|未登录|登录已失效|credential_expired|nextAction\"?\s*:\s*\"login/i.test(text)) {
    return `即梦还没登录（或登录已过期）。${loginHint(cliPath)}`
  }
  const message = [error.message, error.hint].filter((part) => typeof part === 'string' && part !== '').join('｜')
  return message === '' ? `即梦 CLI 报错：${code === '' ? '未知' : code}` : `即梦报错：${message.slice(0, 300)}`
}

export function createJimengService(deps: JimengServiceDeps): GenerationChannel {
  const locate = (): JimengCliPaths => (deps.locate ?? (() => locateJimengCli(deps.locateDeps)))()
  const noopLog = (): void => {}
  // 自愈器：装 CLI / 发起浏览器授权都只在这里发生，且**只在该通道被调用时**才跑。
  const healer =
    deps.healer ??
    createJimengSelfHealer({
      run: deps.run,
      log: deps.log ?? noopLog,
      locate,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.fetchText === undefined ? {} : { fetchText: deps.fetchText }),
      ...(deps.writeTempScript === undefined ? {} : { writeTempScript: deps.writeTempScript }),
      ...(deps.installTimeoutMs === undefined ? {} : { installTimeoutMs: deps.installTimeoutMs }),
    })
  const waitImage = deps.waitImageSec ?? 120
  const waitVideo = deps.waitVideoSec ?? 300
  const outDir = deps.outDir ?? path.join(os.homedir(), 'jimeng-output')
  const withSeparator = (dir: string): string => (dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}${path.sep}`)

  async function probe(): Promise<ChannelProbe> {
    const paths = locate()
    if (paths.novel === undefined) {
      return {
        id: 'jimeng',
        label: '即梦',
        available: false,
        reason: '没找到即梦 CLI（jimeng-novel）——不是没登录，是这台机器上没装',
        hint: `装它：${JIMENG_INSTALL_HINT}`,
      }
    }
    return { id: 'jimeng', label: '即梦', available: true, cliPath: paths.novel }
  }

  /** 跑一条命令；返回信封或中文错误。 */
  async function call(args: string[], timeoutMs: number): Promise<{ envelope?: Envelope; message?: string }> {
    const result = await deps.run(args, { env: {}, timeoutMs })
    const raw = `${result.stdout}\n${result.stderr}`
    if (result.timedOut) return { message: `即梦命令超时（${Math.round(timeoutMs / 1000)} 秒）；任务可能还在跑，别重新提交` }
    const envelope = parseEnvelope(result.stdout)
    if (envelope === undefined) {
      if (result.code !== 0) {
        const reason = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim()
        return { message: reason === '' ? `即梦命令失败（退出码 ${result.code}）` : `即梦命令失败：${reason.slice(0, 300)}` }
      }
      return { message: '即梦返回了无法解析的内容（不是 JSON 信封）' }
    }
    const message = envelopeMessage(envelope, args[0] ?? '', raw)
    if (message !== undefined) return { message }
    return { envelope }
  }

  async function ensureAvailable(): Promise<{ cli: string } | { message: string }> {
    const status = await probe()
    if (!status.available) {
      const hint = status.hint === undefined ? '' : ` 下一步：${status.hint}`
      return { message: `即梦通道不可用：${status.reason}。${hint}` }
    }
    return { cli: status.cliPath }
  }

  return {
    id: 'jimeng',
    label: '即梦',
    probe,

    /** 顺序固定：CLI 在不在（缺就装）→ 授权在不在（缺就发一次授权链接）。 */
    async preflight(options: ChannelPreflightOptions = {}): Promise<ChannelPreflight> {
      const autoInstall = options.autoInstall ?? false
      const autoLogin = options.autoLogin ?? true
      const ensured = await healer.ensureCli(autoInstall)
      if (!ensured.ok || ensured.cliPath === undefined) {
        return { ok: false, message: ensured.message ?? '即梦 CLI 不可用' }
      }
      const login = await healer.ensureLogin(ensured.cliPath, autoLogin)
      if (!login.ok) {
        return { ok: false, message: login.message ?? '即梦需要先授权', needsUser: true }
      }
      return { ok: true }
    },

    async generateImage(input: ChannelImageInput): Promise<ChannelGenerateResult> {
      const ready = await ensureAvailable()
      if ('message' in ready) return { ok: false, message: ready.message }
      const model = (input.model ?? deps.defaultImageModel ?? '').trim()
      if (model === '') {
        return { ok: false, message: '没指定即梦图片模型。先用「jimeng-novel model list --type image」查模型 key（例如 seedream_5.5），再传 model。' }
      }
      if (input.prompt.trim() === '') return { ok: false, message: '需要 prompt（用户原始描述）' }
      const args = [ready.cli, 'generate-image', '--model', model, '--prompt', input.prompt]
      for (const image of input.images ?? []) if (image !== '') args.push('--image', image)
      if (typeof input.ratio === 'string' && input.ratio !== '') args.push('--ratio', input.ratio)
      if (typeof input.count === 'number' && Number.isFinite(input.count) && input.count > 0) {
        args.push('--generate-image-count', String(Math.round(input.count)))
      }
      args.push('--wait', String(waitImage), '--out', withSeparator(input.outDir ?? outDir), '-j')
      const answered = await call(args, (waitImage + 60) * 1000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = answered.envelope?.data
      const files = collectMediaPaths(data)
      const running = typeof (data as Record<string, unknown> | undefined)?.status === 'string' && String((data as Record<string, unknown>).status) === 'running'
      if (files.length === 0) {
        return {
          ok: false,
          ...(running ? { message: `即梦还在生成，没到时间；稍后用同一任务再查（thread/run 见返回）：${JSON.stringify(data ?? {}).slice(0, 200)}` } : { message: '即梦返回里没有产物文件路径' }),
        }
      }
      return { ok: true, files }
    },

    async generateVideo(input: ChannelVideoInput): Promise<ChannelGenerateResult> {
      const ready = await ensureAvailable()
      if ('message' in ready) return { ok: false, message: ready.message }
      const model = (input.model ?? deps.defaultVideoModel ?? '').trim()
      if (model === '') {
        return { ok: false, message: '没指定即梦视频模型。先用「jimeng-novel model list --type video」查模型 key（例如 seedance_2.0），再传 model。' }
      }
      if (input.prompt.trim() === '') return { ok: false, message: '需要 prompt（用户原始描述）' }
      const args = [ready.cli, 'generate-video', '--model', model, '--prompt', input.prompt]
      if (typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration > 0) {
        args.push('--duration', String(Math.round(input.duration)))
      }
      for (const image of input.images ?? []) if (image !== '') args.push('--image', image)
      if (typeof input.ratio === 'string' && input.ratio !== '') args.push('--ratio', input.ratio)
      args.push('--wait', String(waitVideo), '--out', withSeparator(input.outDir ?? outDir), '-j')
      const answered = await call(args, (waitVideo + 60) * 1000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = answered.envelope?.data
      const files = collectMediaPaths(data)
      if (files.length === 0) {
        const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
        const tid = typeof record.thread_id === 'string' ? record.thread_id : ''
        const rid = typeof record.run_id === 'string' ? record.run_id : ''
        return {
          ok: false,
          message:
            record.status === 'running'
              ? `即梦还在出片（thread/run：${tid} / ${rid}），到这轮没等到；稍后用同一任务再查，别重新提交`
              : '即梦返回里没有产物文件路径',
        }
      }
      return { ok: true, files }
    },

    async balance(): Promise<ChannelBalanceResult> {
      const ready = await ensureAvailable()
      if ('message' in ready) return { ok: false, message: ready.message }
      const answered = await call([ready.cli, 'credit', 'get', '-j'], 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const value = pickNumber(answered.envelope?.data, ['balance', 'credits', 'total', 'remain'])
      if (value === undefined) return { ok: false, message: '即梦没有返回积分余额字段' }
      return { ok: true, totalRemain: String(value) }
    },

    async models(kind: 'video' | 'image'): Promise<ChannelModelsResult> {
      const ready = await ensureAvailable()
      if ('message' in ready) return { ok: false, message: ready.message }
      const answered = await call([ready.cli, 'model', 'list', '--type', kind, '-j'], 90_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = answered.envelope?.data
      const items = Array.isArray((data as Record<string, unknown> | undefined)?.items)
        ? ((data as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : Array.isArray(data)
          ? (data as Array<Record<string, unknown>>)
          : []
      const models: Array<{ key: string; name: string }> = []
      for (const item of items) {
        const key = typeof item.key === 'string' && item.key !== '' ? item.key : typeof item.name === 'string' ? item.name : ''
        if (key === '') continue
        models.push({ key, name: typeof item.name === 'string' && item.name !== '' ? item.name : key })
      }
      if (models.length === 0) return { ok: false, message: '即梦没有返回可用模型列表' }
      return { ok: true, models }
    },
  }
}
