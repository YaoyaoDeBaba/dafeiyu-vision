/**
 * xyq/service — 小云雀能力的宿主侧实现：配置、鉴权探测、生成、轮询、预算。
 *
 * 所有命令都通过官方 CLI（`pippit-tool-cli`）执行；本文件**不拼 HTTP**，
 * 这样鉴权/上传/字段映射的改动只需升级 CLI，插件代码不动。
 *
 * 返回约定：`{ ok: true, ... }` 或 `{ ok: false, message }`——message 是**给人看的中文**，
 * 工具层直接把它回给模型/用户，不吞错误。
 */
import type { CliRunner, CliRunResult } from './cli.js'
import { locateXyqCli } from './cli.js'
import { createXyqSelfHealer, type XyqSelfHealer } from './selfheal.js'
import { readXyqConfig, viewXyqConfig, writeXyqConfig, type XyqConfig } from './config.js'
import {
  XYQ_CHANNEL_LABELS,
  unavailableMessage,
  type ChannelGenerateResult,
  type ChannelId,
  type ChannelPreflight,
  type ChannelPreflightOptions,
  type ChannelProbe,
  type GenerationChannel,
} from './channel.js'

export interface XyqServiceDeps {
  configFile: string
  run: CliRunner
  resolveCli: () => Promise<string | undefined>
  /**
   * 除云雀之外的生成通道（当前只有即梦）。
   * 缺省 = 只有云雀，老行为逐字不变；传了也不会影响默认调用（channel 默认 'xyq'）。
   */
  channels?: Partial<Record<ChannelId, GenerationChannel>>
  /**
   * **纯定位** pippit-tool-cli（不装）。自愈的第一步用它；不传就现场 locateXyqCli()。
   * 见 ./cli.ts 的 locateXyqCli：env → 官方 skill 缓存 → PATH。
   */
  locateCli?: () => string | undefined
  /** 测试注入：换掉云雀侧自愈器。 */
  xyqHealer?: XyqSelfHealer
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  videoTimeoutMs?: number
  imageTimeoutMs?: number
  now?: () => number
}

export interface XyqGenerateResult {
  ok: boolean
  message?: string
  threadId?: string
  runId?: string
  files?: string[]
  webLink?: string
  creditsUsed?: number
}

type Json = Record<string, unknown>

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    /* 有些命令会混着打印提示行：取最后一行 JSON */
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]!)
      } catch {
        /* 继续 */
      }
    }
    return undefined
  }
}

/** CLI 的鉴权失败 → 一句用户能照做的中文。 */
function authMessage(text: string): string | undefined {
  if (/登录凭证|XYQ_ACCESS_KEY|未授权|unauthorized|401|403/i.test(text)) {
    return '小云雀 Access Key 已过期或无效。请到小云雀官网 → ⚡CLI/API → API → 管理 Access Key 更新后，在「大肥鱼 → 鲸鱼做梦」里重新填写。'
  }
  return undefined
}

interface SessionBudget {
  images: number
  videos: number
}

