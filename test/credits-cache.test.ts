import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * 积分端点的共享缓存。
 *
 * ## 这条缓存是被实测逼出来的
 *
 * trae-proxy 的 `/credits` **完全没有缓存**。修复前连续 4 次请求耗时：
 *
 *     163 / 144 / 296 / 146 ms     ← 每次都真连 Trae 上游
 *
 * 对照 workbuddy（代理侧 60s TTL）：186 / 6 / 19 / 15 ms，第二次就掉到 6 ms。
 *
 * 放大路径有两条，**代理侧加缓存只能压住一条**：
 *   1. 面板每 15 分钟刷一次，`refresh()` 一次拉全部积分端点（哪怕你停在「服务」页）；
 *   2. 开 N 个标签页就是 N 倍并发。
 *
 * 所以缓存放在 hub，一处解决两条。
 *
 * 这里把 `creditsCached` 的逻辑原样抽出来测——它是个闭包，没法直接 import。
 * 抽的时候刻意保持逐行一致：这是本仓库的既定做法，测试要锁的是真在跑的那份。
 */

const CREDITS_TTL_MS = 60 * 1000

/** server.ts 里 creditsCached 的逐行拷贝。改那边记得同步改这里，并在下面断言两者一致。 */
function makeCache() {
  const creditsCaches = new Map<string, { at: number; data: unknown }>()
  const creditsInFlight = new Map<string, Promise<unknown>>()
  async function creditsCached(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const hit = creditsCaches.get(key)
    if (hit !== undefined && Date.now() - hit.at < CREDITS_TTL_MS) return hit.data
    const running = creditsInFlight.get(key)
    if (running !== undefined) return running
    const p = load()
      .then((data) => {
        creditsCaches.set(key, { at: Date.now(), data })
        return data
      })
      .finally(() => { creditsInFlight.delete(key) })
    creditsInFlight.set(key, p)
    return p
  }
  return { creditsCached, creditsCaches, creditsInFlight, loadCount: 0 as number }
}

const settle = () => new Promise(r => setTimeout(r, 5))

// ---------- 命中缓存 ----------

test('60 秒内重复请求只打一次上游', async () => {
  let calls = 0
  const c = makeCache()
  const load = async () => { calls++; return { total: 100 } }
  assert.deepEqual(await c.creditsCached('trae', load), { total: 100 })
  assert.deepEqual(await c.creditsCached('trae', load), { total: 100 })
  assert.deepEqual(await c.creditsCached('trae', load), { total: 100 })
  assert.equal(calls, 1, '三次请求应只产生一次上游调用')
})

test('不同 key 各打各的，互不串味', async () => {
  // 三个平台是三条独立数据线。串了就会出现「Trae 显示成 MiniMax 的数」。
  const c = makeCache()
  const seen: string[] = []
  const load = (tag: string) => async () => { seen.push(tag); return { tag } }
  await Promise.all([
    c.creditsCached('trae', load('trae')),
    c.creditsCached('minimax', load('minimax')),
    c.creditsCached('workbuddy', load('workbuddy')),
  ])
  assert.deepEqual(seen.sort(), ['minimax', 'trae', 'workbuddy'], '三家各查一次')
  assert.deepEqual(await c.creditsCached('trae', load('x')), { tag: 'trae' })
  assert.deepEqual(await c.creditsCached('minimax', load('y')), { tag: 'minimax' })
})

// ---------- 单飞（防缓存击穿） ----------

test('并发 12 个请求只发一次上游（这正是多标签页场景）', async () => {
  let calls = 0
  const c = makeCache()
  const load = async () => { calls++; await settle(); return { total: 7 } }
  const results = await Promise.all(Array.from({ length: 12 }, () => c.creditsCached('trae', load)))
  assert.equal(calls, 1, `12 个并发应合并成 1 次上游调用，实际 ${calls} 次`)
  for (const r of results) assert.deepEqual(r, { total: 7 }, '所有等待者拿到同一份数据')
})

test('上游失败后不缓存，且下一个请求会重试（不能把故障缓存 60 秒）', async () => {
  let calls = 0
  const c = makeCache()
  const load = async () => { calls++; if (calls === 1) throw new Error('上游 502'); return { total: 1 } }
  await assert.rejects(() => c.creditsCached('trae', load), /502/)
  assert.equal(c.creditsCaches.has('trae'), false, '失败不能进缓存')
  assert.deepEqual(await c.creditsCached('trae', load), { total: 1 }, '下一个请求要真去重试')
  assert.equal(calls, 2)
})

test('失败后 in-flight 已清空，不会永久卡住在 rejected 的 Promise 上', async () => {
  const c = makeCache()
  const bad = async () => { throw new Error('boom') }
  await assert.rejects(() => c.creditsCached('trae', bad), /boom/)
  assert.equal(c.creditsInFlight.has('trae'), false, 'in-flight 必须被 finally 清掉，否则后续请求永远拿到同一个失败 Promise')
})

// ---------- 过期后重新取 ----------

test('超过 TTL 会重新取', async () => {
  let calls = 0
  const c = makeCache()
  const load = async () => { calls++; return calls }
  assert.equal(await c.creditsCached('trae', load), 1)
  // 手工把时间戳往回拨，代替真的等 60 秒
  const hit = c.creditsCaches.get('trae')!
  hit.at = Date.now() - CREDITS_TTL_MS - 1
  assert.equal(await c.creditsCached('trae', load), 2, '过期后应重新拉')
  assert.equal(calls, 2)
})

// ---------- 与实现保持一致 ----------

test('TTL 与实现一致（防止测试和 server.ts 各写一个 60）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'), 'utf8')
  // 必须整段捕获 `60 * 1000` 再算出来：
  //   早先只截到 `60`，拿 60 和 60000 比 —— 测试自己先错了，排查浪费了一轮。
  //   也不能要求结尾有分号：这文件是 no-semicolon 风格。
  const m = src.match(/const CREDITS_TTL_MS\s*=\s*([\d_]+(?:\s*\*\s*[\d_]+)*)/)
  assert.ok(m, 'server.ts 里应有 CREDITS_TTL_MS')
  const actual = m[1].split('*').map(x => Number(x.replace(/_/g, ''))).reduce((a, b) => a * b, 1)
  assert.equal(actual, CREDITS_TTL_MS, `server.ts(${m[1].trim()}=${actual}) 与本测试(${CREDITS_TTL_MS}) 的 TTL 不一致`)
})

test('三个积分路由都必须走缓存（漏一个就等于没加）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'), 'utf8')
  for (const key of ['trae', 'minimax', 'workbuddy']) {
    const re = new RegExp(`creditsCached\\('${key}',\\s*\\w+Credits\\)`)
    assert.match(src, re, `/api/${key}/credits 没走 creditsCached`)
  }
  // 反向：直调（绕过缓存）不该出现在路由里
  const routeBlock = src.slice(src.indexOf("url === '/api/trae/credits'"))
  assert.ok(!/await traeCredits\(\)/.test(routeBlock), '路由里出现了直调 traeCredits()，缓存被绕过了')
})
