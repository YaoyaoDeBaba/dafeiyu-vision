/**
 * paths — `DSH_HOME` 的派生规则（**逐字照抄本体 `src/memory/service.ts:39-45`**）。
 *
 * 拆包说明（2026-11-16）：本包是从 `dsh-remote-dafeiyu` 拆出来的独立插件，
 * 不能 import 本体的任何代码。这两处原本直接引本体：
 *   - `src/xyq/config.ts` 的默认参数 `resolveDshHome(process.env)`；
 *   - 本包的宿主入口 `src/index.ts`。
 * 于是把这条**唯一一份**规则搬到这里，两边都认同一套派生：
 * `DSH_HOME` 有值就用它，否则 `~/.dsh`；**两者都没有时返回空串**（与本体一致，
 * 不发明一个"当前目录"出来——那会让存储目录悄悄落到 cwd）。
 */
import path from 'node:path'

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.DSH_HOME ?? '').trim()
  if (explicit !== '') return explicit
  const home = (env.USERPROFILE ?? env.HOME ?? '').trim()
  return home === '' ? '' : path.join(home, '.dsh')
}
