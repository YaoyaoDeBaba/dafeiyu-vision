/**
 * xyq/tools — 给模型的三个工具：生图 / 生视频 / 查余额（外加查模型）。
 *
 * 纪律：
 * - 失败一律抛出带中文原因的错（模型会把这句话转述给用户），不静默；
 * - 成功时把**本地文件绝对路径**放进输出，模型能直接引用/展示；
 * - 额度/Key 的判定在 service 里，工具层只负责形状与文案。
 */
import type { XyqService } from './service.js'
import { channelParamError, normalizeChannelId, XYQ_CHANNEL_IDS } from './channel.js'
import { XYQ_GUIDE_FALLBACK } from './skill.js'

const CHANNEL_ENUM = [...XYQ_CHANNEL_IDS]

export interface XyqToolsDeps {
  /** 指南正文（读 skill 的 SKILL.md，单一真源）；不传就用内置短版。 */
  guideBody?: () => string
}

/** 认不出的参数键要显形（契约：不许静默吞掉）。 */
function ignoredKeys(args: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(args ?? {}).filter((key) => !known.includes(key))
}

/** 把「忽略未知参数」补到结果末尾（没有就原样返回）。 */
function withIgnored(text: string, ignored: string[]): string {
  return ignored.length === 0 ? text : `${text}\n（忽略未知参数：${ignored.join(', ')}）`
}

/**
 * 工具入参里的 channel → ChannelId；传了不认识的**当场抛中文**（不静默回落到云雀）。
 * 缺省/空串 = 'xyq'：老调用一个字都不用改。
 */
function channelOf(args: Record<string, unknown>): 'xyq' | 'jimeng' {
  const channel = normalizeChannelId(args.channel)
  if (channel === undefined) throw new Error(channelParamError(args.channel))
  return channel
}

/**
 * 自愈开关：**自动安装默认关（opt-in）**、**自动发起授权默认开**。
 *
 * 为什么装默认关（2026-11-25 定）：自动安装 = 在用户机器上下载并执行远端 PowerShell 脚本，
 * 一句「画只鲸鱼」不该顺带装软件；缺 CLI 时报错里会明确写「再调一次并传 autoInstall:true」。
 * 自动授权只是发一个 device-code 链接给用户点，没有执行副作用，所以默认开（传 false 可关）。
 */
function selfHealOf(args: Record<string, unknown>): { autoInstall: boolean; autoLogin: boolean } {
  const off = (value: unknown): boolean => value === false || value === 'false'
  const on = (value: unknown): boolean => value === true || value === 'true'
  return { autoInstall: on(args.autoInstall), autoLogin: !off(args.autoLogin) }
}

const SELF_HEAL_PARAMS = {
  autoInstall: { type: 'boolean', description: '缺 CLI 时是否自动下载并安装（默认 false，不自动执行远端脚本）；缺 CLI 时传 true 让插件装一次' },
  autoLogin: { type: 'boolean', description: '未登录时是否自动发起授权（默认 true）；传 false 只报告' },
}

function sessionKeyOf(exec: unknown): string {
  const record = exec && typeof exec === 'object' ? (exec as Record<string, unknown>) : undefined
  const agent = record?.agent && typeof record.agent === 'object' ? (record.agent as Record<string, unknown>) : undefined
  const session = agent?.session && typeof agent.session === 'object' ? (agent.session as Record<string, unknown>) : undefined
  const id = session?.id ?? record?.sessionId ?? record?.session
  return typeof id === 'string' && id !== '' ? id : 'default'
}

function resultText(result: { ok: boolean; files?: string[]; webLink?: string; message?: string; threadId?: string }): string {
  if (!result.ok) return `生成失败：${result.message ?? '未知原因'}`
  const files = result.files ?? []
  const lines = [`生成完成，${files.length} 个文件：`, ...files.map((file) => `- ${file}`)]
  if (result.webLink !== undefined) lines.push(`在线查看：${result.webLink}`)
  if (result.threadId !== undefined) lines.push(`任务：${result.threadId}`)
  return lines.join('\n')
}

