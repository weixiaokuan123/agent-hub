import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 挂载正确性用「静态检查」验证，而不是真的起服务——因为起服务要 hub-key、
 * 要占用 39310 端口，在测试环境里既慢又脆。这里钉住的是三件容易漏的事：
 * 路由确实加了、委托位置在鉴权之后、tool.html 确实存在。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('server.ts 里有 /tool 路由分支', async () => {
  const src = await readFile(join(ROOT, 'src', 'server.ts'), 'utf8')
  assert.match(src, /url === '\/tool'/, '缺少 GET /tool 分支')
})

test('server.ts 里委托了 tool router', async () => {
  const src = await readFile(join(ROOT, 'src', 'server.ts'), 'utf8')
  assert.match(src, /createToolRouter|toolRouter/, '缺少 tool router 挂载')
})

test('tool router 的委托在鉴权之后', async () => {
  const src = await readFile(join(ROOT, 'src', 'server.ts'), 'utf8')
  const authIdx = src.indexOf('if (!authed(req))')
  const delegateIdx = src.indexOf('toolRouter(req, res, url)')
  assert.ok(authIdx !== -1, '找不到鉴权分支')
  assert.ok(delegateIdx !== -1, '找不到 tool router 委托')
  assert.ok(
    delegateIdx > authIdx,
    'tool router 委托必须在鉴权检查之后，否则 /tool/api/* 会绕过 hub-key',
  )
})

test('public/tool.html 存在且不是空文件', async () => {
  const html = await readFile(join(ROOT, 'public', 'tool.html'), 'utf8')
  assert.ok(html.length > 100, 'tool.html 内容过少')
  assert.match(html, /<html/i)
})

test('tool.html 不含任何外链资源（CSP 是 default-src none）', async () => {
  const html = await readFile(join(ROOT, 'public', 'tool.html'), 'utf8')
  assert.doesNotMatch(html, /<script[^>]+src=/i, '不允许外链 script')
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i, '不允许外链 stylesheet')
  assert.doesNotMatch(html, /https?:\/\/[^\s"']*\.(js|css|woff2?|ttf)/i, '不允许外部资源')
})
