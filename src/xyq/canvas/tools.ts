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

const ACTIONS = ['status', 'canvases', 'current', 'nodes', 'login', 'create-canvas', 'node-create', 'node-quote', 'node-run', 'node-download', 'node-delete', 'canvas-delete'] as const
type Action = (typeof ACTIONS)[number]

function ignoredKeys(args: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(args ?? {}).filter((key) => !known.includes(key))
}

export function canvasTools(service: CanvasService, deps: { maxCredits?: number } = {}): Array<Record<string, unknown>> {
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
          name: { type: 'string', description: 'create-canvas 用：画布名（建议带日期，便于事后清理）' },
          model: { type: 'string', description: 'node-create 用：图片模型 key（xyq_models({type:"image",channel:"jimeng"})）' },
          prompt: { type: 'string', description: 'node-create 用：完整提示词' },
          count: { type: 'number', description: 'node-create 用：生成张数（按模型支持范围）' },
          mode: { type: 'string', enum: ['t2i', 'i2i'], description: 'node-create 用：文生图/图生图（默认 t2i）' },
          nodeIds: { type: 'array', items: { type: 'string' }, description: 'node-quote / node-run 用：节点 id 列表' },
          resourceIds: { type: 'array', items: { type: 'string' }, description: 'node-download 用：资源 id 列表（node-run 回的那串）' },
          confirm: { type: 'boolean', description: '写操作开关：create-canvas / node-create / node-run / node-delete / canvas-delete 必须显式传 true 才会执行（默认不执行）' },
          force: { type: 'boolean', description: 'canvas-delete 用：CLI 无删除画布命令，此项只用于语义对齐（当前不改变结果）' },
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
        const ignored = ignoredKeys(args, ['action', 'canvasId', 'type', 'status', 'query', 'limit', 'offset', 'name', 'model', 'prompt', 'count', 'mode', 'nodeIds', 'resourceIds', 'confirm', 'force'])
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

        const cap = Math.max(0, Math.round(deps.maxCredits ?? 50))
        const needConfirm = (): string | undefined =>
          args.confirm === true ? undefined : `这是写操作（会在你账号里留东西/可能扣积分），必须显式传 confirm:true 才会执行；本次没做任何事。`

        if (action === 'create-canvas') {
          const blocked = needConfirm()
          if (blocked !== undefined) throw new Error(blocked)
          const name = typeof args.name === 'string' ? args.name : ''
          const result = await service.createCanvas(name)
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '建画布失败')
          return tail(`已建画布：${result.data.name}｜projectId=${result.data.projectId}（一次只建 1 个；不用了去网页里删）`)
        }

        if (action === 'node-create') {
          const blocked = needConfirm()
          if (blocked !== undefined) throw new Error(blocked)
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const model = typeof args.model === 'string' ? args.model : ''
          const prompt = typeof args.prompt === 'string' ? args.prompt : ''
          const result = await service.createImageNode({
            canvasId,
            model,
            prompt,
            ...(typeof args.count === 'number' ? { count: args.count } : {}),
            ...(args.mode === 'i2i' ? { mode: 'i2i' as const } : { mode: 't2i' as const }),
          })
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '建节点失败')
          return tail(`已建图片节点：nodeId=${result.data.nodeId}（还没跑，不扣积分）。下一步：xyq_canvas({action:"node-quote", canvasId:"${canvasId}", nodeIds:["${result.data.nodeId}"]})`)
        }

        if (action === 'node-quote') {
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter((v): v is string => typeof v === 'string' && v !== '') : []
          const result = await service.quote({ canvasId, nodeIds })
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '报价失败')
          const over = result.data.credits > cap
          const lines = [
            `预计消耗：${result.data.credits} 积分（本次上限 ${cap}）${over ? ' — 超过上限，不能跑' : ''}`,
            over ? '要跑：先调设置页把「画布积分上限」调高，或换便宜模型/减张数。' : '要跑：xyq_canvas({action:"node-run", confirm:true, canvasId, nodeIds})',
          ]
          return tail(lines.join('\n'))
        }

        if (action === 'node-run') {
          const blocked = needConfirm()
          if (blocked !== undefined) throw new Error(blocked)
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter((v): v is string => typeof v === 'string' && v !== '') : []
          if (nodeIds.length === 0) throw new Error('node-run 需要 nodeIds（先用 node-create 建节点）')
          // 报价 → 超上限**一次判死**（不再问第二次）→ 批准 → 跑
          const quote = await service.quote({ canvasId, nodeIds })
          if (quote.ok !== true || quote.data === undefined) throw new Error(quote.message ?? '报价失败，不敢跑')
          if (quote.data.credits > cap) {
            throw new Error(`预计要 ${quote.data.credits} 积分，超过设置上限 ${cap}，已拒绝执行（没有扣费）。调高上限或换便宜模型再来。`)
          }
          const confirmed = await service.confirm({ canvasId, nodeIds, ceiling: cap })
          if (confirmed.ok !== true || confirmed.data === undefined) throw new Error(confirmed.message ?? '批准失败')
          const ran = await service.run({ canvasId, nodeIds, token: confirmed.data.token })
          if (ran.ok !== true || ran.data === undefined) throw new Error(ran.message ?? '运行失败')
          return tail(
            [
              `已跑完，实扣积分：${ran.data.credits ?? '未知'}（预计 ${quote.data.credits}，上限 ${cap}）`,
              `产物 ${ran.data.artifacts.length} 个：`,
              ...ran.data.artifacts.map((file) => `- ${file}`),
            ].join('\n'),
          )
        }

        if (action === 'node-download') {
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const resourceIds = Array.isArray(args.resourceIds)
            ? args.resourceIds.filter((value): value is string => typeof value === 'string' && value !== '')
            : []
          const result = await service.download({ canvasId, resourceIds })
          if (result.ok !== true || result.data === undefined) throw new Error(result.message ?? '下载失败')
          return tail([`已下载 ${result.data.paths.length} 个：`, ...result.data.paths.map((file) => `- ${file}`)].join('\n'))
        }

        if (action === 'node-delete') {
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter((v): v is string => typeof v === 'string' && v !== '') : []
          if (nodeIds.length === 0) throw new Error('node-delete 需要 nodeIds')
          const preview = await service.previewNodeDeletion({ canvasId, nodeIds })
          if (preview.ok !== true || preview.data === undefined) throw new Error(preview.message ?? '拿不到删除清单，已中止')
          const list = preview.data.nodes.map((node) => `- ${node.title}｜${node.type}｜${node.nodeId}（子节点 ${node.childCount}）`)
          const totals = Object.entries(preview.data.totals).map(([key, value]) => `${key}=${value}`).join(' ')
          if (args.confirm !== true) {
            return tail(
              [
                `将要删除 ${preview.data.nodes.length} 个节点（**不可逆**，本次什么都没删）：`,
                ...list,
                ...(totals === '' ? [] : [`合计：${totals}`]),
                '确认要删就再调一次并传 confirm:true。',
              ].join('\n'),
            )
          }
          const deleted = await service.deleteNodes({ canvasId, nodeIds, updateId: preview.data.updateId })
          if (deleted.ok !== true || deleted.data === undefined) throw new Error(deleted.message ?? '删除失败')
          return tail([`已删除 ${deleted.data.deleted.length} 个节点（不可逆）：`, ...deleted.data.deleted.map((id) => `- ${id}`)].join('\n'))
        }

        if (action === 'canvas-delete') {
          if (args.confirm !== true) {
            return tail('删除画布是不可逆的写操作：请先确认要删哪个（对一下 projectId），再调一次并传 confirm:true。')
          }
          const canvasId = typeof args.canvasId === 'string' ? args.canvasId : ''
          const hint = await service.canvasDeleteHint(canvasId)
          return tail(hint.message ?? '画布删除失败')
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
