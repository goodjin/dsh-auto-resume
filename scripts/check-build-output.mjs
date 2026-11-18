#!/usr/bin/env node
/**
 * 校验随仓库发布的构建产物与源码一致。
 *
 * 社区安装走 git / npm 两条路：都不跑构建脚本，所以产物必须随仓库一起走。
 * 这个检查在 CI 与本地门禁里把「产物过期」变成红灯，而不是让用户装到一个
 * 与源码不符的版本。
 *
 * 本插件只有宿主半边（没有浏览器产物），所以只校验 lib/host。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = join(root, '.build-check')
rmSync(temp, { recursive: true, force: true })

function hash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

execFileSync(process.execPath, [join(root, 'node_modules/typescript/lib/tsc.js'), '-p', 'tsconfig.build.json', '--outDir', temp], { cwd: root, stdio: 'inherit' })

const published = listFiles(join(root, 'lib/host'))
const rebuilt = listFiles(temp)
const problems = []

const rebuiltByName = new Map(rebuilt.map(file => [relative(temp, file), file]))
const publishedByName = new Map(published.map(file => [relative(join(root, 'lib/host'), file), file]))

for (const [name, file] of rebuiltByName) {
  const shipped = publishedByName.get(name)
  if (shipped === undefined) { problems.push(`缺失产物：lib/host/${name}`); continue }
  if (hash(shipped) !== hash(file)) problems.push(`产物过期：lib/host/${name}`)
}
for (const name of publishedByName.keys()) {
  if (!rebuiltByName.has(name)) problems.push(`多余产物：lib/host/${name}`)
}


rmSync(temp, { recursive: true, force: true })
if (problems.length) {
  console.error('构建产物与源码不一致，请运行 npm run build 后提交产物：')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log(`构建产物一致（lib/host ${published.length} 个文件）`)
