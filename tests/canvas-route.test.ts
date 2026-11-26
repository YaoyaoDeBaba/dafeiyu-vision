/**
 * canvas-route.test —— 设置页「即梦画布（只读）」那条路由的判据。
 *
 * 判据只有五条，但都是"面板会真的踩到"的：
 *   ① 正常返回形状（canvases / nodes 都透传 data）；
 *   ② canvasId / limit 真被传下去（面板切画布靠它）；
 *   ③ 没装画布 CLI ⇒ `unavailable:true`，**不是** 500；
 *   ④ what 写错 ⇒ 400 + 中文；
 *   ⑤ 非 GET ⇒ 405（只读路由不许有写口子）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { XYQ_CANVAS_ROUTE, xyqCanvasHandler, xyqQueryHandler } from '../src/xyq/routes.js'
import type { CanvasService } from '../src/xyq/canvas/service.js'

function fakeResponse() {
  const captured: { status?: number; body?: unknown } = {}
  return {
    captured,
    setHeader: () => undefined,
    writeHead: (status: number) => {
      captured.status = status
    },
    end: (payload: string) => {
      try {
        captured.body = JSON.parse(payload) as unknown
      } catch {
        captured.body = payload
      }
    },
  }
}

function fakeRequest(url: string, method = 'GET') {
  // 只给 handler 真正读的字段；类型上用 unknown→never 过界（判据关心行为，不关心 IncomingMessage 的 66 个属性）
  return { method, url, headers: { host: '127.0.0.1:49843' } } as unknown as never
}

function canvasWith(overrides: Partial<CanvasService> = {}): CanvasService {
  const base = {
    available: () => true,
    status: async () => ({ ok: true, data: { loggedIn: true, expiresAt: '2026-11-26T03:55:17' } }),
    canvases: async () => ({ ok: true, data: { items: [{ projectId: 'p-1', name: '鲸鱼做梦自检-20261125' }], hasMore: false } }),
    current: async () => ({ ok: true, data: null }),
    nodes: async () => ({ ok: true, data: { items: [{ nodeId: 'n-1', type: 'image', title: '角色立绘', status: 'success' }], hasMore: false, offset: 0, limit: 20 } }),
  }
  return { ...base, ...overrides } as unknown as CanvasService
}

const deps = (canvas?: CanvasService) => ({
  service: {} as never,
  outDir: 'C:/tmp',
  log: () => {},
  ...(canvas === undefined ? {} : { canvas }),
})

test(`${XYQ_CANVAS_ROUTE}：canvases 透传 data，status 带回登录态`, async () => {
  const handler = xyqCanvasHandler(deps(canvasWith()))
  const resA = fakeResponse()
  await handler(fakeRequest(`${XYQ_CANVAS_ROUTE}?what=canvases`), resA as never)
  assert.equal(resA.captured.status, 200)
  const bodyA = resA.captured.body as { ok: boolean; data: { items: Array<{ name: string }> } }
  assert.equal(bodyA.ok, true)
  assert.equal(bodyA.data.items[0]?.name, '鲸鱼做梦自检-20261125')

  const resB = fakeResponse()
  await handler(fakeRequest(`${XYQ_CANVAS_ROUTE}?what=status`), resB as never)
  const bodyB = resB.captured.body as { data: { loggedIn: boolean } }
  assert.equal(bodyB.data.loggedIn, true)
})

test('画布路由：canvasId 与 limit 真的传给了 service（面板切画布靠这个）', async () => {
  let seen: Record<string, unknown> | undefined
  const handler = xyqCanvasHandler(
    deps(
      canvasWith({
        nodes: (async (input: Record<string, unknown>) => {
          seen = input
          return { ok: true, data: { items: [], hasMore: false, offset: 0, limit: 20 } }
        }) as never,
      }),
    ),
  )
  const res = fakeResponse()
  await handler(fakeRequest(`${XYQ_CANVAS_ROUTE}?what=nodes&canvasId=p-9&limit=7`), res as never)
  assert.equal(res.captured.status, 200)
  assert.equal(seen?.canvasId, 'p-9')
  assert.equal(seen?.limit, 7)
})

test('画布路由：没装画布 CLI ⇒ unavailable:true（200），不是 500', async () => {
  const handler = xyqCanvasHandler(deps(undefined))
  const res = fakeResponse()
  await handler(fakeRequest(`${XYQ_CANVAS_ROUTE}?what=status`), res as never)
  assert.equal(res.captured.status, 200)
  const body = res.captured.body as { ok: boolean; unavailable?: boolean; error: string }
  assert.equal(body.ok, false)
  assert.equal(body.unavailable, true)
  assert.match(body.error, /dreamina-canvas/)
})

test('画布路由：what 写错 ⇒ 400 + 中文；非 GET ⇒ 405（只读不许有写口子）', async () => {
  const handler = xyqCanvasHandler(deps(canvasWith()))
  const bad = fakeResponse()
  await handler(fakeRequest(`${XYQ_CANVAS_ROUTE}?what=delete-everything`), bad as never)
  assert.equal(bad.captured.status, 400)
  assert.match(String((bad.captured.body as { error: string }).error), /status \/ canvases \/ current \/ nodes/)

  const post = fakeResponse()
  await handler(fakeRequest(XYQ_CANVAS_ROUTE, 'POST'), post as never)
  assert.equal(post.captured.status, 405)
})

// ── 0.11.0：快速面板按通道拉模型/余额（路由层）─────────────────────

test('xyq/models|balance 带 ?channel=jimeng ⇒ 服务层收到 jimeng（面板切通道靠它）', async () => {
  const seen: Array<Record<string, unknown>> = []
  const service = {
    config: () => ({ defaultChannel: 'xyq' }),
    models: async (type: string, channel: string) => {
      seen.push({ kind: 'models', type, channel })
      return { ok: true, models: [{ key: 'seedream_5.5', name: 'Seedream 5.5' }] }
    },
    balance: async (channel: string) => {
      seen.push({ kind: 'balance', channel })
      return { ok: true, totalRemain: '652' }
    },
  }
  const handler = xyqQueryHandler('models', { service: service as never, outDir: 'C:/tmp', log: () => {} })
  const res = fakeResponse()
  await handler(fakeRequest('/api/dsh-remote-dafeiyu/xyq/models?type=image&channel=jimeng'), res as never)
  assert.equal(res.captured.status, 200)
  const body = res.captured.body as { channel?: string; models?: Array<{ key: string }> }
  assert.equal(body.channel, 'jimeng')
  assert.equal(body.models?.[0]?.key, 'seedream_5.5')
  assert.deepEqual(seen[0], { kind: 'models', type: 'image', channel: 'jimeng' })

  const balHandler = xyqQueryHandler('balance', { service: service as never, outDir: 'C:/tmp', log: () => {} })
  const res2 = fakeResponse()
  await balHandler(fakeRequest('/api/dsh-remote-dafeiyu/xyq/balance?channel=jimeng'), res2 as never)
  assert.equal((res2.captured.body as { channel?: string }).channel, 'jimeng')
})
