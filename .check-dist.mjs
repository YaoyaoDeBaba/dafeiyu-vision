/**
 * check-dist —— 防止"改了源码忘了提交产物"。
 *
 * 背景：市场 / `git+` 安装**不跑构建**，装的是仓库里的 `dist/bundle/`。
 * 源码改了、产物没跟着提交 ⇒ 装上去的是旧版或空包，而且**不报错**。
 *
 * 做法：重新构建 → 用 `git diff --quiet -- dist/bundle` 比一次。
 * 有差异就打印怎么修，并以非零码退出（CI 会变红）。
 */
import { execFileSync } from 'node:child_process'

const run = (command, args, options = {}) => {
  try {
    execFileSync(command, args, { stdio: 'inherit', ...options })
    return true
  } catch {
    return false
  }
}

console.log('[check-dist] 重新构建…')
if (!run(process.execPath, ['.bin-build.mjs'])) {
  console.error('[check-dist] 构建失败，先修构建')
  process.exit(1)
}

console.log('[check-dist] 比对 dist/bundle 是否与源码同步…')
let clean = true
try {
  execFileSync('git', ['diff', '--quiet', '--', 'dist/bundle'], { stdio: 'inherit' })
} catch {
  clean = false
}

if (!clean) {
  console.error(
    [
      '',
      '[check-dist] ✖ dist/bundle 与源码不一致：源码改过但产物没提交。',
      '   修法：',
      '     npm run build',
      '     git add -f dist/bundle',
      '     git commit -m "build: 入库 dist/bundle（装机不构建，产物必须提交）"',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

console.log('[check-dist] ✔ dist/bundle 与源码同步')
