/**
 * client-perf.test —— 客户端常驻开销的判据（2026-11-17）。
 *
 * 真机反馈 DSH 开着就一直在跑：入口收起的同步原来是每秒一次的 setInterval，
 * 从页面打开转到插件卸载。本体 0.9.0-dafeiyu.103 已为同一件事改过口径，本包对齐。
 *
 * 为什么用读源码形状这种判据：行为测试里两种实现都会正确收起，测不出来；
 * 而「多了一个每秒节拍」恰恰是最容易在后续重构里悄悄长回来的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_MAIN = fileURLToPath(new URL('../../src/client/main.ts', import.meta.url))

test('入口可见性靠事件 + DOM 观察同步，不许回到每秒定时器', () => {
  const source = readFileSync(CLIENT_MAIN, 'utf8')
  assert.ok(
    !/setInterval\(\s*syncFabVisibility/.test(source),
    '不许再用 setInterval 每秒同步入口可见性：DSH 开着一天它就转一天',
  )
  assert.ok(!/let fabTimer/.test(source), 'fabTimer 应当已经删掉（清理也跟着它走）')
  assert.ok(source.includes('watchFabVisibility('), '必须走 watchFabVisibility（事件 + MutationObserver）')
  assert.ok(source.includes('dafeiyu:rooms-ready'), '形象晚于本包挂载时要能补一次')
  assert.ok(source.includes('MutationObserver'), '形象小窗被移除/重建时要能补一次')
})