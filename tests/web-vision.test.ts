/**
 * 网页版识图（`src/vision/web/*`）的判据。
 *
 * 这一层**不起浏览器**：`askSite` 只认一个 `CdpClient` 形状，测试里换成假客户端，
 * 于是「未登录怎么说 / 塞图走了没 / 回答怎么抽 / 超时算不算截断」这些能钉死的行为全在
 * Node 里跑，几毫秒出结果。真正的浏览器链路靠真机验收（见 PLAN.md 的 M1/M2）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_VISION_CONFIG,
  normalizeVisionConfig,
  planRecognition,
  webSiteOf,
} from '../src/vision/config.js'
import { VisionError } from '../src/vision/protocols.js'
import { composeRecognition, runRecognition } from '../src/vision/service.js'
import {
  VISION_RECOGNIZE_ROUTE,
  VISION_WEB_LOGIN_ROUTE,
  VISION_WEB_STATUS_ROUTE,
} from '../src/vision/routes.js'
import type { CdpClient } from '../src/vision/web/driver.js'
import { askSite, answerBudgetMs, DOUBAO, GEMINI, probeLogin, writeTempImage } from '../src/vision/web/sites.js'
import { killBrowsersUsingProfile } from '../src/vision/web/driver.js'
import { runLoginSession } from '../src/vision/web/index.js'

// ── 假 CDP 客户端 ────────────────────────────────────────────────────────────

interface FakeOptions {
  /** 已登录？ */
  loggedIn?: boolean
  /** 回答文本按次返回（数组用完后一直用最后一个）。 */
  answers?: string[]
  /** 上传后是否停在「正在上传」（模拟卡住）。 */
  uploading?: boolean
  /** 上传入口点不到（模拟改版）。 */
  noUploadButton?: boolean
  /** 弹层里找不到项目（模拟项目名不存在）。 */
  noProject?: boolean
}

interface FakeClient extends CdpClient {
  calls: string[]
  insertedText: string
  files: string[]
}

function fakeClient(options: FakeOptions = {}): FakeClient {
  const calls: string[] = []
  const files: string[] = []
  const answers = options.answers ?? ['图里有一个红色圆圈，写着 RED CIRCLE，还有一行 WORD: BANANA-4271。']
  let answerIndex = 0
  let uploadingTicks = options.uploading ? 3 : 0

  const evaluate = async (expression: string): Promise<unknown> => {
    calls.push(`eval:${expression.slice(0, 160)}`)
    // 0) clickExpression 的取坐标：区分「项目 chip」和「弹层里的项目项」
    if (expression.includes('scrollIntoView')) {
      calls.push(expression.includes('menuitem') ? 'click:item' : 'click:chip')
      if (expression.includes('menuitem')) return options.noProject ? null : { x: 20, y: 20 }
      return { x: 10, y: 10 }
    }
    // 1) 登录探针（两个站点各有一套判据）
    if (expression.includes('to_login_button') || expression.includes('ServiceLogin')) return options.loggedIn !== false
    // 2) 回答抽取
    if (expression.includes('for (const sel of')) {
      const text = answers[Math.min(answerIndex, answers.length - 1)] ?? ''
      answerIndex += 1
      return { text, selector: 'fake' }
    }
    // 3) 生成中？
    if (expression.includes('.some((sel)')) return false
    // 4) 上传入口
    if (expression.includes('upload_file_button') || expression.includes('上传和工具')) return !options.noUploadButton
    // 3.5) 打字走 execCommand('insertText')（不是在 call 里），这里把文本记下来给断言用
    if (expression.includes("execCommand('insertText'")) {
      const match = /execCommand\('insertText', false, (".*?")\)/.exec(expression)
      if (match && typeof match[1] === 'string') client.insertedText = JSON.parse(match[1]) as string
      return true
    }
    // 5) 上传进度 / 附件缩略图
    if (expression.includes('正在上传')) {
      if (uploadingTicks > 0) {
        uploadingTicks -= 1
        return { uploading: true, count: 0 }
      }
      return { uploading: false, count: 1 }
    }
    // 6) 输入框 / file input 存在性 / focus / 发送按钮坐标
    return true
  }

  const client: FakeClient = {
    port: 0,
    calls,
    insertedText: '',
    files,
    evaluate: evaluate as CdpClient['evaluate'],
    async call(method: string, params?: unknown): Promise<never> {
      calls.push(`call:${method}`)
      if (method === 'Runtime.evaluate') {
        // setFileInput 要 objectId
        return { result: { objectId: 'fake-node' } } as never
      }
      if (method === 'DOM.setFileInputFiles') {
        const list = (params as { files?: string[] } | undefined)?.files ?? []
        files.push(...list)
        for (const file of list) {
          assert.ok(existsSync(file), `塞进去的文件应该真的落盘了：${file}`)
        }
        return {} as never
      }
      if (method === 'Input.insertText') {
        client.insertedText = String((params as { text?: string } | undefined)?.text ?? '')
        return {} as never
      }
      return {} as never
    },
    async goto(url: string): Promise<void> {
      calls.push(`goto:${url}`)
    },
    async bringToFront(): Promise<void> {
      calls.push('bringToFront')
    },
    async screenshot(): Promise<void> {
      calls.push('screenshot')
    },
    async close(): Promise<void> {
      calls.push('close')
    },
  }
  return client
}

