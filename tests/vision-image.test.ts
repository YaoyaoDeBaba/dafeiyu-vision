/**
 * 网页版生图（`src/vision/web/image.ts`）的判据。
 *
 * 不起浏览器：`generateImages` 只认 `CdpClient` 形状，假客户端就能把
 * 「切技能 → 打字 → 发送 → 认出图 → 下载落盘」整条链钉死。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateImages, imageOutDir, switchToImageSkill } from '../src/vision/web/image.js'
import { DOUBAO } from '../src/vision/web/sites.js'
import type { CdpClient } from '../src/vision/web/driver.js'
import { VisionError } from '../src/vision/protocols.js'

/** 1x1 透明 PNG 的 base64 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface ImageFakeOptions {
  /** 有没有「图像生成」chip（false = 只能在「技能」菜单里找到） */
  chip?: boolean
  /** 「技能」菜单里有没有图像生成（false = 什么都没有） */
  menu?: boolean
  /** 生成几张（0 = 不出图） */
  images?: number
  /** 下载是否失败 */
  downloadFails?: boolean
}

function fakeImageClient(options: ImageFakeOptions = {}) {
  const calls: string[] = []
  let sentText = ''
  const imageCount = options.images ?? 1

  const evaluate = async (expression: string): Promise<unknown> => {
    calls.push(expression.slice(0, 220))
    // clickExpression 取坐标（按表达式特征区分三种目标）
    if (expression.includes('scrollIntoView')) {
      if (expression.includes('menuitem')) return options.menu === false ? null : { x: 5, y: 5 } // 「技能」菜单里的项
      if (expression.includes('图像生成')) return options.chip === false ? null : { x: 5, y: 5 } // chip
      return { x: 5, y: 5 } // 技能按钮 / 发送按钮 / 其它
    }
    if (expression.includes("execCommand('insertText'")) {
      const match = /execCommand\('insertText', false, (".*?")\)/.exec(expression)
      if (match && typeof match[1] === 'string') sentText = JSON.parse(match[1]) as string
      return true
    }
    if (expression.includes("execCommand('delete'")) return true
    // 发送后输入框变空
    if (expression.includes('.ProseMirror') && expression.includes("trim() === ''")) return true
    // 读生成图
    if (expression.includes('naturalWidth')) {
      return Array.from({ length: imageCount }, (_v, i) => ({ src: `https://cdn.test/gen-${i}.png`, w: 1024, h: 1024 }))
    }
    // 下载
    if (expression.includes('btoa(')) return options.downloadFails ? '' : TINY_PNG
    return true
  }

  const client = {
    port: 0,
    calls,
    get sentText() {
      return sentText
    },
    evaluate: evaluate as CdpClient['evaluate'],
    async call(method: string) {
      calls.push(`call:${method}`)
      return {} as never
    },
    async goto() {},
    async bringToFront() {},
    async screenshot() {},
    async close() {},
  }
  return client
}

test('生图：切技能 → 打字 → 发送 → 认出图 → 下载落盘', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dafeiyu-gen-'))
  try {
    const client = fakeImageClient({ chip: true, images: 1 })
    const result = await generateImages(client, DOUBAO, outDir, {
      prompt: '一只戴红帽的蓝色小鲸鱼',
      settleMs: 30,
      timeoutMs: 4_000,
    })
    assert.equal(result.via, 'chip')
    assert.equal(result.files.length, 1)
    assert.ok(existsSync(result.files[0] ?? ''))
    assert.equal(readFileSync(result.files[0] ?? '').toString('base64'), TINY_PNG)
    assert.equal(client.sentText, '一只戴红帽的蓝色小鲸鱼')
    // 点的顺序：先切技能，再点发送
    assert.ok(client.calls.some((call) => call.includes('图像生成')))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('生图：chip 折叠时从「技能」菜单里切（窄窗口）', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dafeiyu-gen-menu-'))
  try {
    const client = fakeImageClient({ chip: false, menu: true, images: 1 })
    const via = await switchToImageSkill(client, DOUBAO)
    assert.equal(via, 'menu')
    const result = await generateImages(client, DOUBAO, outDir, { prompt: 'x', settleMs: 30, timeoutMs: 4_000 })
    assert.equal(result.files.length, 1)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('生图：找不到「图像生成」入口 ⇒ 明确报错（不空转）', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dafeiyu-gen-none-'))
  try {
    const client = fakeImageClient({ chip: false, menu: false })
    await assert.rejects(
      () => generateImages(client, DOUBAO, outDir, { prompt: 'x', settleMs: 30, timeoutMs: 3_000 }),
      (error: unknown) => {
        assert.ok(error instanceof VisionError)
        assert.match(error.message, /找不到「图像生成」入口/)
        return true
      },
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('生图：一张都没出 ⇒ 报「没有出图」并带上页面尾部', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dafeiyu-gen-empty-'))
  try {
    const client = fakeImageClient({ chip: true, images: 0 })
    await assert.rejects(
      () => generateImages(client, DOUBAO, outDir, { prompt: 'x', settleMs: 30, timeoutMs: 2_000 }),
      /没有出图/,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('生图：出了图但下载全失败 ⇒ 报「一张都没下载下来」', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'dafeiyu-gen-dl-'))
  try {
    const client = fakeImageClient({ chip: true, images: 2, downloadFails: true })
    await assert.rejects(
      () => generateImages(client, DOUBAO, outDir, { prompt: 'x', settleMs: 30, timeoutMs: 4_000 }),
      /一张都没下载下来/,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('生图：空提示词直接拒', async () => {
  const client = fakeImageClient({ chip: true })
  await assert.rejects(() => generateImages(client, DOUBAO, tmpdir(), { prompt: '   ' }), /需要提示词/)
})

test('生图：落盘目录固定在 <dshHome>/storages/.../webvision-images', () => {
  const dir = imageOutDir('C:\\Users\\x\\.dsh')
  assert.equal(dir, path.join('C:\\Users\\x\\.dsh', 'storages', 'dsh-remote-dafeiyu', 'webvision-images'))
})
