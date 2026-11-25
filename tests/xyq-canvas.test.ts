/**
 * xyq-canvas.test —— 即梦**画布**适配器（只读）的判据。
 *
 * fixture 全部照 2026-11-25 真机抓到的形状写（不是编的）：
 *   auth status    → {"schemaVersion":"2","ok":true,"data":{"loggedIn":true,"expiresAt":…,"version":"1.4.2"}}
 *   canvas ls      → {"ok":true,"data":{"items":[],"hasMore":false}}
 *   canvas current → {"ok":true,"data":{"currentCanvas":null,"checkedAt":…}}
 *   node ls        → 定位摘要（nodeId/type/title/status/tags）
 *   error          → {"ok":false,"error":{"code":2,"message":"…","diagnostics":[{"detail":"…"}]}}
 *
 * 另外钉两件与短剧不同的硬事实：**必须 `--format json`（不是 `-j`）**、**信封是 {ok,data,error}**。
 * 全程进程内假执行器，不跑真 CLI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvasCli, locateCanvasCli, parseCanvasEnvelope } from '../src/xyq/canvas/cli.js'
import { createCanvasService } from '../src/xyq/canvas/service.js'
import { canvasTools } from '../src/xyq/canvas/tools.js'
import type { CliRunner } from '../src/xyq/cli.js'

const CANVAS = 'C:/jimeng/bin/dreamina-canvas.exe'

type Reply = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean }

function makeHarness(queues: Record<string, Reply | Reply[]>) {
  const calls: string[][] = []
  const map = new Map<string, Reply[]>()
  for (const [key, value] of Object.entries(queues)) map.set(key, Array.isArray(value) ? [...value] : [value])
  const run: CliRunner = async (args) => {
    calls.push(args)
    // 队列按「两级子命令」匹配（画布：`auth status` / `canvas ls` / `node ls` / `auth login` / `auth wait`）
    const two = `${args[1] ?? ''} ${args[2] ?? ''}`.trim()
    const queue = map.get(two) ?? map.get(args[1] ?? '')
    const reply = queue !== undefined && queue.length > 0 ? queue.shift()! : { code: 0, stdout: '', stderr: '' }
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', timedOut: reply.timedOut ?? false }
  }
  const cli = createCanvasCli({ run, locate: () => CANVAS, exists: () => true })
  const service = createCanvasService({ cli, loginWaitMs: 1_000, log: () => {} })
  return { service, cli, calls }
}

const STATUS_OK: Reply = {
  code: 0,
  stdout: JSON.stringify({ schemaVersion: '2', ok: true, data: { loggedIn: true, expiresAt: '2026-11-26T03:55:17', profile: 'default', region: 'cn', version: '1.4.2' } }),
}

test('信封：画布用 {ok,data,error}；解析器认 ok，并且错误里带 diagnostics 那句', () => {
  const okEnvelope = parseCanvasEnvelope('{"schemaVersion":"2","ok":true,"data":{"items":[]}}')
  assert.equal(okEnvelope?.ok, true)

  const errorEnvelope = parseCanvasEnvelope(
    '{"ok":false,"error":{"code":2,"message":"The request parameters are invalid.","diagnostics":[{"detail":"The command contains an unrecognized option."}]}}',
  )
  assert.equal(errorEnvelope?.ok, false)
  assert.equal(errorEnvelope?.error?.code, 2)
})

test('flag：画布只认 --format json，绝不发 -j', async () => {
  const h = makeHarness({ 'auth status': STATUS_OK })
  await h.service.status()
  const call = h.calls[0]!
  assert.deepEqual(call.slice(1), ['auth', 'status', '--format', 'json'], '必须是 --format json（-j 画布不认）')
  assert.equal(call.includes('-j'), false)
})

test('status：读出登录态与到期时间', async () => {
  const h = makeHarness({ 'auth status': STATUS_OK })
  const result = await h.service.status()
  assert.equal(result.ok, true)
  assert.equal(result.data?.loggedIn, true)
  assert.equal(result.data?.version, '1.4.2')
})

test('canvases：空列表（真机形状）不报错；有画布时带 projectId/name', async () => {
  const empty = makeHarness({ 'canvas ls': { stdout: JSON.stringify({ ok: true, data: { items: [], hasMore: false } }) } })
  const emptyResult = await empty.service.canvases()
  assert.equal(emptyResult.ok, true)
  assert.deepEqual(emptyResult.data?.items, [])

  const filled = makeHarness({
    'canvas ls': {
      stdout: JSON.stringify({
        ok: true,
        data: { items: [{ projectId: 'p-1', name: '鲸鱼做梦自检', updatedAt: '2026-11-25T21:00:00', webUrl: 'https://jimeng.jianying.com/canvas/p-1' }], hasMore: false },
      }),
    },
  })
  const filledResult = await filled.service.canvases()
  assert.equal(filledResult.data?.items[0]?.projectId, 'p-1')
  assert.equal(filledResult.data?.items[0]?.name, '鲸鱼做梦自检')
})

test('current：currentCanvas 为 null 时返回 null（真机形状）', async () => {
  const h = makeHarness({ 'canvas current': { stdout: JSON.stringify({ ok: true, data: { currentCanvas: null, checkedAt: 1795614941068 } }) } })
  const result = await h.service.current()
  assert.equal(result.ok, true)
  assert.equal(result.data, null)
})

test('nodes：命令是 node ls，带 --project-id/--limit/--offset，解析定位摘要', async () => {
  const h = makeHarness({
    'node ls': {
      stdout: JSON.stringify({
        ok: true,
        data: { items: [{ nodeId: 'n-1', type: 'image', title: '角色立绘', status: 'success', tags: ['default-tag-1'] }], hasMore: false },
      }),
    },
  })
  const result = await h.service.nodes({ canvasId: 'p-1', type: 'image', limit: 10, offset: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.data?.items[0]?.nodeId, 'n-1')
  assert.equal(result.data?.items[0]?.title, '角色立绘')
  const call = h.calls.find((args) => args[1] === 'node')!
  assert.deepEqual(call.slice(1, 3), ['node', 'ls'], '节点列表是 node ls（不是 node list）')
  assert.ok(call.includes('--project-id') && call.includes('p-1'))
  assert.ok(call.includes('--limit') && call.includes('10'))
})

test('错误信封：把 diagnostics 那句翻成人话（带「即梦画布：」前缀）', async () => {
  const h = makeHarness({
    'auth status': {
      stdout: JSON.stringify({ ok: false, error: { code: 2, message: 'The request parameters are invalid.', diagnostics: [{ detail: 'The command contains an unrecognized option.' }] } }),
    },
  })
  const result = await h.service.status()
  assert.equal(result.ok, false)
  assert.match(String(result.message), /即梦画布：/)
  assert.match(String(result.message), /unrecognized option/)
})

test('login：auth login 拿设备码 → 同一次调用里 auth wait（不是只发链接）', async () => {
  const h = makeHarness({
    'auth login': { stdout: JSON.stringify({ ok: true, data: { deviceCode: 'dc-1', verificationUriComplete: 'https://jimeng.test/auth' } }) },
    'auth wait': { stdout: JSON.stringify({ ok: true, data: { status: 'logged_in', loggedIn: true } }) },
  })
  const result = await h.service.login()
  assert.equal(result.loggedIn, true)
  assert.equal(result.link, 'https://jimeng.test/auth')
  const waitCall = h.calls.find((args) => args[1] === 'auth' && args[2] === 'wait')
  assert.ok(waitCall !== undefined, '必须真的等一次（只发链接 = 用户点了也没凭证）')
  assert.ok(waitCall!.includes('--device-code') && waitCall!.includes('dc-1'))
  assert.ok(waitCall!.includes('--format'), 'wait 也要 json')
})

test('login：wait 超时 → 如实回「点完再调一次」并带链接，不假装成功', async () => {
  const h = makeHarness({
    'auth login': { stdout: JSON.stringify({ ok: true, data: { deviceCode: 'dc-2', verificationUriComplete: 'https://jimeng.test/auth2' } }) },
    'auth wait': { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 3, message: 'authorization pending' } }) },
  })
  const result = await h.service.login()
  assert.equal(result.loggedIn, false)
  assert.match(String(result.message), /点完再调一次/)
})

test('定位：DREAMINA_CANVAS_CLI 优先，找不到就 undefined（不瞎猜）', () => {
  const found = locateCanvasCli({ env: { DREAMINA_CANVAS_CLI: 'C:/x/canvas.exe' }, home: 'C:/home', platform: 'win32', exists: (f) => f === 'C:/x/canvas.exe' })
  assert.equal(found, 'C:/x/canvas.exe')

  const none = locateCanvasCli({ env: {}, home: 'C:/home', platform: 'win32', exists: () => false })
  assert.equal(none, undefined)
})

test('工具：xyq_canvas 六个键齐全，action 不合法当场中文报错', async () => {
  const h = makeHarness({ 'auth status': STATUS_OK })
  const tool = canvasTools(h.service)[0] as Record<string, unknown>
  for (const key of ['name', 'description', 'parameters', 'output', 'timeoutMs', 'execute']) assert.ok(key in tool, `缺 ${key}`)
  assert.equal((tool.output as { schema: { type: string } }).schema.type, 'string')
  const execute = tool.execute as (args: Record<string, unknown>) => Promise<string>
  await assert.rejects(() => execute({ action: 'delete-everything' }), /action 只能是/)
  const text = await execute({ action: 'status' })
  assert.match(text, /已登录/)
})
test('错误信封写在 stderr 也要解析；「No project ID」翻成「还没选中画布」', async () => {
  const h = makeHarness({
    'node ls': {
      code: 2,
      stdout: '',
      stderr: JSON.stringify({ schemaVersion: '2', ok: false, error: { code: 2, message: 'The request parameters are invalid.', diagnostics: [{ detail: 'No project ID was provided.' }] } }),
    },
  })
  const result = await h.service.nodes({ limit: 5 })
  assert.equal(result.ok, false)
  assert.match(String(result.message), /还没选中画布/, '真机那条 No project ID 要翻成人话')
})