const IMAGE = { base64: Buffer.from('fake-png-bytes').toString('base64'), mime: 'image/png' }

// ── 配置面 ──────────────────────────────────────────────────────────────────

test('配置：网页版字段被接受，且不吃 key', () => {
  const config = normalizeVisionConfig({ protocol: 'web-doubao', webHeadless: false })
  // 旧写法（protocol 里带 web-*）被迁移成「白嫖豆包 + 站点」，协议本身回到 auto
  assert.equal(config.freeDoubao, true)
  assert.equal(config.webSite, 'doubao')
  assert.equal(config.protocol, 'auto')
  assert.equal(config.webHeadless, false)

  // 默认无头；脏值回落
  assert.equal(normalizeVisionConfig({}).webHeadless, DEFAULT_VISION_CONFIG.webHeadless)
  assert.equal(normalizeVisionConfig({ webHeadless: 'yes' }).webHeadless, DEFAULT_VISION_CONFIG.webHeadless)

  // 网页版项目名：默认空、首尾空白会被裁掉
  assert.equal(normalizeVisionConfig({}).webProject, '')
  assert.equal(normalizeVisionConfig({ webProject: '  甲鱼乙豆  ' }).webProject, '甲鱼乙豆')

  // 未知协议仍然回落到 base
  assert.equal(normalizeVisionConfig({ protocol: 'web-nope' }).protocol, 'auto')
})

test('配置：等回答的预算有下限（配 10 秒也给 15 秒）', () => {
  assert.equal(answerBudgetMs(10_000), 15_000)
  assert.equal(answerBudgetMs(60_000), 60_000)
  assert.equal(answerBudgetMs(Number.NaN), 15_000)
})

test('配置：白嫖豆包 / 站点 / 模式 都能规整', () => {
  const config = normalizeVisionConfig({ freeDoubao: true, webSite: 'gemini', mode: 'composite', webHeadless: false, webProject: '  甲鱼乙豆  ' })
  assert.equal(config.freeDoubao, true)
  assert.equal(config.webSite, 'gemini')
  assert.equal(config.mode, 'composite')
  assert.equal(config.webHeadless, false)
  assert.equal(config.webProject, '甲鱼乙豆')

  // 默认：不白嫖、站点豆包、单一模式；脏值回落
  assert.equal(normalizeVisionConfig({}).freeDoubao, false)
  assert.equal(normalizeVisionConfig({}).webSite, 'doubao')
  assert.equal(normalizeVisionConfig({}).mode, 'single')
  assert.equal(normalizeVisionConfig({ webSite: 'nope' }).webSite, 'doubao')
  assert.equal(normalizeVisionConfig({ mode: 'both' }).mode, 'single')

  // 旧配置迁移：protocol 里的 web-* 挪到 freeDoubao + webSite，protocol 回到 auto
  const legacy = normalizeVisionConfig({ protocol: 'web-gemini' })
  assert.equal(legacy.freeDoubao, true)
  assert.equal(legacy.webSite, 'gemini')
  assert.equal(legacy.protocol, 'auto')
  assert.equal(normalizeVisionConfig({ protocol: 'web-doubao' }).webSite, 'doubao')
  // webSiteOf 仍然可用（旧协议 → 站点）
  assert.equal(webSiteOf('web-gemini'), 'gemini')
})