export function xyqTools(service: XyqService, deps: XyqToolsDeps = {}): Array<Record<string, unknown>> {
  return [
    {
      name: 'generate_image',
      description:
        '生成/编辑图片。prompt 必须是用户原始描述；可传参考图（本地绝对路径）。按张消耗积分。' +
        '用户没有明确要求画图时不要调用。' +
        '通道：channel=xyq（默认，小云雀，营销成片/短剧 agent 全流程）或 channel=jimeng（即梦，画布/短剧 CLI）。' +
        '即梦通道需要本机已装即梦 CLI 且在浏览器里授权过；不可用时工具会报中文原因与下一步命令。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片描述（用户原话，不要扩写）' },
          model: { type: 'string', description: '图片模型完整名称（先用 xyq_models 查 image 列表）；不传则用设置里的默认值' },
          images: { type: 'array', items: { type: 'string' }, description: '参考图本地绝对路径，可多张' },
          ratio: { type: 'string', description: '比例（模型返回的数字枚举，如 3 表示 9:16）' },
          count: { type: 'number', description: '生成数量（可选）' },
          outDir: { type: 'string', description: '下载目录；默认 xyq_output' },
          channel: { type: 'string', enum: CHANNEL_ENUM, description: '生成通道：xyq=小云雀（默认），jimeng=即梦' },
          ...SELF_HEAL_PARAMS,
        },
        required: ['prompt'],
      },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 15 * 60_000,
      async execute(args: Record<string, unknown>, exec: unknown): Promise<string> {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('需要 prompt（用户原始描述）')
        const channel = channelOf(args)
        const ignored = ignoredKeys(args, ['prompt', 'model', 'images', 'ratio', 'count', 'outDir', 'channel', 'autoInstall', 'autoLogin'])
        const heal = selfHealOf(args)
        const images = Array.isArray(args.images) ? args.images.filter((value): value is string => typeof value === 'string' && value !== '') : []
        const result = await service.generateImage({
          prompt,
          channel,
          autoInstall: heal.autoInstall,
          autoLogin: heal.autoLogin,
          ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
          images,
          ...(typeof args.ratio === 'string' && args.ratio !== '' ? { ratio: args.ratio } : {}),
          ...(typeof args.count === 'number' ? { count: args.count } : {}),
          ...(typeof args.outDir === 'string' && args.outDir !== '' ? { outDir: args.outDir } : {}),
          sessionKey: sessionKeyOf(exec),
        })
        if (!result.ok) throw new Error(result.message ?? '生成失败')
        return withIgnored(resultText(result), ignored)
      },
    },
    {
      name: 'generate_video',
      description:
        '生成视频（支持参考图/首尾帧）。按时长计费（云雀 Seedance 2.0 Mini 体验版约 4 积分/秒）。' +
        '用户没有明确要求生成视频时不要调用；云雀通道下时长会被设置里的上限截断。' +
        '通道：channel=xyq（默认）或 channel=jimeng（即梦，短剧/画布，按秒扣积分、需要浏览器授权）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '视频描述（用户原话）' },
          model: { type: 'string', description: '视频模型 key（先用 xyq_models 查 video 列表）；不传用默认 Seedance_2.0_mini_lite' },
          duration: { type: 'number', description: '时长（秒，4~30，会被设置上限截断）' },
          ratio: { type: 'string', description: '比例，如 1:1 / 16:9 / 9:16' },
          images: { type: 'array', items: { type: 'string' }, description: '参考图本地绝对路径，可多张' },
          outDir: { type: 'string', description: '下载目录；默认 xyq_output' },
          channel: { type: 'string', enum: CHANNEL_ENUM, description: '生成通道：xyq=小云雀（默认），jimeng=即梦' },
          ...SELF_HEAL_PARAMS,
        },
        required: ['prompt'],
      },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 25 * 60_000,
      async execute(args: Record<string, unknown>, exec: unknown): Promise<string> {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('需要 prompt（用户原始描述）')
        const ignored = ignoredKeys(args, ['prompt', 'model', 'duration', 'ratio', 'images', 'outDir', 'channel', 'autoInstall', 'autoLogin'])
        const heal = selfHealOf(args)
        const images = Array.isArray(args.images) ? args.images.filter((value): value is string => typeof value === 'string' && value !== '') : []
        const result = await service.generateVideo({
          prompt,
          channel: channelOf(args),
          autoInstall: heal.autoInstall,
          autoLogin: heal.autoLogin,
          ...(typeof args.model === 'string' && args.model !== '' ? { model: args.model } : {}),
          ...(typeof args.duration === 'number' ? { duration: args.duration } : {}),
          ...(typeof args.ratio === 'string' && args.ratio !== '' ? { ratio: args.ratio } : {}),
          images,
          ...(typeof args.outDir === 'string' && args.outDir !== '' ? { outDir: args.outDir } : {}),
          sessionKey: sessionKeyOf(exec),
        })
        if (!result.ok) throw new Error(result.message ?? '生成失败')
        return withIgnored(resultText(result), ignored)
      },
    },
    {
      name: 'xyq_balance',
      description:
        '查询生成额度：两条通道各报一段（小云雀积分 / 即梦积分）。生成前先查，避免余额不足；' +
        '某一条不可用只影响它自己（会写明原因与下一步）。',
      parameters: { type: 'object', properties: { ...SELF_HEAL_PARAMS } },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 180_000,
      async execute(args: Record<string, unknown>): Promise<string> {
        const rows = await service.balanceAll(selfHealOf(args))
        const lines = rows.map((row) =>
          row.ok ? `- ${row.label}：剩余 ${row.totalRemain ?? '未知'}` : `- ${row.label}：${row.message ?? '查询失败'}`,
        )
        return ['生成额度（按通道）：', ...lines].join('\n')
      },
    },
    {
      name: 'xyq_models',
      description:
        '查询可用模型（type=video 或 image）。生图/生视频前用它确认模型名（两条通道的模型名不通用，先定通道再查）。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['video', 'image'], description: '模型类型' },
          channel: { type: 'string', enum: CHANNEL_ENUM, description: '通道：xyq=小云雀（默认），jimeng=即梦' },
          ...SELF_HEAL_PARAMS,
        },
        required: ['type'],
      },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 90_000,
      async execute(args: Record<string, unknown>): Promise<string> {
        const kind = args.type === 'image' ? 'image' : 'video'
        const ignored = ignoredKeys(args, ['type', 'channel', 'autoInstall', 'autoLogin'])
        const result = await service.models(kind, channelOf(args), selfHealOf(args))
        if (!result.ok) throw new Error(result.message ?? '查询模型失败')
        const list = result.models ?? []
        const body = list.length === 0 ? '（没有查到模型）' : list.map((model) => `- ${model.name}（${model.key}）`).join('\n')
        return withIgnored(body, ignored)
      },
    },
    {
      /**
       * 指南兜底（契约要求每个域留一个 `<域>_guide`）：与 skill `dafeiyu-xyq` 同一份正文。
       * 模型没加载到 skill 时，一次工具调用就能拿到「什么时候选哪条通道」的口径。
       */
      name: 'xyq_guide',
      description:
        '返回「生成通道」使用指南（与 skill `dafeiyu-xyq` 同一份正文）：两条通道（xyq 小云雀 / jimeng 即梦）怎么选、' +
        '计费与登录差异、不可用时怎么读错误、模型名为什么不通用。上下文里没有该 skill 时用它兜底。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 15_000,
      async execute(): Promise<string> {
        return deps.guideBody ? deps.guideBody() : XYQ_GUIDE_FALLBACK
      },
    },
  ]
}
