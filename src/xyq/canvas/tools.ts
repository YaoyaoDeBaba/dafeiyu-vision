/**
 * xyq/canvas/tools —— 给 agent 的**一个**画布工具：`xyq_canvas`。
 *
 * 为什么是一个工具 + `action` 枚举，而不是五六个：画布的读操作形状几乎一样（都是"查一下"），
 * 拆成五个工具会把工具表撑满、还会让模型在「该调哪个」上犹豫；以后加写操作（create/run）
 * 也只是多两个 action，不动工具名（对 agent 的契约稳定）。
 *
 * 纪律同别的工具：失败抛**中文原因**（模型会转述），成功把**绝对路径/ID**带上；
 * 认不出的参数键显形（`ignored`），不静默吞。
 */
import type { CanvasService } from './service.js'

const ACTIONS = ['status', 'canvases', 'current', 'nodes', 'login'] as const
type Action = (typeof ACTIONS)[number]

function ignoredKeys(args: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(args ?? {}).filter((key) => !known.includes(key))
}

export function canvasTools(service: CanvasService): Array<Record<string, unknown>> {
  return [
    {
      name: 'xyq_canvas',
      description:
        '即梦**画布**操作（只读）：action=status 查登录态；canvases 列画布（projectId/name/webUrl）；current 看当前画布；' +
        'nodes 列画布里的节点（nodeId/type/title/status，可带 canvasId/type/status/query/limit/offset）；' +
        'login 发起浏览器授权并**在同一次调用里等到 120 秒**（画布的 device flow 必须有人轮询才会落凭证，只发链接等于没登）。' +
        '与 `generate_image`/`generate_video` 的 channel=jimeng 不同：那条是"一次性出图/出片"，这条是"画布工程"入口。' +
        '画布没登录时先 action=login 拿链接给用户点，点完再调一次 status 确认。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS], description: '要做什么：status / canvases / current / nodes / login' },
          canvasId: { type: 'string', description: 'nodes 用：画布 projectId（不传则用当前画布）' },
          type: { type: 'string', description: 'nodes 用：节点类型 image / video / audio / text …' },
          status: { type: 'string', description: 'nodes 用：运行状态 empty / running / success / failed …' },
          query: { type: 'string', description: 'nodes 用：按标题/描述/prompt 文本匹配' },
          limit: { type: 'number', description: 'nodes 用：单页条数（1~50，默认 20）' },
          offset: { type: 'number', description: 'nodes 用：分页偏移（0~1000）' },
        },
        required: ['action'],
      },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }] },
      timeoutMs: 240_000,
      async execute(args: Record<string, unknown>): Promise<string> {
        const action = typeof args.action === 'string' ? (args.action as Action) : ''
        if (!(ACTIONS as readonly string[]).includes(action)) {
          throw new Error(`action 只能是 ${ACTIONS.join(' / ')}，收到的是「${String(args.action)}」`)
        }
        const ignored = ignoredKeys(args, ['action', 'canvasId', 'type', 'status', 'query', 'limit', 'offset'])
        const tail = (text: string): string => (ignored.length === 0 ? text : `${text}\n（忽略未知参数：${ignored.join(', ')}）`)

        if (action === 'status') {
          const result = await service.status()
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '查不到即梦画布登录态')
          const data = result.data
          return tail(
            [
              `即梦画布：${data.loggedIn ? '已登录' : '未登录'}`,
              ...(data.expiresAt === undefined ? [] : [`凭据到期：${data.expiresAt}`]),
              ...(data.version === undefined ? [] : [`CLI 版本：${data.version}`]),
              ...(data.loggedIn ? [] : ['下一步：调 xyq_canvas({action:"login"}) 拿授权链接。']),
            ].join('\n'),
          )
        }

        if (action === 'canvases') {
          const result = await service.canvases()
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '列不出画布')
          const items = result.data.items
          if (items.length === 0) return tail('这个账号下还没有画布（0 个）。')
          return tail(
            [
              `画布 ${items.length} 个${result.data.hasMore ? '（还有更多）' : ''}：`,
              ...items.map((item) => `- ${item.name}｜${item.projectId}${item.webUrl === undefined ? '' : `｜${item.webUrl}`}`),
            ].join('\n'),
          )
        }

        if (action === 'current') {
          const result = await service.current()
          if (result.ok !== true) throw new Error(result.message ?? '读不到当前画布')
          if (result.data === null || result.data === undefined) return tail('当前没有选中画布（可在网页里选，或 create 时加 --use）。')
          return tail(`当前画布：${result.data.name ?? '(未命名)'}｜${result.data.projectId ?? '(无 id)'}`)
        }

        if (action === 'nodes') {
          const result = await service.nodes({
            ...(typeof args.canvasId === 'string' && args.canvasId !== '' ? { canvasId: args.canvasId } : {}),
            ...(typeof args.type === 'string' && args.type !== '' ? { type: args.type } : {}),
            ...(typeof args.status === 'string' && args.status !== '' ? { status: args.status } : {}),
            ...(typeof args.query === 'string' && args.query !== '' ? { query: args.query } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
            ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
          })
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '列不出节点')
          const items = result.data.items
          if (items.length === 0) return tail('该范围内没有节点（0 条）。')
          return tail(
            [
              `节点 ${items.length} 条（offset ${result.data.offset} / limit ${result.data.limit}${result.data.hasMore ? '，还有更多' : ''}）：`,
              ...items.map((item) => `- ${item.title || '(无标题)'}｜${item.type}｜${item.status}｜${item.nodeId}`),
            ].join('\n'),
          )
        }

        // login
        const result = await service.login()
        if (result.loggedIn) return tail('即梦画布已登录（凭据已落盘）。')
        const lines = [result.message ?? '即梦画布授权没完成。']
        if (result.link !== undefined && result.link !== '') lines.push(`授权链接：${result.link}`)
        return tail(lines.join('\n'))
      },
    },
  ]
}

export const CANVAS_TOOL_NAMES = ['xyq_canvas'] as const