test('计划：单一/复合 决定跑哪几路', () => {
  const single = planRecognition({ ...DEFAULT_VISION_CONFIG, freeDoubao: false })
  assert.deepEqual(single, { webSite: null, api: true })

  const webOnly = planRecognition({ ...DEFAULT_VISION_CONFIG, freeDoubao: true, mode: 'single' })
  assert.deepEqual(webOnly, { webSite: 'doubao', api: false })

  const both = planRecognition({ ...DEFAULT_VISION_CONFIG, freeDoubao: true, mode: 'composite' })
  assert.deepEqual(both, { webSite: 'doubao', api: true })

  const geminiBoth = planRecognition({ ...DEFAULT_VISION_CONFIG, freeDoubao: true, webSite: 'gemini', mode: 'composite' })
  assert.deepEqual(geminiBoth, { webSite: 'gemini', api: true })
})

test('合并：两路都成 ⇒ 带来源标注；一路成 ⇒ 附失败原因；全败 ⇒ 抛错', () => {
  const both = composeRecognition([
    { label: '网页版豆包', result: { ok: true, text: '网页描述' } },
    { label: '外挂模型（m1）', result: { ok: true, text: 'API 描述' } },
  ])
  assert.match(both, /【网页版豆包】/)
  assert.match(both, /【外挂模型（m1）】/)
  assert.ok(both.indexOf('网页描述') < both.indexOf('API 描述'))

  const oneWeb = composeRecognition([
    { label: '网页版豆包', result: { ok: true, text: '网页描述' } },
    { label: '外挂模型（m1）', result: { ok: false, error: '缺 key' } },
  ])
  assert.match(oneWeb, /^网页描述/)
  assert.match(oneWeb, /另一路没成.*缺 key/)

  const oneApi = composeRecognition([
    { label: '网页版豆包', result: { ok: false, error: '没登录' } },
    { label: '外挂模型（m1）', result: { ok: true, text: 'API 描述' } },
  ])
  assert.match(oneApi, /^API 描述/)
  assert.match(oneApi, /没登录/)

  assert.throws(
    () => composeRecognition([
      { label: '网页版豆包', result: { ok: false, error: '没登录' } },
      { label: '外挂模型（m1）', result: { ok: false, error: '缺 key' } },
    ]),
    (error: unknown) => error instanceof VisionError && /两路都失败/.test(error.message) && /没登录/.test(error.message) && /缺 key/.test(error.message),
  )
})

test('复合：两路并行都跑，结果按来源合并（网页桩 + fetch 桩）', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'API 描述' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    const config = normalizeVisionConfig({
      enabled: true,
      freeDoubao: true,
      mode: 'composite',
      apiKey: 'sk-test',
      apiBase: 'https://api.openai.com/v1',
      model: 'm1',
      protocol: 'openai-chat',
    })
    let webCalls = 0
    const text = await runRecognition(
      config,
      { base64: Buffer.from('fake').toString('base64'), mime: 'image/png' },
      { dshHome: tmpdir(), webRecognize: async () => { webCalls += 1; return '网页描述' } },
    )
    assert.equal(webCalls, 1)
    assert.match(text, /【网页版豆包】/)
    assert.match(text, /【外挂模型（m1）】/)
    assert.ok(text.indexOf('网页描述') < text.indexOf('API 描述'))
  } finally {
    globalThis.fetch = original
  }
})

