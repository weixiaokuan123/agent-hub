import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { restartProxies, describeRestart, RESTART_TARGETS, parseRestartBody } from '../src/server.ts'

/**
 * `POST /api/proxies/restart` —— 重启三个代理。
 *
 * 这是**高危端点**：它会 Stop-Process 杀掉正在服务模型请求的进程。所以它照抄
 * `/api/update/apply` 已有的三道闸（那套是现成且验证过的）：
 *   1. 二次确认：body 必须是 {"confirm":"restart"}；
 *   2. 并发锁：进行中一律 409 —— 两次并发 stop 会**杀掉对方刚启动的进程**；
 *   3. 审计日志：每次调用（含被拒）都留一行。
 *
 * 另一个必须说清的限制：它**无法重启 agent-hub 自己**——那个进程正在处理这个
 * 请求。所以文案里不能出现"重启全部"，否则使用者会以为面板也跟着刷新了。
 */

const noSleep = async () => {}

/** 假 runner：记录调用，按脚本返回每步结果。 */
function fakeRunner(results: Array<{ ok: boolean; error?: string }>) {
  const calls: Array<{ repo: string; action: string }> = []
  let i = 0
  return {
    calls,
    run: async (t: { repo: string }, action: string) => {
      calls.push({ repo: t.repo, action })
      const r = results[Math.min(i, results.length - 1)]
      i++
      return r.ok ? { code: 0, stderr: '' } : { code: 1, stderr: r.error ?? 'failed' }
    },
  }
}

const alive = { ok: true }

// ---------- 确认字段 ----------

test('缺 confirm → 拒绝（防误触 / 防 CSRF 式盲打）', () => {
  assert.equal(parseRestartBody('{}').confirmed, false)
  assert.equal(parseRestartBody('{"confirm":"apply"}').confirmed, false, '不能用 apply 的口令混过')
  assert.equal(parseRestartBody('').confirmed, false)
  assert.equal(parseRestartBody('not json').confirmed, false)
  assert.equal(parseRestartBody('{"confirm":"restart"}').confirmed, true)
})

