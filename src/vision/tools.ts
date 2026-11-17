/**
 * vision/tools —— 给 agent 的四个工具（**这是主入口，界面只是配置台**）。
 *
 * | 工具 | 面向 | 说明 |
 * |---|---|---|
 * | `recognize_image` | 常规调用 | 一张本地图片 → 文本描述 |
 * | `vision_guide` | 兜底 | 返回 skill 正文（单一真源，别在这儿复制文案） |
 * | `vision_web_status` | 排障 | 网页版登录态 |
 * | `vision_web_login` | 排障/开箱 | 弹有头窗口让用户登录 |
 *
 * 形态照大肥鱼插件契约（`dafeiyu-plugin-dev` §2）：六个键一个不少；
 * `output.schema.type === 'string'` 且返回值确实是字符串；`execute` 出错抛中文原因。
 * 参数里认不出的键要显形（`ignored`），不许静默吞掉——那是 `.57` 那次"高级档参数静默失效"的教训。
 */
import { readFile } from 'node:fs/promises'
import type { VisionService } from './service.js'
import { VisionError } from './protocols.js'
import { SITES, type WebSiteId } from './web/index.js'

export interface VisionToolsDeps {
  /** 指南正文（读 skill 的 SKILL.md，单一真源）。 */
  guideBody: () => string
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

function mimeOf(file: string): string {
  const ext = String(file).split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'image/png'
}

/** 认不出的参数键（显形用；空数组就不写进返回）。 */
function ignoredKeys(args: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(args ?? {}).filter((key) => !known.includes(key))
}

/** 统一的字符串返回工具壳（六个键里跑不掉的五个）。 */
function stringTool(definition: {
  name: string
  description: string
  parameters: Record<string, unknown>
  timeoutMs: number
  execute: (args: Record<string, unknown>) => Promise<string>
}): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: definition.timeoutMs,
    execute: definition.execute,
  }
}

