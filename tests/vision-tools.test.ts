/**
 * 识图的「agent 侧」判据：工具形状、指南单一真源、skill 安装幂等。
 *
 * 这一层不起浏览器、不碰网络：工具只认 `VisionService` 形状，skill 只碰临时目录。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildVisionTools, VISION_TOOL_NAMES } from '../src/vision/tools.js'
import {
  fingerprintDir,
  installBundledSkills,
  readVisionSkillBody,
  resetVisionSkillCache,
  SKILL_VERSION_FILE,
  stripFrontmatter,
  verifySkillInstall,
  VISION_GUIDE_FALLBACK,
  VISION_SKILL_NAME,
} from '../src/vision/skill.js'
import type { VisionService } from '../src/vision/service.js'

const CWD = process.cwd()
const SKILL_ASSETS = path.join(CWD, 'assets', 'skills', VISION_SKILL_NAME)

/** 最小可用 service 桩（只实现工具用到的那几个方法）。 */
function fakeService(overrides: Partial<VisionService> = {}): VisionService {
  return {
    dir: tmpdir(),
    configFile: path.join(tmpdir(), 'vision.json'),
    current: () => ({}) as never,
    view: () => ({}) as never,
    save: () => ({ ok: true }),
    enabled: () => true,
    recognize: async () => '图里有一个红色圆形（桩）',
    listModels: async () => [],
    webStatus: async (site) => ({ site, label: site === 'doubao' ? '豆包' : 'Gemini', loggedIn: true }),
    webLogin: async () => ({ loggedIn: true, waitedMs: 1_000 }),
    dispose: async () => undefined,
    describe: () => ({}),
    ...overrides,
  } as VisionService
}

// ── 工具形状（插件契约 §2：六个键一个不少）──────────────────────────────

test('工具：四个都在，且六个键齐全、output.schema 是 string', () => {
  const tools = buildVisionTools(fakeService(), { guideBody: () => '# 指南' })
  assert.deepEqual(tools.map((tool) => String(tool.name)).sort(), [...VISION_TOOL_NAMES].sort())
  for (const tool of tools) {
    for (const key of ['name', 'description', 'parameters', 'output', 'timeoutMs', 'execute']) {
      assert.ok(key in tool, `${String(tool.name)} 缺 ${key}`)
    }
    const output = tool.output as { schema?: { type?: string }; render?: unknown }
    assert.equal(output.schema?.type, 'string', `${String(tool.name)} 的 output.schema.type 必须是 string`)
    assert.equal(typeof output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.timeoutMs, 'number')
    assert.ok(Number(tool.timeoutMs) >= 15_000, `${String(tool.name)} 的超时要明确给数`)
    assert.ok(String(tool.description).length > 40, `${String(tool.name)} 的 description 要自解释`)
  }
})

test('工具：vision_guide 返回指南正文（与 skill 同一份真源，不带 frontmatter）', async () => {
  const body = '## 正文\n\n调 recognize_image。'
  const tools = buildVisionTools(fakeService(), { guideBody: () => body })
  const guide = tools.find((tool) => tool.name === 'vision_guide') as { execute: (args: Record<string, unknown>) => Promise<string> }
  assert.equal(await guide.execute({}), body)
})