test('审计日志必须标对端点名', () => {
  // 端点名曾被写死成 /api/update/apply，于是重启调用全记成了 apply。
  // 审计的意义是事后追溯——标错端点名会把排查引向错误的地方，比不记还糟。
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'), 'utf8')
  // 计数比对比正则断言可靠：\s* 可回溯到零宽，用 (?!') 判"不是字面量"会误报
  const all = (src.match(/audit\(req,/g) || []).length
  const literal = [...src.matchAll(/audit\(req,\s*'([^']*)'/g)].map(m => m[1])
  assert.equal(literal.length, all, '每一处 audit(req, …) 的端点名都必须是字符串字面量')
  assert.ok(literal.length >= 8, `应有多处审计调用，实际 ${literal.length}`)
  assert.ok(literal.includes('/api/proxies/restart'), '重启端点必须标自己的名字')
  assert.ok(literal.includes('/api/update/apply'), 'apply 端点也必须标自己的名字')
  // 写死的单一端点名正是这次要修的病
  assert.equal(new Set(literal).size, 2, `应恰好两个端点名，实际 ${[...new Set(literal)].join(', ')}`)
})

// ---------- 目标清单 ----------

test('目标固定为三个代理的六个端口', () => {
  assert.deepEqual(
    RESTART_TARGETS.map(t => t.repo),
    ['workbuddy-proxy', 'trae-proxy', 'minimax-proxy'],
  )
  assert.deepEqual(RESTART_TARGETS.map(t => t.ports), [[39301, 39302], [39303, 39304], [39305, 39306]])
})

// ---------- 正常路径 ----------

test('逐仓 stop → 等端口关 → start → 等端口开，顺序执行', async () => {
  const f = fakeRunner(Array.from({ length: 20 }, () => alive))
  const r = await restartProxies({ run: f.run, sleep: noSleep, targets: RESTART_TARGETS, timeoutMs: 100 })
  assert.equal(r.results.length, 3)
  assert.equal(r.ok, true)
  for (const t of RESTART_TARGETS) {
    const seq = f.calls.filter(c => c.repo === t.repo).map(c => c.action)
    assert.deepEqual(seq, ['stop', 'waitClosed', 'start', 'waitOpen'], `${t.repo} 的动作顺序不对`)
  }
})

test('必须先确认端口关掉再启动——第一版就是漏了这步', async () => {
  // 真实踩到过：stop 刚杀掉旧进程、端口还没释放时，start.ps1 认为「端口已开，
  // 跳过」（它本来就幂等）并返回 0；紧接着的「等端口打开」又对着那个正在死掉的
  // 旧进程探测，连上了 → 报成功。然后旧进程彻底退出，代理实际是死的。
  // 症状：端点说重启成功，端口却再也没人监听。
  const f = fakeRunner(Array.from({ length: 20 }, () => alive))
  await restartProxies({ run: f.run, sleep: noSleep, targets: [RESTART_TARGETS[0]], timeoutMs: 100 })
  const order = f.calls.map(c => c.action)
  assert.ok(
    order.indexOf('waitClosed') < order.indexOf('start'),
    `waitClosed 必须排在 start 之前，实际顺序：${order.join(' → ')}`,
  )
})

test('旧端口一直没释放 → 报失败，且不进入 start（避免假成功）', async () => {
  // stop 成功，但端口 40 秒后仍被占（别的进程占着）——此时若继续 start，
  // 就会重演"跳过启动然后报成功"的假象。
  const f = fakeRunner([alive, { ok: false, error: '端口仍被占用' }, alive, alive])
  const r = await restartProxies({ run: f.run, sleep: noSleep, targets: [RESTART_TARGETS[0]], timeoutMs: 2 })
  assert.equal(r.ok, false)
  assert.match(r.results[0].error ?? '', /仍被占用/)
  assert.ok(!f.calls.some(c => c.action === 'start'), '端口没释放就不该启动')
})

// ---------- 一个失败不影响其余 ----------

test('一个仓失败时，其余两个照样重启并返回结果', async () => {
  // stop / waitClosed / start / waitOpen ×3 仓；让 minimax 的 start 失败
  const f = fakeRunner([
    alive, alive, alive, alive,        // workbuddy
    alive, alive, alive, alive,        // trae
    alive, alive, { ok: false, error: 'start 失败' }, alive, // minimax 的 start 挂
  ])
  const r = await restartProxies({ run: f.run, sleep: noSleep, targets: RESTART_TARGETS, timeoutMs: 100 })
  assert.equal(r.results.length, 3, '三个仓都要有结果，不能因为一个失败就少一个')
  assert.equal(r.ok, false, '整体要标失败')
  assert.equal(r.results[0].ok, true)
  assert.equal(r.results[1].ok, true)
  assert.equal(r.results[2].ok, false)
  assert.match(r.results[2].error ?? '', /start 失败/)
})

// ---------- 结果文案 ----------

test('结果文案要说清重启了什么，且不得暗示面板也被重启了', () => {
  const text = describeRestart({
    ok: true,
    results: [
      { repo: 'workbuddy-proxy', ok: true, ports: [39301, 39302] },
      { repo: 'trae-proxy', ok: true, ports: [39303, 39304] },
      { repo: 'minimax-proxy', ok: true, ports: [39305, 39306] },
    ],
  })
  assert.match(text, /workbuddy-proxy/)
  assert.match(text, /minimax-proxy/)
  // agent-hub 正在处理这个请求，不可能被自己重启；文案说"全部"就是骗人
  assert.ok(!/全部|所有|面板.{0,4}重启/.test(text), `文案不该暗示面板也被重启：${text}`)
})

test('部分失败时文案要区分成功与失败，不能笼统说"已重启"', () => {
  const text = describeRestart({
    ok: false,
    results: [
      { repo: 'workbuddy-proxy', ok: true, ports: [39301, 39302] },
      { repo: 'trae-proxy', ok: false, error: 'start 失败', ports: [39303, 39304] },
    ],
  })
  assert.match(text, /workbuddy-proxy/)
  assert.match(text, /trae-proxy.*失败|trae-proxy[\s\S]*start 失败/)
  assert.ok(!/^已重启全部/.test(text))
})

// ---------- 端口等待超时 ----------

test('端口一直起不来 → 该仓报失败并带上超时说明，不无限等', async () => {
  // stop / waitClosed / start 成功，但 waitOpen 一直失败
  const f = fakeRunner([alive, alive, alive, { ok: false, error: 'timeout' }])
  const r = await restartProxies({ run: f.run, sleep: noSleep, targets: [RESTART_TARGETS[0]], timeoutMs: 2 })
  assert.equal(r.ok, false)
  assert.match(r.results[0].error ?? '', /超时|timeout|未在/i)
})