test('复合：API 那路没有 key ⇒ 网页版结果照用，并注明另一路失败', async () => {
  const config = normalizeVisionConfig({ enabled: true, freeDoubao: true, mode: 'composite' })
  const text = await runRecognition(
    config,
    { base64: Buffer.from('fake').toString('base64'), mime: 'image/png' },
    { dshHome: tmpdir(), webRecognize: async () => '网页描述' },
  )
  assert.match(text, /^网页描述/)
  assert.match(text, /另一路没成/)
  assert.match(text, /API Key/i)
})

test('单一 + 白嫖豆包 ⇒ 只走网页版，一次都不碰 API', async () => {
  const original = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('不该被调用') }) as typeof fetch
  try {
    const config = normalizeVisionConfig({ enabled: true, freeDoubao: true, mode: 'single', apiKey: 'sk-test' })
    const text = await runRecognition(
      config,
      { base64: Buffer.from('fake').toString('base64'), mime: 'image/png' },
      { dshHome: tmpdir(), webRecognize: async () => '网页描述' },
    )
    assert.equal(text.trim(), '网页描述')
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('登录会话：进站点后必须把窗口顶到前台（否则用户以为"什么都没弹"）', async () => {
  const client = fakeClient({ loggedIn: true })
  const result = await runLoginSession(client, 'doubao' as never, { waitMs: 5_000 })
  assert.equal(result.loggedIn, true)
  const order = client.calls.filter((call) => call.startsWith('goto:') || call === 'bringToFront')
  assert.ok(order.length >= 2, `至少要 goto + bringToFront：${order.join(' → ')}`)
  assert.equal(order[0]?.startsWith('goto:'), true)
  assert.equal(order[1], 'bringToFront')
  // 登录后还会再顶一次（用户可能接着在新页面操作）
  assert.ok(client.calls.filter((call) => call === 'bringToFront').length >= 2)
})

test('清 profile 占用：目录不存在时直接返回 0（不跑进程扫描）', async () => {
  const killed = await killBrowsersUsingProfile(path.join(tmpdir(), 'dafeiyu-no-such-profile'), () => undefined)
  assert.equal(killed, 0)
})

test('落盘：临时图片按 mime 取扩展名、内容是真的 base64 解出来的', () => {
  const file = writeTempImage(IMAGE.base64, 'image/jpeg')
  try {
    assert.ok(file.endsWith('.jpg'))
    assert.equal(readFileSync(file).toString('utf8'), 'fake-png-bytes')
  } finally {
    rmSync(file, { force: true })
  }
  assert.ok(writeTempImage(IMAGE.base64, 'image/webp').endsWith('.webp'))
})

// ── 流程面（假 CDP）────────────────────────────────────────────────────────

test('豆包：未登录 ⇒ 401 且告诉用户怎么登，不去打字', async () => {
  const client = fakeClient({ loggedIn: false })
  await assert.rejects(
    () => askSite(client, DOUBAO, { ...IMAGE, prompt: '看图', timeoutMs: 20_000 }),
    (error: unknown) => {
      assert.ok(error instanceof VisionError)
      assert.equal(error.status, 401)
      assert.match(error.message, /没有登录/)
      assert.match(error.message, /登录 豆包/)
      return true
    },
  )
  assert.equal(client.insertedText, '')
  assert.equal(client.files.length, 0)
})

test('豆包：上传 → 打字 → 回车 → 抽回答', async () => {
  const client = fakeClient({ loggedIn: true })
  const result = await askSite(client, DOUBAO, { ...IMAGE, prompt: '这张图里有什么？', timeoutMs: 20_000 })
  assert.match(result.text, /BANANA-4271/)
  assert.equal(result.truncated, false)
  assert.equal(client.insertedText, '这张图里有什么？')
  // 真的把图片文件塞进了 file input
  assert.equal(client.files.length, 1)
  // 点了上传、打了字、发了回车
  assert.ok(client.calls.some((c) => c.startsWith('call:DOM.setFileInputFiles')))
  assert.ok(client.calls.some((c) => c.includes('upload_file_button')))
  assert.equal(client.calls.filter((c) => c === 'call:Input.dispatchKeyEvent').length, 2) // rawKeyDown + keyUp
})

test('豆包：上传卡在进度里也不无限等（超时不抛，继续走）', async () => {
  const client = fakeClient({ loggedIn: true, uploading: true })
  const result = await askSite(client, DOUBAO, { ...IMAGE, prompt: '看图', timeoutMs: 20_000 })
  assert.match(result.text, /RED CIRCLE/)
})

test('上传入口消失（前端改版）⇒ 报「找不到上传入口」而不是空转', async () => {
  const client = fakeClient({ loggedIn: true, noUploadButton: true })
  await assert.rejects(
    () => askSite(client, GEMINI, { ...IMAGE, prompt: '看图', timeoutMs: 20_000 }),
    (error: unknown) => {
      assert.ok(error instanceof VisionError)
      assert.match(error.message, /找不到上传入口|前端可能改版/)
      return true
    },
  )
})

test('Gemini：登录探针在未登录时返回 false', async () => {
  const client = fakeClient({ loggedIn: false })
  const probe = await probeLogin(client, GEMINI)
  assert.equal(probe.loggedIn, false)
  const ok = await probeLogin(fakeClient({ loggedIn: true }), GEMINI)
  assert.equal(ok.loggedIn, true)
})

test('项目：给了项目名 ⇒ 点 chip → 选项目 → 确认 chip 变成项目名', async () => {
  const client = fakeClient({ loggedIn: true })
  const result = await askSite(client, DOUBAO, { ...IMAGE, prompt: '看图', timeoutMs: 20_000, project: '甲鱼乙豆' })
  assert.match(result.text, /RED CIRCLE/)
  // 点过 chip（含 scrollIntoView 的取坐标调用）并且点过弹层里的项目项
  assert.ok(client.calls.includes('click:chip'))
  assert.ok(client.calls.includes('click:item'))
  assert.ok(client.calls.some((c) => c.includes('甲鱼乙豆')))
})

test('项目：项目名不存在 ⇒ 明确报错，不偷偷发到「最近」里', async () => {
  const client = fakeClient({ loggedIn: true, noProject: true })
  await assert.rejects(
    () => askSite(client, DOUBAO, { ...IMAGE, prompt: '看图', timeoutMs: 20_000, project: '不存在的项目' }),
    (error: unknown) => {
      assert.ok(error instanceof VisionError)
      assert.match(error.message, /切不到项目「不存在的项目」/)
      return true
    },
  )
  assert.equal(client.insertedText, '')
})

test('项目：Gemini 没有项目能力，传了也不点（不报错、不空转）', async () => {
  const client = fakeClient({ loggedIn: true })
  const result = await askSite(client, GEMINI, { ...IMAGE, prompt: '看图', timeoutMs: 20_000, project: '甲鱼乙豆' })
  assert.match(result.text, /RED CIRCLE/)
  // 没有去点任何「项目 chip」
  assert.equal(client.calls.some((c) => c.includes('scrollIntoView')), false)
})

test('路由常量：浏览器面与宿主面逐字一致（拼出来的常量在产物里找不到）', () => {
  const source = readFileSync(new URL('../../src/client/host-api.ts', import.meta.url), 'utf8')
  for (const route of [VISION_RECOGNIZE_ROUTE, VISION_WEB_STATUS_ROUTE, VISION_WEB_LOGIN_ROUTE]) {
    assert.ok(source.includes(`'${route}'`), `浏览器面缺这条路由字面量：${route}`)
  }
})