export function createXyqService(deps: XyqServiceDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const pollInterval = deps.pollIntervalMs ?? 5_000
  const videoTimeout = deps.videoTimeoutMs ?? 15 * 60_000
  const imageTimeout = deps.imageTimeoutMs ?? 6 * 60_000
  const budgets = new Map<string, SessionBudget>()

  const readConfig = (): XyqConfig => readXyqConfig(deps.configFile)

  function budgetOf(sessionKey: string): SessionBudget {
    const current = budgets.get(sessionKey)
    if (current) return current
    const fresh: SessionBudget = { images: 0, videos: 0 }
    budgets.set(sessionKey, fresh)
    return fresh
  }

  async function call(args: string[], timeoutMs: number): Promise<{ result: CliRunResult; json?: Json; message?: string }> {
    const config = readConfig()
    if (!config.enabled) return { result: { code: -1, stdout: '', stderr: '', timedOut: false }, message: '小云雀能力已关闭（设置页 → 大肥鱼 → 鲸鱼做梦）' }
    if (config.accessKey === '') {
      return {
        result: { code: -1, stdout: '', stderr: '', timedOut: false },
        message: '还没填小云雀 Access Key。请到小云雀官网 → ⚡CLI/API → API → 管理 Access Key 新建，然后填到「大肥鱼 → 鲸鱼做梦」里。',
      }
    }
    const cli = await deps.resolveCli()
    if (cli === undefined) {
      return {
        result: { code: -1, stdout: '', stderr: '', timedOut: false },
        message: '没找到 pippit-tool-cli，自动安装也失败了。请先在终端运行 `npx @pippit-dev/cli@latest install`，再重试。',
      }
    }
    const result = await deps.run([cli, ...args], { env: { XYQ_ACCESS_KEY: config.accessKey }, timeoutMs })
    const combined = `${result.stdout}\n${result.stderr}`
    const auth = authMessage(combined)
    if (auth !== undefined) return { result, message: auth }
    const modelMissing = combined.match(/未找到可用模型[^\n]*/)
    if (modelMissing) return { result, message: modelMissing[0].trim() }
    const json = parseJson(result.stdout) as Json | undefined
    if (result.timedOut) return { result, message: `小云雀命令超时（${Math.round(timeoutMs / 1000)} 秒）` }
    if (json === undefined) {
      const reason = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim()
      return { result, message: reason !== '' ? `小云雀返回了无法解析的内容：${reason.slice(0, 200)}` : '小云雀没有返回内容' }
    }
    return { result, json }
  }

  async function poll(threadId: string, runId: string, outDir: string, timeoutMs: number): Promise<{ ok: boolean; files: string[]; status?: string; message?: string }> {
    const started = (deps.now ?? Date.now)()
    for (;;) {
      const answered = await call(
        ['query-result', '--thread-id', threadId, '--run-id', runId, '--download-dir', outDir],
        Math.max(30_000, timeoutMs),
      )
      if (answered.message !== undefined) return { ok: false, files: [], message: answered.message }
      const json = answered.json ?? {}
      const status = typeof json.status === 'string' ? json.status : 'unknown'
      if (json.error_message !== undefined && String(json.error_message).trim() !== '') {
        return { ok: false, files: [], status, message: `小云雀任务失败：${String(json.error_message).slice(0, 200)}` }
      }
      if (status === 'succeeded') {
        const files: string[] = []
        for (const key of ['videos', 'images'] as const) {
          const list = Array.isArray(json[key]) ? (json[key] as Array<Record<string, unknown>>) : []
          for (const item of list) {
            if (typeof item.output_path === 'string' && item.output_path !== '') files.push(item.output_path)
          }
        }
        return { ok: true, files, status }
      }
      if (status === 'failed' || status === 'canceled' || status === 'interrupted') {
        return { ok: false, files: [], status, message: `小云雀任务${status === 'canceled' ? '被取消' : '失败'}了` }
      }
      if ((deps.now ?? Date.now)() - started > timeoutMs) {
        return { ok: false, files: [], status, message: `等小云雀出片超时（${Math.round(timeoutMs / 60_000)} 分钟），任务还在跑；稍后可以用 thread_id/run_id 继续查：${threadId} / ${runId}` }
      }
      await sleep(pollInterval)
    }
  }

  /** 通道结果 → 云雀那套返回形状（工具层只认一种）。 */
  function fromChannel(result: ChannelGenerateResult): XyqGenerateResult {
    return {
      ok: result.ok,
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.files === undefined ? {} : { files: result.files }),
      ...(result.webLink === undefined ? {} : { webLink: result.webLink }),
    }
  }

  /**
   * 取出某个通道；云雀自己不用在这里找（它就是这个 service）。
   * 不可用时给出**中文原因 + 下一步命令**，绝不静默回落到云雀。
   */
  async function pickChannel(id: ChannelId): Promise<{ channel?: GenerationChannel; message?: string }> {
    if (id === 'xyq') return {}
    const channel = deps.channels?.[id]
    if (channel === undefined) return { message: `没有接入「${XYQ_CHANNEL_LABELS[id] ?? id}」通道（只挂了云雀）` }
    const status = await channel.probe()
    if (!status.available) return { message: unavailableMessage(status) }
    return { channel }
  }

  // 云雀侧自愈器：装 CLI 只在这里发生，且**默认不装**（显式 autoInstall:true 才动）。
  const healer =
    deps.xyqHealer ??
    createXyqSelfHealer({
      run: deps.run,
      log: deps.log,
      locate: deps.locateCli ?? ((): string | undefined => locateXyqCli()),
    })

  /**
   * 云雀侧的「调用前自愈」三步（顺序固定）：CLI 在不在 → 授权/凭据在不在 → 凭据有没有效。
   * 云雀用的是 Access Key（不是浏览器授权），所以第 2、3 步都落在 key 上；自动安装交给
   * `resolveCli`（它内部会跑官方 ensure-cli），失败再给手工命令。
   */
  async function preflightXyq(options: ChannelPreflightOptions): Promise<ChannelPreflight> {
    const config = readConfig()
    if (!config.enabled) {
      return { ok: false, message: '小云雀能力已关闭（设置页 → 大肥鱼 → 鲸鱼做梦）。要用就先把开关打开。' }
    }
    // 第一步：CLI 在不在。**默认只报错**——只有显式 autoInstall:true 才跑 npx 装。
    // 定位用纯查询（locateCli），不是会顺手装一遍的 resolveCli：装不装必须由调用方决定。
    const locateCli = deps.locateCli ?? ((): string | undefined => locateXyqCli())
    const present = deps.locateCli !== undefined ? locateCli() : await deps.resolveCli()
    if (present === undefined) {
      const ensured = await healer.ensureCli(options.autoInstall === true)
      if (!ensured.ok) return { ok: false, message: ensured.message ?? '没找到 pippit-tool-cli' }
    }
    if (config.accessKey === '') {
      return {
        ok: false,
        message: [
          '小云雀还没填 Access Key。任选一处填（三处等价）：',
          '① 设置页 →「大肥鱼 → 鲸鱼做梦」→ Access Key 一栏；',
          `② 或直接改配置文件 ${deps.configFile} 的 accessKey 字段（改完重启宿主）；`,
          '③ 或设环境变量 XYQ_ACCESS_KEY（插件就是把它作为环境变量交给 CLI 的）。',
          'Key 在小云雀官网 → ⚡CLI/API → API → 管理 Access Key 里建。',
        ].join('\n'),
      }
    }
    // 第三步：key 到底有没有效（读不出来就放行——不能因为读不出就把人拦在门外）
    const answered = await call(['status'], 20_000)
    if (answered.message !== undefined) return { ok: true }
    const json = answered.json ?? {}
    if (json.logged_in === false) {
      return {
        ok: false,
        message: [
          '小云雀 Access Key 没生效（过期或无效）。',
          '去小云雀官网 → ⚡CLI/API → API → 管理 Access Key 更新，然后填到设置页「大肥鱼 → 鲸鱼做梦」，',
          `或改配置文件 ${deps.configFile} 的 accessKey，或设环境变量 XYQ_ACCESS_KEY。`,
        ].join(''),
        needsUser: true,
      }
    }
    return { ok: true }
  }

  /** 通道自愈：即梦那种实现可选；抛错也算「不可用」，绝不带崩调用方。 */
  async function healChannel(channel: GenerationChannel, options: ChannelPreflightOptions): Promise<ChannelPreflight> {
    if (typeof channel.preflight !== 'function') return { ok: true }
    try {
      return await channel.preflight(options)
    } catch (error) {
      return { ok: false, message: `通道自愈时出错：${String((error as Error)?.message ?? error).slice(0, 200)}` }
    }
  }

  /** 统一入口：先自愈再干活（默认通道 xyq 也在里面，老调用照样过这一关）。 */
  async function readyFor(id: ChannelId, options: ChannelPreflightOptions): Promise<ChannelPreflight> {
    if (id === 'xyq') return preflightXyq(options)
    // 注意：这里**不走 pickChannel**——它按 probe 判可用，会把「没装」直接拦掉，
    // 而自愈的本职恰恰是「没装就装」。通道存在就先让它自愈，装完 probe 自然通过。
    const channel = deps.channels?.[id]
    if (channel === undefined) {
      return { ok: false, message: `没有接入「${XYQ_CHANNEL_LABELS[id] ?? id}」通道（只挂了云雀）` }
    }
    return healChannel(channel, options)
  }

  return {
    config: readConfig,
    view: () => viewXyqConfig(readConfig()),
    update: (patch: unknown) => viewXyqConfig(writeXyqConfig(deps.configFile, patch)),

    async status(): Promise<{ ok: boolean; loggedIn?: boolean; source?: string; message?: string }> {
      const answered = await call(['status'], 30_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const json = answered.json ?? {}
      return {
        ok: true,
        loggedIn: json.logged_in === true,
        source: typeof json.source === 'string' ? json.source : '',
        ...(json.logged_in === true ? {} : { message: 'Access Key 未生效，请检查是否过期' }),
      }
    },

    /**
     * 事前报价（0.10.0）：只问价、不生成、不扣费。
     * 小云雀通道没有报价接口（如实说），即梦通道包 `credit estimate`。
     */
    async estimate(input: {
      channel: ChannelId
      type: 'image' | 'video'
      model: string
      duration?: number
    }): Promise<{ ok: boolean; credits?: number; billedAmount?: number; billedUnit?: string; modelId?: string; message?: string }> {
      if (input.channel === 'xyq') {
        return { ok: false, message: '小云雀通道没有事前报价接口（只回余额与预算上限）。要事前报价请用 channel="jimeng"。' }
      }
      const channel = deps.channels?.[input.channel]
      if (channel === undefined) {
        return { ok: false, message: `没有接入「${XYQ_CHANNEL_LABELS[input.channel] ?? input.channel}」通道` }
      }
      if (typeof channel.estimate !== 'function') {
        return { ok: false, message: `「${XYQ_CHANNEL_LABELS[input.channel] ?? input.channel}」通道这个版本不支持事前报价` }
      }
      const result = await channel.estimate({
        type: input.type,
        model: input.model,
        ...(input.duration === undefined ? {} : { duration: input.duration }),
      })
      return {
        ok: result.ok,
        ...(result.credits === undefined ? {} : { credits: result.credits }),
        ...(result.billedAmount === undefined ? {} : { billedAmount: result.billedAmount }),
        ...(result.billedUnit === undefined ? {} : { billedUnit: result.billedUnit }),
        ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        ...(result.message === undefined ? {} : { message: result.message }),
      }
    },
    async balance(
      channel: ChannelId = 'xyq',
      options: ChannelPreflightOptions = {},
    ): Promise<{ ok: boolean; totalRemain?: string; message?: string }> {
      const healed = await readyFor(channel, options)
      if (!healed.ok) return { ok: false, message: healed.message }
      if (channel !== 'xyq') {
        const picked = await pickChannel(channel)
        if (picked.channel === undefined) return { ok: false, message: picked.message ?? '通道不可用' }
        return picked.channel.balance()
      }
      const answered = await call(['get-credit-balance'], 30_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const json = answered.json ?? {}
      return { ok: true, totalRemain: typeof json.total_remain_amount === 'string' ? json.total_remain_amount : String(json.total_remain_amount ?? '') }
    },

    async models(
      kind: 'video' | 'image',
      channel: ChannelId = 'xyq',
      options: ChannelPreflightOptions = {},
    ): Promise<{ ok: boolean; models?: Array<{ key: string; name: string }>; message?: string }> {
      const healed = await readyFor(channel, options)
      if (!healed.ok) return { ok: false, message: healed.message }
      if (channel !== 'xyq') {
        const picked = await pickChannel(channel)
        if (picked.channel === undefined) return { ok: false, message: picked.message ?? '通道不可用' }
        return picked.channel.models(kind)
      }
      const answered = await call(['model', 'list', '--type', kind], 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const json = answered.json ?? {}
      const list = Array.isArray(json.models) ? (json.models as Array<Record<string, unknown>>) : []
      return {
        ok: true,
        models: list
          .filter((row) => typeof row.name === 'string' && String(row.name).trim() !== '')
          .map((row) => ({
            // 生图模型只有 name（CLI 就用完整名称）；生视频模型有 key（提交要用 key）。
            key: typeof row.key === 'string' && row.key !== '' ? String(row.key) : String(row.name),
            name: String(row.name),
          })),
      }
    },

    /** 通道探测：只看「装没装」（登录态在真正调用时才查，探测不许拖慢启动）。 */
    async channelProbes(): Promise<ChannelProbe[]> {
      const rows: ChannelProbe[] = []
      for (const id of ['xyq', 'jimeng'] as const) {
        if (id === 'xyq') {
          const cli = await deps.resolveCli()
          rows.push(
            cli === undefined
              ? {
                  id,
                  label: XYQ_CHANNEL_LABELS[id],
                  available: false,
                  reason: '没找到 pippit-tool-cli',
                  hint: '在终端跑「npx @pippit-dev/cli@latest install」',
                }
              : { id, label: XYQ_CHANNEL_LABELS[id], available: true, cliPath: cli },
          )
          continue
        }
        const channel = deps.channels?.[id]
        if (channel === undefined) {
          rows.push({ id, label: XYQ_CHANNEL_LABELS[id], available: false, reason: '没有接入这条通道' })
          continue
        }
        rows.push(await channel.probe())
      }
      return rows
    },

    /** 余额工具用：两条通道各报一段（一条不可用不影响另一条；同样先过自愈）。 */
    async balanceAll(options: ChannelPreflightOptions = {}): Promise<
      Array<{ id: ChannelId; label: string; ok: boolean; totalRemain?: string; message?: string }>
    > {
      const rows: Array<{ id: ChannelId; label: string; ok: boolean; totalRemain?: string; message?: string }> = []
      const xyqReady = await readyFor('xyq', options)
      if (!xyqReady.ok) {
        rows.push({ id: 'xyq', label: XYQ_CHANNEL_LABELS.xyq, ok: false, message: xyqReady.message })
      } else {
        const xyqAnswer = await call(['get-credit-balance'], 30_000)
        if (xyqAnswer.message !== undefined) {
          rows.push({ id: 'xyq', label: XYQ_CHANNEL_LABELS.xyq, ok: false, message: xyqAnswer.message })
        } else {
          const json = xyqAnswer.json ?? {}
          rows.push({
            id: 'xyq',
            label: XYQ_CHANNEL_LABELS.xyq,
            ok: true,
            totalRemain: typeof json.total_remain_amount === 'string' ? json.total_remain_amount : String(json.total_remain_amount ?? ''),
          })
        }
      }
      const jimengReady = await readyFor('jimeng', options)
      if (!jimengReady.ok) {
        rows.push({ id: 'jimeng', label: XYQ_CHANNEL_LABELS.jimeng, ok: false, message: jimengReady.message })
      } else {
        const picked = await pickChannel('jimeng')
        if (picked.channel === undefined) {
          rows.push({ id: 'jimeng', label: XYQ_CHANNEL_LABELS.jimeng, ok: false, message: picked.message ?? '通道不可用' })
        } else {
          const result = await picked.channel.balance()
          rows.push({
            id: 'jimeng',
            label: XYQ_CHANNEL_LABELS.jimeng,
            ok: result.ok,
            ...(result.totalRemain === undefined ? {} : { totalRemain: result.totalRemain }),
            ...(result.message === undefined ? {} : { message: result.message }),
          })
        }
      }
      return rows
    },

    async generateImage(input: {
      prompt: string
      model?: string
      images?: string[]
      ratio?: string
      count?: number
      outDir?: string
      sessionKey?: string
      /** 生成通道：缺省/xyq = 小云雀（老行为），jimeng = 即梦。 */
      channel?: ChannelId
      /** 缺 CLI 时自动装（默认 true）；false = 只报告 + 手工命令。 */
      autoInstall?: boolean
      /** 未登录时自动发起授权（默认 true）；false = 只报告。 */
      autoLogin?: boolean
    }): Promise<XyqGenerateResult> {
      const requested = input.channel ?? 'xyq'
      const healed = await readyFor(requested, { autoInstall: input.autoInstall ?? false, autoLogin: input.autoLogin ?? true })
      if (!healed.ok) return { ok: false, message: healed.message }
      if (requested !== 'xyq') {
        const picked = await pickChannel(requested)
        if (picked.channel === undefined) return { ok: false, message: picked.message ?? '通道不可用' }
        return fromChannel(
          await picked.channel.generateImage({
            prompt: input.prompt,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.images === undefined ? {} : { images: input.images }),
            ...(input.ratio === undefined ? {} : { ratio: input.ratio }),
            ...(input.count === undefined ? {} : { count: input.count }),
            ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
          }),
        )
      }
      const config = readConfig()
      const sessionKey = input.sessionKey ?? 'default'
      const budget = budgetOf(sessionKey)
      if (config.budget.images > 0 && budget.images >= config.budget.images) {
        return { ok: false, message: `本会话的生图额度已用完（上限 ${config.budget.images} 张，可在「大肥鱼 → 鲸鱼做梦」里调整）` }
      }
      const model = (input.model ?? config.defaultImageModel).trim()
      if (model === '') {
        return { ok: false, message: '没指定图片模型。先用 `model list --type image` 查可用模型，或在「大肥鱼 → 鲸鱼做梦」里设默认图片模型。' }
      }
      const args = ['generate-image', '--prompt', input.prompt, '--model', model]
      for (const image of input.images ?? []) {
        if (typeof image === 'string' && image !== '') args.push('--image', image)
      }
      if (typeof input.ratio === 'string' && input.ratio !== '') args.push('--ratio', input.ratio)
      if (typeof input.count === 'number' && Number.isFinite(input.count) && input.count > 0) args.push('--generate-image-count', String(Math.round(input.count)))
      const submitted = await call(args, 120_000)
      if (submitted.message !== undefined) return { ok: false, message: submitted.message }
      const json = submitted.json ?? {}
      const threadId = typeof json.thread_id === 'string' ? json.thread_id : ''
      const runId = typeof json.run_id === 'string' ? json.run_id : ''
      if (threadId === '' || runId === '') return { ok: false, message: '小云雀没有返回 thread_id / run_id，生成未提交成功' }
      budget.images += 1
      const outDir = input.outDir ?? 'xyq_output'
      const polled = await poll(threadId, runId, outDir, imageTimeout)
      return {
        ok: polled.ok,
        ...(polled.ok ? {} : { message: polled.message }),
        threadId,
        runId,
        files: polled.files,
        ...(typeof json.web_thread_link === 'string' ? { webLink: json.web_thread_link } : {}),
      }
    },

    /** UI 用：只提交生图任务，返回 thread/run（结果由 queryOnce 轮询）。 */
    async startImage(input: {
      prompt: string
      model: string
      images?: string[]
      ratio?: string
      resolution?: string
      count?: number
      sessionKey?: string
    }): Promise<{ ok: boolean; threadId?: string; runId?: string; webLink?: string; message?: string }> {
      const config = readConfig()
      const budget = budgetOf(input.sessionKey ?? 'default')
      if (config.budget.images > 0 && budget.images >= config.budget.images) {
        return { ok: false, message: `本会话的生图额度已用完（上限 ${config.budget.images} 张）` }
      }
      if (input.model.trim() === '') return { ok: false, message: '没指定图片模型' }
      const args = ['generate-image', '--prompt', input.prompt, '--model', input.model]
      for (const image of input.images ?? []) if (image !== '') args.push('--image', image)
      if (typeof input.ratio === 'string' && input.ratio !== '') args.push('--ratio', input.ratio)
      if (typeof input.resolution === 'string' && input.resolution !== '') args.push('--resolution', input.resolution)
      if (typeof input.count === 'number' && input.count > 0) args.push('--generate-image-count', String(Math.round(input.count)))
      const submitted = await call(args, 120_000)
      if (submitted.message !== undefined) return { ok: false, message: submitted.message }
      const json = submitted.json ?? {}
      const threadId = typeof json.thread_id === 'string' ? json.thread_id : ''
      const runId = typeof json.run_id === 'string' ? json.run_id : ''
      if (threadId === '' || runId === '') return { ok: false, message: '小云雀没有返回 thread_id / run_id' }
      budget.images += 1
      return { ok: true, threadId, runId, ...(typeof json.web_thread_link === 'string' ? { webLink: json.web_thread_link } : {}) }
    },

    /** UI 用：只提交生视频任务。 */
    async startVideo(input: {
      prompt: string
      model: string
      duration?: number
      ratio?: string
      resolution?: string
      images?: string[]
      sessionKey?: string
    }): Promise<{ ok: boolean; threadId?: string; runId?: string; webLink?: string; message?: string }> {
      const config = readConfig()
      const budget = budgetOf(input.sessionKey ?? 'default')
      if (config.budget.videos > 0 && budget.videos >= config.budget.videos) {
        return { ok: false, message: `本会话的视频额度已用完（上限 ${config.budget.videos} 条）` }
      }
      if (input.model.trim() === '') return { ok: false, message: '没指定视频模型' }
      const duration = Math.min(config.budget.maxVideoSeconds, Math.max(4, Math.round(input.duration ?? config.defaultVideoDurationSec)))
      const args = ['generate-video', '--model', input.model, '--prompt', input.prompt, '--duration', String(duration)]
      for (const image of input.images ?? []) if (image !== '') args.push('--image', image)
      if (typeof input.ratio === 'string' && input.ratio !== '' && input.ratio !== 'adaptive') args.push('--ratio', input.ratio)
      if (typeof input.resolution === 'string' && input.resolution !== '') args.push('--resolution', input.resolution)
      args.push('--task-type', 'reference')
      const submitted = await call(args, 180_000)
      if (submitted.message !== undefined) return { ok: false, message: submitted.message }
      const json = submitted.json ?? {}
      const threadId = typeof json.thread_id === 'string' ? json.thread_id : ''
      const runId = typeof json.run_id === 'string' ? json.run_id : ''
      if (threadId === '' || runId === '') return { ok: false, message: '小云雀没有返回 thread_id / run_id' }
      budget.videos += 1
      return { ok: true, threadId, runId, ...(typeof json.web_thread_link === 'string' ? { webLink: json.web_thread_link } : {}) }
    },

    /** UI 用：查一次任务状态（不轮询、不阻塞）。 */
    async queryOnce(threadId: string, runId: string, outDir: string): Promise<{
      ok: boolean
      status?: string
      files?: string[]
      message?: string
    }> {
      const answered = await call(
        ['query-result', '--thread-id', threadId, '--run-id', runId, '--download-dir', outDir],
        120_000,
      )
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const json = answered.json ?? {}
      const status = typeof json.status === 'string' ? json.status : 'unknown'
      if (typeof json.error_message === 'string' && json.error_message !== '') {
        return { ok: false, status, message: `小云雀任务失败：${json.error_message.slice(0, 200)}` }
      }
      if (status !== 'succeeded') return { ok: true, status }
      const files: string[] = []
      for (const key of ['videos', 'images'] as const) {
        const list = Array.isArray(json[key]) ? (json[key] as Array<Record<string, unknown>>) : []
        for (const item of list) {
          if (typeof item.output_path === 'string' && item.output_path !== '') files.push(item.output_path)
        }
      }
      return { ok: true, status, files }
    },

    /** 模型详情（比例/分辨率/时长等），给设置面板的下拉框用。 */
    async describe(name: string, kind: 'video' | 'image'): Promise<{ ok: boolean; model?: Record<string, unknown>; message?: string }> {
      const answered = await call(['model', 'describe', name, '--type', kind], 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const json = answered.json ?? {}
      const model = json.model && typeof json.model === 'object' ? (json.model as Record<string, unknown>) : undefined
      if (model === undefined) return { ok: false, message: '没有拿到模型详情' }
      return { ok: true, model }
    },

    async generateVideo(input: {
      prompt: string
      model?: string
      duration?: number
      ratio?: string
      images?: string[]
      outDir?: string
      sessionKey?: string
      /** 生成通道：缺省/xyq = 小云雀（老行为），jimeng = 即梦。 */
      channel?: ChannelId
      /** 缺 CLI 时自动装（默认 true）。 */
      autoInstall?: boolean
      /** 未登录时自动发起授权（默认 true）。 */
      autoLogin?: boolean
    }): Promise<XyqGenerateResult> {
      const requested = input.channel ?? 'xyq'
      const healed = await readyFor(requested, { autoInstall: input.autoInstall ?? false, autoLogin: input.autoLogin ?? true })
      if (!healed.ok) return { ok: false, message: healed.message }
      if (requested !== 'xyq') {
        const picked = await pickChannel(requested)
        if (picked.channel === undefined) return { ok: false, message: picked.message ?? '通道不可用' }
        return fromChannel(
          await picked.channel.generateVideo({
            prompt: input.prompt,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.duration === undefined ? {} : { duration: input.duration }),
            ...(input.ratio === undefined ? {} : { ratio: input.ratio }),
            ...(input.images === undefined ? {} : { images: input.images }),
            ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
          }),
        )
      }
      const config = readConfig()
      const sessionKey = input.sessionKey ?? 'default'
      const budget = budgetOf(sessionKey)
      if (config.budget.videos > 0 && budget.videos >= config.budget.videos) {
        return { ok: false, message: `本会话的视频额度已用完（上限 ${config.budget.videos} 条，可在「大肥鱼 → 鲸鱼做梦」里调整）` }
      }
      const model = (input.model ?? config.defaultVideoModel).trim()
      if (model === '') return { ok: false, message: '没指定视频模型（默认 Seedance_2.0_mini_lite，可在设置里改）' }
      const duration = Math.min(config.budget.maxVideoSeconds, Math.max(4, Math.round(input.duration ?? config.defaultVideoDurationSec)))
      const args = ['generate-video', '--model', model, '--prompt', input.prompt, '--duration', String(duration)]
      for (const image of input.images ?? []) {
        if (typeof image === 'string' && image !== '') args.push('--image', image)
      }
      if (typeof input.ratio === 'string' && input.ratio !== '') args.push('--ratio', input.ratio)
      args.push('--task-type', 'reference')
      const submitted = await call(args, 180_000)
      if (submitted.message !== undefined) return { ok: false, message: submitted.message }
      const json = submitted.json ?? {}
      const threadId = typeof json.thread_id === 'string' ? json.thread_id : ''
      const runId = typeof json.run_id === 'string' ? json.run_id : ''
      if (threadId === '' || runId === '') return { ok: false, message: '小云雀没有返回 thread_id / run_id，生成未提交成功' }
      budget.videos += 1
      const outDir = input.outDir ?? 'xyq_output'
      const polled = await poll(threadId, runId, outDir, videoTimeout)
      return {
        ok: polled.ok,
        ...(polled.ok ? {} : { message: polled.message }),
        threadId,
        runId,
        files: polled.files,
        ...(typeof json.web_thread_link === 'string' ? { webLink: json.web_thread_link } : {}),
      }
    },
  }
}

export type XyqService = ReturnType<typeof createXyqService>
