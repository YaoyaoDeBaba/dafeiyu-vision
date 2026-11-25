/**
 * xyq-channel.test —— 「生成通道」抽象（云雀 / 即梦）的判据。
 *
 * 全进程内：`run` 是注入的假执行器，**不真跑 CLI、不联网络**。
 * 钉的六件事：
 *   ① 不传 channel ⇒ 与改动前一模一样（假执行器收到的参数不变，且绝不碰即梦）；
 *   ② channel=jimeng ⇒ 走即梦实现：args[0] 是**绝对路径**，参数按即梦 CLI 的写法拼；
 *   ③ 即梦 CLI 没装 ⇒ 只有这条通道 unavailable（probe + 一行中文日志），云雀照常出片；
 *   ④ 缺必填参数 / channel 传错 ⇒ 中文报错、不抛栈；
 *   ⑤ 余额输出两条通道各一段；
 *   ⑥ 即梦未登录 ⇒ 给的是「能照着敲的命令」，不是一句错误码。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createXyqService } from '../src/xyq/service.js'
import { normalizeXyqConfig } from '../src/xyq/config.js'
import { createJimengService } from '../src/xyq/jimeng/service.js'
import { locateJimengCli } from '../src/xyq/jimeng/cli.js'
import { normalizeChannelId } from '../src/xyq/channel.js'
import { xyqTools } from '../src/xyq/tools.js'
import { startXyq } from '../src/xyq/start.js'
import type { CliRunner } from '../src/xyq/cli.js'

const NOVEL = 'C:/jimeng/bin/jimeng-novel.exe'
const OUT_DIR = 'D:/out/jimeng'

type Reply = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean }
type Queue = Record<string, Reply | Reply[]>

function takeFrom(queues: Map<string, Reply[]>, key: string): Reply {
  const queue = queues.get(key)
  if (queue !== undefined && queue.length > 0) return queue.shift()!
  return { code: 0, stdout: '', stderr: '', timedOut: false }
}

function toQueues(map: Queue): Map<string, Reply[]> {
  const queues = new Map<string, Reply[]>()
  for (const [key, value] of Object.entries(map)) queues.set(key, Array.isArray(value) ? [...value] : [value])
  return queues
}

function okEnvelope(data: unknown): Reply {
  return { code: 0, stdout: JSON.stringify({ status: 'ok', data }), stderr: '', timedOut: false }
}

interface HarnessInit { installed?: boolean; xyq?: Queue; jimeng?: Queue }

function makeHarness(init: HarnessInit = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-chan-'))
  const configFile = path.join(dir, 'xyq.json')
  writeFileSync(configFile, JSON.stringify({ accessKey: 'ak-test' }), 'utf8')
  const xyqCalls: string[][] = []
  const jimengCalls: string[][] = []
  const xyqQueues = toQueues(init.xyq ?? {})
  const jimengQueues = toQueues(init.jimeng ?? {})

  const xyqRun: CliRunner = async (args) => {
    xyqCalls.push(args)
    const reply = takeFrom(xyqQueues, args[1] ?? '')
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', timedOut: reply.timedOut ?? false }
  }
  const jimengRun: CliRunner = async (args) => {
    jimengCalls.push(args)
    const reply = takeFrom(jimengQueues, args[1] ?? '')
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', timedOut: reply.timedOut ?? false }
  }

  const jimeng = createJimengService({
    run: jimengRun,
    locate: () => (init.installed === false ? {} : { novel: NOVEL }),
    outDir: OUT_DIR,
    waitImageSec: 5,
    waitVideoSec: 5,
  })
  const service = createXyqService({
    configFile,
    run: xyqRun,
    resolveCli: async () => 'cli',
    channels: { jimeng },
    sleep: async () => undefined,
    pollIntervalMs: 0,
    videoTimeoutMs: 5_000,
    imageTimeoutMs: 5_000,
    log: () => {},
  })
  return { service, jimeng, xyqCalls, jimengCalls, configFile, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const XYQ_VIDEO_OK: Queue = {
  'generate-video': { stdout: JSON.stringify({ thread_id: 't1', run_id: 'r1' }) },
  'query-result': { stdout: JSON.stringify({ status: 'succeeded', videos: [{ output_path: 'D:/out/a.mp4' }] }) },
}

test('① 默认 channel=xyq：参数与改动前一致，且绝不碰即梦', async () => {
  const h = makeHarness({ xyq: XYQ_VIDEO_OK })
  try {
    const result = await h.service.generateVideo({ prompt: '鲸鱼娘待机', duration: 4, ratio: '1:1', images: ['D:/ref.png'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.files, ['D:/out/a.mp4'])
    const call = h.xyqCalls.find((args) => args[1] === 'generate-video')!
    assert.equal(call[0], 'cli', '云雀仍然按 resolveCli 拿到的路径跑')
    assert.equal(call[call.indexOf('--model') + 1], 'Seedance_2.0_mini_lite')
    assert.equal(call[call.indexOf('--task-type') + 1], 'reference', '改动前就有的参数必须还在')
    assert.equal(call[call.indexOf('--duration') + 1], '4')
    assert.equal(h.jimengCalls.length, 0, '默认通道不许调即梦')
  } finally {
    h.cleanup()
  }
})

test('① 显式 channel=xyq 与不传等价（老调用写不写都一样）', async () => {
  const twice: Queue = {
    'generate-video': [
      { stdout: JSON.stringify({ thread_id: 't1', run_id: 'r1' }) },
      { stdout: JSON.stringify({ thread_id: 't2', run_id: 'r2' }) },
    ],
    'query-result': [
      { stdout: JSON.stringify({ status: 'succeeded', videos: [{ output_path: 'D:/out/a.mp4' }] }) },
      { stdout: JSON.stringify({ status: 'succeeded', videos: [{ output_path: 'D:/out/a.mp4' }] }) },
    ],
  }
  const h = makeHarness({ xyq: twice })
  try {
    const a = await h.service.generateVideo({ prompt: 'x' })
    const first = h.xyqCalls[0]!.join(' ')
    h.xyqCalls.length = 0
    const b = await h.service.generateVideo({ prompt: 'x', channel: 'xyq' })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(h.xyqCalls[0]!.join(' '), first, 'channel=xyq 与缺省必须逐字相同')
    assert.equal(h.jimengCalls.length, 0)
  } finally {
    h.cleanup()
  }
})

test('② channel=jimeng：绝对路径 spawn + 即梦参数拼装 + 产物路径回传', async () => {
  const h = makeHarness({
    jimeng: {
      'generate-video': okEnvelope({ status: 'succeeded', thread_id: 'j1', run_id: 'j2', items: [{ output_path: 'D:/out/jimeng/E01/S01.mp4' }] }),
      'generate-image': okEnvelope({ status: 'succeeded', items: [{ output_path: 'D:/out/jimeng/cast/whale.png' }] }),
    },
  })
  try {
    const video = await h.service.generateVideo({
      prompt: '镜头一：鲸鱼娘转身',
      model: 'seedance_2.0',
      duration: 5,
      images: ['D:/cast/whale.png'],
      channel: 'jimeng',
    })
    assert.equal(video.ok, true)
    assert.deepEqual(video.files, ['D:/out/jimeng/E01/S01.mp4'])
    assert.equal(h.xyqCalls.length, 0, '选了即梦就不许偷偷走云雀')
    // 自愈会先跑一趟 credit get（判登录态），所以按子命令找，别按下标
    const call = h.jimengCalls.find((args) => args[1] === 'generate-video')!
    assert.equal(call[0], NOVEL, '必须用绝对路径（安装器不进 PATH）')
    assert.equal(call[1], 'generate-video')
    assert.equal(call[call.indexOf('--model') + 1], 'seedance_2.0')
    assert.equal(call[call.indexOf('--prompt') + 1], '镜头一：鲸鱼娘转身')
    assert.equal(call[call.indexOf('--duration') + 1], '5')
    assert.equal(call[call.indexOf('--image') + 1], 'D:/cast/whale.png')
    assert.ok(call[call.indexOf('--out') + 1]!.startsWith(OUT_DIR), '产物目录要是传递进来的那个')
    assert.equal(call.at(-1), '-j', '没有 -j 就没有 JSON 信封')

    const image = await h.service.generateImage({ prompt: '角色三视图', model: 'seedream_5.5', count: 2, channel: 'jimeng' })
    assert.equal(image.ok, true)
    assert.deepEqual(image.files, ['D:/out/jimeng/cast/whale.png'])
    const imageCall = h.jimengCalls.find((args) => args[1] === 'generate-image')!
    assert.equal(imageCall[1], 'generate-image')
    assert.equal(imageCall[imageCall.indexOf('--generate-image-count') + 1], '2')
  } finally {
    h.cleanup()
  }
})

test('③ 即梦 CLI 没装：只有该通道 unavailable，云雀照常可用', async () => {
  const h = makeHarness({ installed: false, xyq: XYQ_VIDEO_OK })
  try {
    const probe = await h.jimeng.probe()
    assert.equal(probe.available, false)
    assert.match(probe.available ? '' : probe.reason, /没找到即梦 CLI/)

    // 这一条只验「不可用就明确报」：自动安装这层由 xyq-selfheal.test 单独钉，这里关掉避免联网语义混进来
    const blocked = await h.service.generateImage({
      prompt: 'x',
      model: 'seedream_5.5',
      channel: 'jimeng',
      autoInstall: false,
    })
    assert.equal(blocked.ok, false)
    assert.match(String(blocked.message), /没找到即梦 CLI/)
    assert.match(String(blocked.message), /手工安装/, '要给出安装命令，不能只说不可用')
    assert.equal(h.jimengCalls.length, 0, '没装就不该去 spawn')

    const cloud = await h.service.generateVideo({ prompt: '云雀照跑' })
    assert.equal(cloud.ok, true, '即梦挂了不许影响云雀')
  } finally {
    h.cleanup()
  }
})

test('③ start.ts：不可用只写 probe + 一行中文日志，路由/工具照挂', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-start-'))
  const logs: string[] = []
  const handle = startXyq(
    { get: () => undefined } as never,
    {
      dshHome: dir,
      log: (message) => logs.push(message),
      jimengChannel: {
        id: 'jimeng',
        label: '即梦',
        probe: async () => ({ id: 'jimeng', label: '即梦', available: false, reason: '没找到即梦 CLI（jimeng-novel）' }),
        generateImage: async () => ({ ok: false, message: '不应被调用' }),
        generateVideo: async () => ({ ok: false, message: '不应被调用' }),
        balance: async () => ({ ok: false, message: '不应被调用' }),
        models: async () => ({ ok: false, message: '不应被调用' }),
      },
    },
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.match(String(handle.probe.jimeng), /^unavailable:/)
    assert.ok(logs.some((line) => line.includes('即梦通道不可用')), '必须留一行看得懂的中文日志')
  } finally {
    handle.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ 缺必填参数 / channel 传错：中文报错、不抛栈', async () => {
  const h = makeHarness()
  try {
    const tools = xyqTools(h.service) as Array<Record<string, unknown>>
    const imageTool = tools.find((tool) => tool.name === 'generate_image') as { execute: (args: unknown, exec?: unknown) => Promise<string> }
    const videoTool = tools.find((tool) => tool.name === 'generate_video') as { execute: (args: unknown, exec?: unknown) => Promise<string> }

    await assert.rejects(imageTool.execute({ prompt: '   ' }), (error: Error) => {
      assert.match(error.message, /需要 prompt/, '要中文说明缺什么')
      assert.equal(/\n\s+at /.test(error.message), false, '不许把调用栈当错误信息')
      return true
    })

    await assert.rejects(imageTool.execute({ prompt: '画一只鲸鱼', channel: 'kuake' }), (error: Error) => {
      assert.match(error.message, /channel 只能是 xyq \/ jimeng/)
      return true
    })

    await assert.rejects(videoTool.execute({ prompt: '一条视频', channel: 123 }), (error: Error) => {
      assert.match(error.message, /channel 只能是/)
      return true
    })

    const jimengNoModel = await h.service.generateImage({ prompt: '画一只鲸鱼', channel: 'jimeng' })
    assert.equal(jimengNoModel.ok, false)
    assert.match(String(jimengNoModel.message), /没指定即梦图片模型/)
    assert.match(String(jimengNoModel.message), /model list --type image/, '要告诉用户去哪查模型名')
  } finally {
    h.cleanup()
  }
})

test('⑤ 余额：两条通道各一段（一条不可用不影响另一条）', async () => {
  const h = makeHarness({
    xyq: {
      'get-credit-balance': [
        { stdout: JSON.stringify({ total_remain_amount: '275' }) },
        { stdout: JSON.stringify({ total_remain_amount: '275' }) },
      ],
    },
    // 每次 balanceAll：自愈读登录态（credit get）+ 真要余额（credit get）= 2 次；两次调用给 4 份
    jimeng: {
      credit: [
        okEnvelope({ balance: 1234 }),
        okEnvelope({ balance: 1234 }),
        okEnvelope({ balance: 1234 }),
        okEnvelope({ balance: 1234 }),
      ],
    },
  })
  try {
    const rows = await h.service.balanceAll()
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.id, 'xyq')
    assert.equal(rows[0]!.totalRemain, '275')
    assert.equal(rows[1]!.id, 'jimeng')
    assert.equal(rows[1]!.totalRemain, '1234')

    const tools = xyqTools(h.service) as Array<Record<string, unknown>>
    const balanceTool = tools.find((tool) => tool.name === 'xyq_balance') as { execute: (args: unknown) => Promise<string> }
    const text = await balanceTool.execute({})
    assert.match(text, /小云雀：剩余 275/)
    assert.match(text, /即梦：剩余 1234/)
  } finally {
    h.cleanup()
  }
})

test('⑤ 余额：即梦没装时那一段写原因，云雀那段照常', async () => {
  const h = makeHarness({ installed: false, xyq: { 'get-credit-balance': { stdout: JSON.stringify({ total_remain_amount: '88' }) } } })
  try {
    const rows = await h.service.balanceAll({ autoInstall: false })
    assert.equal(rows[0]!.ok, true)
    assert.equal(rows[0]!.totalRemain, '88')
    assert.equal(rows[1]!.ok, false)
    assert.match(String(rows[1]!.message), /没找到即梦 CLI/)
  } finally {
    h.cleanup()
  }
})

test('⑥ 即梦未登录：给的是能照着敲的命令（含绝对路径），不是错误码', async () => {
  const h = makeHarness({
    jimeng: {
      'generate-image': {
        code: 0,
        stdout: JSON.stringify({
          status: 'error',
          data: null,
          error: { code: 'AUTH_FAILED', message: '获取用户信息失败', hint: '执行 jimeng-novel login --non-interactive' },
        }),
      },
    },
  })
  try {
    const result = await h.service.generateImage({ prompt: '画一只鲸鱼', model: 'seedream_5.5', channel: 'jimeng' })
    assert.equal(result.ok, false)
    assert.match(String(result.message), /还没登录/)
    assert.match(String(result.message), /login --non-interactive/)
    assert.ok(String(result.message).includes(NOVEL), '命令里必须是绝对路径，用户能直接复制')
  } finally {
    h.cleanup()
  }
})

test('通道寻址：缺省/空串 → xyq，不认识 → undefined（给中文报错，不回落）', () => {
  assert.equal(normalizeChannelId(undefined), 'xyq')
  assert.equal(normalizeChannelId(''), 'xyq')
  assert.equal(normalizeChannelId('xyq'), 'xyq')
  assert.equal(normalizeChannelId(' jimeng '), 'jimeng')
  assert.equal(normalizeChannelId('kuake'), undefined)
  assert.equal(normalizeChannelId(1), undefined)
})

test('即梦 CLI 定位：官方默认落点优先，环境变量可覆盖，都没有就 undefined', () => {
  const releasesRoot = path.join('/home/u', '.local', 'share', 'jimeng-novel', 'releases')
  const release = path.join(releasesRoot, 'jimeng-novel-1.0.11-windows-amd64-abc', 'jimeng-novel.exe')
  const old = path.join(releasesRoot, 'jimeng-novel-1.0.9-windows-amd64-def', 'jimeng-novel.exe')
  const found = locateJimengCli({
    env: {},
    home: '/home/u',
    platform: 'win32',
    exists: (file) => file === release || file === old,
    listDir: (dir) => (dir.includes('releases') ? ['jimeng-novel-1.0.9-windows-amd64-def', 'jimeng-novel-1.0.11-windows-amd64-abc', 'junk'] : []),
  })
  assert.equal(found.novel, release, '要挑版本号最高的那个 release')

  const overridden = locateJimengCli({ env: { JIMENG_NOVEL_CLI: '/opt/n.exe' }, home: '/home/u', platform: 'win32', exists: (f) => f === '/opt/n.exe', listDir: () => [] })
  assert.equal(overridden.novel, '/opt/n.exe', '环境变量优先（排障口子）')

  const none = locateJimengCli({ env: {}, home: '/home/u', platform: 'win32', exists: () => false, listDir: () => [] })
  assert.equal(none.novel, undefined)
})

test('即梦定位：canvas CLI 走 <home>/bin/dreamina-canvas.exe', () => {
  const exe = path.join('/home/u', 'bin', 'dreamina-canvas.exe')
  const found = locateJimengCli({ env: {}, home: '/home/u', platform: 'win32', exists: (f) => f === exe, listDir: () => [] })
  assert.equal(found.canvas, exe)
})

// ── review 补的判据（0.3.0 发版前加）─────────────────────────────────

const XYQ_IMAGE_OK: Queue = {
  'generate-image': { stdout: JSON.stringify({ thread_id: 't1', run_id: 'r1' }) },
  'query-result': { stdout: JSON.stringify({ status: 'succeeded', images: [{ output_path: 'D:/out/i.png' }] }) },
}

test('工具：5 个工具齐全，六个键都硬，xyq_guide 返回注入正文', async () => {
  const h = makeHarness()
  try {
    const body = '# 生成通道（桩）\n\nchannel=xyq / channel=jimeng'
    const tools = xyqTools(h.service, { guideBody: () => body })
    assert.deepEqual(
      tools.map((tool) => String(tool.name)).sort(),
      ['generate_image', 'generate_video', 'xyq_balance', 'xyq_estimate', 'xyq_guide', 'xyq_models'],
    )
    for (const tool of tools) {
      for (const key of ['name', 'description', 'parameters', 'output', 'timeoutMs', 'execute']) {
        assert.ok(key in tool, `${String(tool.name)} 缺 ${key}`)
      }
      const output = tool.output as { schema?: { type?: string }; render?: unknown }
      assert.equal(output.schema?.type, 'string')
      assert.equal(typeof output.render, 'function')
      assert.ok(Number(tool.timeoutMs) > 0)
    }
    const guide = tools.find((tool) => tool.name === 'xyq_guide') as { execute: () => Promise<string> }
    assert.equal(await guide.execute(), body)
  } finally {
    h.cleanup()
  }
})

test('工具：没注入 guideBody 时 xyq_guide 退回内置短版（两条通道都在）', async () => {
  const h = makeHarness()
  try {
    const guide = xyqTools(h.service).find((tool) => tool.name === 'xyq_guide') as { execute: () => Promise<string> }
    const text = await guide.execute()
    assert.match(text, /channel=xyq/)
    assert.match(text, /channel=jimeng/)
    assert.match(text, /xyq_models/)
  } finally {
    h.cleanup()
  }
})

test('工具：多余的参数键要显形（ignored），不许静默吞', async () => {
  const h = makeHarness({ xyq: XYQ_IMAGE_OK })
  try {
    const tools = xyqTools(h.service)
    const imageTool = tools.find((tool) => tool.name === 'generate_image') as {
      execute: (args: Record<string, unknown>, exec?: unknown) => Promise<string>
    }
    const text = await imageTool.execute({ prompt: '画一只鲸鱼', model: 'm', 风格: '扁平' })
    assert.match(text, /生成完成/)
    assert.match(text, /忽略未知参数：风格/)
  } finally {
    h.cleanup()
  }
})

// ── 0.4.0 追加判据（review 补）────────────────────────────────────────

test('产品名：manifest 的 description 写「鲸鱼做梦」，包名/工具名/通道 id 一个字不动', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>
  assert.match(String(pkg.description), /鲸鱼做梦/)
  assert.equal(pkg.name, 'dsh-vision-dafeiyu', '包名不许改')
  const tools = xyqTools(makeHarness().service).map((tool) => String(tool.name))
  assert.deepEqual(tools.sort(), ['generate_image', 'generate_video', 'xyq_balance', 'xyq_estimate', 'xyq_guide', 'xyq_models'], '工具名不许改')
})

test('即梦模型解析：信封字段是 data.models（实测形状），不是 items', async () => {
  const h = makeHarness({
    installed: true,
    jimeng: {
      credit: okEnvelope({ balance: 652 }),
      model: okEnvelope({ models: [{ key: 'seedream_5.5', name: 'Seedream 5.5' }, { key: 'nova_pro', name: '旗舰生图模型 V2-Pro' }], scenes: ['web_novel_canvas'] }),
    },
  })
  try {
    const result = await h.service.models('image', 'jimeng')
    assert.equal(result.ok, true, 'data.models 必须能解析出来（真机就是这个形状）')
    assert.deepEqual(result.models?.map((m) => m.key), ['seedream_5.5', 'nova_pro'])
  } finally {
    h.cleanup()
  }
})

// ── 0.5.0：默认通道（设置页开关）──────────────────────────────────────

test('默认通道：不传 channel 时按设置走——默认 xyq，改成 jimeng 后走即梦', async () => {
  const h = makeHarness({
    xyq: {
      'generate-video': { stdout: JSON.stringify({ thread_id: 't1', run_id: 'r1' }) },
      'query-result': { stdout: JSON.stringify({ status: 'succeeded', videos: [{ output_path: 'D:/out/xyq.mp4' }] }) },
    },
    jimeng: {
      'generate-video': okEnvelope({ files: [{ path: 'D:/out/jimeng.mp4' }] }),
      credit: okEnvelope({ balance: 652 }),
    },
  })
  try {
    // ① 默认：不传 channel ⇒ 云雀（老行为）
    const first = await h.service.generateVideo({ prompt: '第一镜', model: 'Seedance_2.0_mini_lite', duration: 4 })
    assert.equal(first.ok, true)
    assert.equal(h.jimengCalls.length, 0, '默认通道时不许碰即梦')

    // ② 设置页把默认通道改成即梦
    h.service.update({ defaultChannel: 'jimeng' })
    const tools = xyqTools(h.service)
    const videoTool = tools.find((tool) => tool.name === 'generate_video') as {
      execute: (args: Record<string, unknown>) => Promise<string>
    }
    const text = await videoTool.execute({ prompt: '第二镜', model: 'seedance_2.0' })
    assert.match(text, /生成完成/)
    assert.ok(h.jimengCalls.some((args) => args[1] === 'generate-video'), '改成 jimeng 后工具不传 channel 也应走即梦')
  } finally {
    h.cleanup()
  }
})

test('配置：defaultChannel 只认 xyq / jimeng，脏值回落 xyq', () => {
  assert.equal(normalizeXyqConfig({}).defaultChannel, 'xyq')
  assert.equal(normalizeXyqConfig({ defaultChannel: 'jimeng' }).defaultChannel, 'jimeng')
  assert.equal(normalizeXyqConfig({ defaultChannel: 'kuake' }).defaultChannel, 'xyq')
  assert.equal(normalizeXyqConfig({ defaultChannel: 1 }).defaultChannel, 'xyq')
})

// ── 0.10.0：事前报价 xyq_estimate ────────────────────────────────────

test('service.estimate：小云雀如实说没有事前报价接口（不给假数字）', async () => {
  const h = makeHarness()
  try {
    const noQuote = await h.service.estimate({ channel: 'xyq', type: 'image', model: 'x' })
    assert.equal(noQuote.ok, false)
    assert.match(String(noQuote.message), /没有事前报价接口/)
  } finally {
    h.cleanup()
  }
})
test('xyq_estimate：视频报价把 duration 交给通道（视频按秒计价）', async () => {
  const h = makeHarness()
  try {
    let seen: Record<string, unknown> | undefined
    // 只验「工具 → service.estimate」这一层：duration 必须原样传下去（真机 4 秒 76 积分）
    const fakeService = {
      ...h.service,
      estimate: async (input: Record<string, unknown>) => {
        seen = input
        return { ok: true, credits: 76, billedAmount: 4, billedUnit: 'second', modelId: 'Seedance_2.5_flash' }
      },
    }
    const tool = xyqTools(fakeService as never).find((item) => item.name === 'xyq_estimate') as {
      execute: (args: Record<string, unknown>) => Promise<string>
    }
    const text = await tool.execute({ type: 'video', model: 'Seedance_2.5_flash', duration: 4, channel: 'jimeng' })
    assert.match(text, /预计消耗：76 积分/)
    assert.match(text, /按 4 second 计/)
    assert.equal(seen?.duration, 4, 'duration 必须传给通道')
    assert.equal(seen?.model, 'Seedance_2.5_flash')
  } finally {
    h.cleanup()
  }
})

test('xyq_estimate：画布节点走 node quote（传 nodeIds 就不再走 credit estimate）', async () => {
  const h = makeHarness()
  try {
    const tools = xyqTools(h.service, {
      canvas: { quote: async () => ({ ok: true, data: { credits: 9, raw: '{}' } }) } as never,
    })
    const tool = tools.find((item) => item.name === 'xyq_estimate') as { execute: (args: Record<string, unknown>) => Promise<string> }
    const text = await tool.execute({ type: 'image', model: 'seedream_5.5', channel: 'jimeng', canvasId: 'p-1', nodeIds: ['n-1'] })
    assert.match(text, /预计消耗：9 积分/)
    assert.match(text, /画布节点 1 个/)
    assert.equal(h.jimengCalls.length, 0, '画布报价不许再去跑 credit estimate')
  } finally {
    h.cleanup()
  }
})

test('xyq_estimate：小云雀通道没有报价接口 ⇒ 中文说清，不瞎给数字', async () => {
  const h = makeHarness()
  try {
    const tool = xyqTools(h.service).find((item) => item.name === 'xyq_estimate') as { execute: (args: Record<string, unknown>) => Promise<string> }
    await assert.rejects(() => tool.execute({ type: 'image', model: 'x', channel: 'xyq' }), /没有事前报价接口/)
  } finally {
    h.cleanup()
  }
})
test('jimeng.estimate：argv 拼对（credit estimate + --duration），解析 estimatedCredits', async () => {
  const calls: string[][] = []
  const channel = createJimengService({
    run: async (args) => {
      calls.push(args)
      return {
        code: 0,
        stdout: JSON.stringify({ status: 'ok', data: { estimatedCredits: 76, billedAmount: 4, billedUnit: 'second', modelId: 'Seedance_2.5_flash' } }),
        stderr: '',
        timedOut: false,
      }
    },
    locate: () => ({ novel: 'C:/x/jimeng-novel.exe' }),
    outDir: 'C:/tmp',
  })

  const image = await channel.estimate!({ type: 'image', model: 'seedream_5.5' })
  assert.equal(image.ok, true)
  assert.equal(image.credits, 76)
  assert.deepEqual(calls[0]?.slice(1, 3), ['credit', 'estimate'], '走的是 credit estimate')
  assert.ok(calls[0]?.includes('-j'), '要 json 信封')

  const video = await channel.estimate!({ type: 'video', model: 'Seedance_2.5_flash', duration: 4 })
  assert.equal(video.billedUnit, 'second')
  assert.ok(calls[1]?.includes('--duration') && calls[1]?.includes('4'), '视频报价必须带 --duration')
  assert.ok(calls[2] === undefined, '不该有第三次调用')
})