test('工具：recognize_image 缺路径报人话；多传的参数要显形', async () => {
  const tools = buildVisionTools(fakeService(), { guideBody: () => 'x' })
  const recognize = tools.find((tool) => tool.name === 'recognize_image') as {
    execute: (args: Record<string, unknown>) => Promise<string>
  }
  await assert.rejects(() => recognize.execute({}), /绝对路径（image_path）/)

  const file = path.join(tmpdir(), `dafeiyu-vision-tool-${process.pid}.png`)
  writeFileSync(file, Buffer.from('fake-bytes'))
  try {
    const text = await recognize.execute({ image_path: file, extra: 1 })
    assert.match(text, /红色圆形/)
    assert.match(text, /忽略未知参数：extra/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('工具：vision_web_status 只认 doubao/gemini/both，其余明确报错', async () => {
  const tools = buildVisionTools(fakeService(), { guideBody: () => 'x' })
  const status = tools.find((tool) => tool.name === 'vision_web_status') as {
    execute: (args: Record<string, unknown>) => Promise<string>
  }
  await assert.rejects(() => status.execute({ site: 'baidu' }), /site 只能是 doubao \/ gemini \/ both/)
  const text = await status.execute({})
  assert.match(text, /豆包：已登录/)
  assert.match(text, /Gemini：已登录/)
})

test('工具：vision_web_login 只认两个站点，并把"没登上"说清楚', async () => {
  const notYet = buildVisionTools(fakeService({ webLogin: async () => ({ loggedIn: false, waitedMs: 150_000 }) }), {
    guideBody: () => 'x',
  })
  const login = notYet.find((tool) => tool.name === 'vision_web_login') as {
    execute: (args: Record<string, unknown>) => Promise<string>
  }
  await assert.rejects(() => login.execute({ site: 'baidu' }), /site 只能是 doubao \/ gemini/)
  const text = await login.execute({ site: 'doubao' })
  assert.match(text, /还没登上/)
  assert.match(text, /150 秒/)
})

// ── skill：单一真源 + 安装幂等 ──────────────────────────────────────────

test('skill：包内 SKILL.md 存在、有 frontmatter、名字对得上', () => {
  const raw = readFileSync(path.join(SKILL_ASSETS, 'SKILL.md'), 'utf8')
  assert.match(raw, /^---\r?\n/)
  assert.match(raw, new RegExp(`name:\\s*${VISION_SKILL_NAME}`))
  assert.match(raw, /description:/)
  // 正文里必须点名那几个工具（否则指南与实现漂了）
  const body = stripFrontmatter(raw)
  for (const name of VISION_TOOL_NAMES) assert.ok(body.includes(name), `SKILL.md 正文没提到 ${name}`)
  assert.ok(existsSync(path.join(SKILL_ASSETS, 'references', 'web-mode.md')))
})

test('skill：读正文会去掉 frontmatter；读不到就退回内置短版', () => {
  resetVisionSkillCache()
  const body = readVisionSkillBody(SKILL_ASSETS)
  assert.ok(!body.startsWith('---'))
  assert.match(body, /recognize_image/)

  resetVisionSkillCache()
  const fallback = readVisionSkillBody(path.join(tmpdir(), 'no-such-skill-dir'))
  assert.equal(fallback, VISION_GUIDE_FALLBACK)
  resetVisionSkillCache()
})

test('skill：装一次 → 再装是空操作 → 改内容会重铺 → 自检能发现残缺', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dafeiyu-vision-skill-'))
  const assets = path.join(home, 'assets', VISION_SKILL_NAME)
  const logs: string[] = []
  try {
    mkdirSync(assets, { recursive: true })
    writeFileSync(path.join(assets, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\n正文 v1\n')
    mkdirSync(path.join(assets, 'references'), { recursive: true })
    writeFileSync(path.join(assets, 'references', 'a.md'), '参考 v1\n')

    const first = installBundledSkills({ dshHome: home, assetsRoot: path.join(home, 'assets'), version: '1.0.0', log: (m) => logs.push(m) })
    assert.equal(first.ok, true)
    assert.deepEqual(first.installed, [VISION_SKILL_NAME])
    const target = path.join(home, 'skills', VISION_SKILL_NAME)
    assert.ok(existsSync(path.join(target, 'SKILL.md')))
    assert.ok(existsSync(path.join(target, 'references', 'a.md')))
    assert.equal(readFileSync(path.join(target, SKILL_VERSION_FILE), 'utf8').trim(), '1.0.0')

    // 再装一次：指纹相同 ⇒ 跳过（版本号不是判据）
    const second = installBundledSkills({ dshHome: home, assetsRoot: path.join(home, 'assets'), version: '2.0.0', log: () => {} })
    assert.equal(second.ok, true)
    assert.deepEqual(second.installed, [])
    assert.equal(readFileSync(path.join(target, SKILL_VERSION_FILE), 'utf8').trim(), '1.0.0')

    // 改一句正文（字节数变了）⇒ 指纹变 ⇒ 整份重铺
    writeFileSync(path.join(assets, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n\n正文 v2 更长了\n')
    const third = installBundledSkills({ dshHome: home, assetsRoot: path.join(home, 'assets'), version: '1.0.0', log: () => {} })
    assert.deepEqual(third.installed, [VISION_SKILL_NAME])
    assert.match(readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /v2/)

    // 指纹只认相对路径 + 字节数（按当前文件实际字节数算，别写死）
    const skillBytes = readFileSync(path.join(assets, 'SKILL.md')).byteLength
    const refBytes = readFileSync(path.join(assets, 'references', 'a.md')).byteLength
    assert.equal(fingerprintDir(assets), `SKILL.md:${skillBytes}|references/a.md:${refBytes}`)

    // 自检：少一个 references 文件就要报出来
    rmSync(path.join(target, 'references', 'a.md'))
    const check = verifySkillInstall({ assetsRoot: assets, targetDir: target })
    assert.equal(check.ok, false)
    assert.ok(check.problems.some((problem) => problem.includes('没铺到：references/a.md')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('skill：包内没有 assets/skills 时给出可照做的原因，不抛', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dafeiyu-vision-skill-miss-'))
  try {
    const result = installBundledSkills({ dshHome: home, assetsRoot: path.join(home, 'nope'), version: '1', log: () => {} })
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /missing-asset/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