export function buildVisionTools(service: VisionService, deps: VisionToolsDeps): Array<Record<string, unknown>> {
  return [
    stringTool({
      name: 'recognize_image',
      description:
        '把一张本地图片交给外挂视觉能力（API 模型或本机已登录的网页版豆包/Gemini），返回图片内容的详细文本描述，' +
        '含逐字转录。用于看截图、照片、图表、UI、报错截图。' +
        '传 image_path（绝对路径）；prompt 可选，用于本次临时指令（例如"只抄报错那几行"），不传用设置页的默认识图提示词。' +
        '网页版那一路单次 10~25 秒，别对同一张图连续重复调用；图片上限 20MB。' +
        '不要用它回答"用户已经贴图给你"的场景——那种情况你收到的是「【图片识别】」开头的文本，直接用即可。',
      parameters: {
        type: 'object',
        properties: {
          image_path: { type: 'string', description: '图片文件的绝对路径（png/jpg/webp/gif/bmp）' },
          prompt: { type: 'string', description: '可选：本次识图的具体指令，覆盖默认识图提示词' },
        },
        required: ['image_path'],
      },
      timeoutMs: 120_000,
      async execute(args) {
        const file = typeof args.image_path === 'string' ? args.image_path : ''
        if (file === '') throw new Error('需要图片的绝对路径（image_path）')
        const data = await readFile(file).catch((error: unknown) => {
          throw new Error(`读不到图片：${file}（${String((error as Error)?.message ?? error).slice(0, 120)}）`)
        })
        if (data.byteLength === 0) throw new Error(`图片文件是空的：${file}`)
        if (data.byteLength > 20 * 1024 * 1024) throw new Error(`图片太大（>20MB）：${file}`)
        const ignored = ignoredKeys(args, ['image_path', 'prompt'])
        const text = await service.recognize({
          base64: data.toString('base64'),
          mime: mimeOf(file),
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        })
        if (ignored.length === 0) return text
        return `${text}\n\n（忽略未知参数：${ignored.join(', ')}）`
      },
    }),

    stringTool({
      name: 'vision_guide',
      description:
        '返回「大肥鱼识图」的完整使用指南（与 skill `dafeiyu-vision` 同一份正文）：什么时候该调 recognize_image、' +
        '单一/复合模式、网页版（免 key）要登录、报错怎么读。上下文里没有该 skill 时用它兜底。',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 15_000,
      async execute() {
        return deps.guideBody()
      },
    }),

    stringTool({
      name: 'vision_web_status',
      description:
        '查「网页版识图（免 key）」的登录态：豆包 / Gemini 是否已登录。识图报"没有登录"或想确认开箱状态时先调它。' +
        'site 不给默认查两个；会起一次无头浏览器（3~8 秒）。',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', enum: ['doubao', 'gemini', 'both'], description: '要查哪个站点，默认 both' },
        },
      },
      timeoutMs: 90_000,
      async execute(args) {
        const raw = typeof args.site === 'string' ? args.site : 'both'
        const sites: WebSiteId[] = raw === 'both' ? ['doubao', 'gemini'] : raw === 'doubao' || raw === 'gemini' ? [raw] : []
        if (sites.length === 0) throw new Error('site 只能是 doubao / gemini / both')
        const rows: Array<Record<string, unknown>> = []
        for (const site of sites) {
          try {
            rows.push(await service.webStatus(site))
          } catch (error) {
            rows.push({ site, label: SITES[site].label, loggedIn: false, error: String((error as Error)?.message ?? error) })
          }
        }
        const ignored = ignoredKeys(args, ['site'])
        const summary = rows
          .map((row) => `${row.label ?? row.site}：${row.loggedIn === true ? '已登录' : `未登录${row.error ? `（${String(row.error)}）` : ''}`}`)
          .join('；')
        return ignored.length === 0
          ? `${summary}\n${JSON.stringify(rows)}`
          : `${summary}\n${JSON.stringify(rows)}\n（忽略未知参数：${ignored.join(', ')}）`
      },
    }),

    stringTool({
      name: 'vision_web_login',
      description:
        '在用户机器上**弹出一个有头浏览器窗口**，让用户登录网页版豆包 / Gemini。' +
        '只在确认未登录、且用户人就在电脑前时调用（窗口会抢焦点）；最多等 150 秒。' +
        '登录态存在本机 profile 里，之后长期有效。别连着重试——用户没登完重试也是白等。',
      parameters: {
        type: 'object',
        properties: {
          site: { type: 'string', enum: ['doubao', 'gemini'], description: '要登录哪个站点' },
        },
        required: ['site'],
      },
      timeoutMs: 240_000,
      async execute(args) {
        const site = typeof args.site === 'string' ? args.site : ''
        if (site !== 'doubao' && site !== 'gemini') throw new Error('site 只能是 doubao / gemini')
        const result = await service.webLogin(site, 150_000)
        const label = SITES[site].label
        const ignored = ignoredKeys(args, ['site'])
        const tail = ignored.length === 0 ? '' : `\n（忽略未知参数：${ignored.join(', ')}）`
        return result.loggedIn
          ? `${label} 已登录（登录态存在本机 profile，之后不用再登）。等了 ${Math.round(result.waitedMs / 1000)} 秒。${tail}`
          : `${label} 还没登上：窗口里没检出登录态（可能用户不在、或登到一半关了窗口）。等了 ${Math.round(result.waitedMs / 1000)} 秒；可以再调一次，或让用户自己在设置页点「登录 ${label}」。${tail}`
      },
    }),
  ]
}

/** 供 start.ts 判断"这个工具是不是我们的"（卸载时按名字注销，如果宿主支持）。 */
export const VISION_TOOL_NAMES = [
  'recognize_image',
  'vision_guide',
  'vision_web_status',
  'vision_web_login',
] as const

/** 工具级错误的统一形状提示（有 VisionError 就原样抛，模型能读懂中文）。 */
export function toToolError(error: unknown): Error {
  if (error instanceof VisionError) return new Error(error.message)
  return error instanceof Error ? error : new Error(String(error))
}
