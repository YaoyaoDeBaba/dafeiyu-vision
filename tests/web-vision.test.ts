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
  isWebProtocol,
  normalizeVisionConfig,
  resolveProtocol,
  webSiteOf,
} from '../src/vision/config.js'
import { VisionError } from '../src/vision/protocols.js'
import {
  VISION_RECOGNIZE_ROUTE,
  VISION_WEB_LOGIN_ROUTE,
  VISION_WEB_STATUS_ROUTE,
} from '../src/vision/routes.js'
import type { CdpClient } from '../src/vision/web/driver.js'
import { askSite, answerBudgetMs, DOUBAO, GEMINI, probeLogin, writeTempImage } from '../src/vision/web/sites.js'

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

test('配置：网页版协议被接受，且不吃 key', () => {
  const config = normalizeVisionConfig({ protocol: 'web-doubao', webHeadless: false })
  assert.equal(config.protocol, 'web-doubao')
  assert.equal(config.webHeadless, false)
  assert.equal(isWebProtocol(resolveProtocol(config)), true)
  assert.equal(webSiteOf('web-gemini'), 'gemini')

  // 默认无头；脏值回落
  assert.equal(normalizeVisionConfig({}).webHeadless, DEFAULT_VISION_CONFIG.webHeadless)
  assert.equal(normalizeVisionConfig({ webHeadless: 'yes' }).webHeadless, DEFAULT_VISION_CONFIG.webHeadless)

  // 未知协议仍然回落到 base
  assert.equal(normalizeVisionConfig({ protocol: 'web-nope' }).protocol, 'auto')
})

test('配置：等回答的预算有下限（配 10 秒也给 15 秒）', () => {
  assert.equal(answerBudgetMs(10_000), 15_000)
  assert.equal(answerBudgetMs(60_000), 60_000)
  assert.equal(answerBudgetMs(Number.NaN), 15_000)
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

test('路由常量：浏览器面与宿主面逐字一致（拼出来的常量在产物里找不到）', () => {
  const source = readFileSync(new URL('../../src/client/host-api.ts', import.meta.url), 'utf8')
  for (const route of [VISION_RECOGNIZE_ROUTE, VISION_WEB_STATUS_ROUTE, VISION_WEB_LOGIN_ROUTE]) {
    assert.ok(source.includes(`'${route}'`), `浏览器面缺这条路由字面量：${route}`)
  }
})
