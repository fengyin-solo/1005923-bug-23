// 自测运行器：用仓库自带 esbuild 把 TS 测试打成一个 node ESM 临时包再执行，不引第三方测试框架。
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rm } from 'node:fs/promises'

const root = dirname(fileURLToPath(import.meta.url))
const entry = resolve(root, 'tracker-service.test.ts')
const outfile = resolve(root, '.tracker-service.test.bundle.mjs')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@': resolve(root, '../src') },
  outfile,
  logLevel: 'warning',
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(outfile, { force: true })
}
