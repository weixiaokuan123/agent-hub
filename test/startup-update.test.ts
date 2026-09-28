import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseUpdatePending, filterPending, startupUpdateCheck, STARTUP_RETRY_DELAYS_MS } from '../src/server.ts'

/** filterPending 是纯同步的，包一层只是为了和上面的异步用例读起来一致。 */
const filter = async (p: ReturnType<typeof parseUpdatePending>, r?: Map<string, string>) => filterPending(p, r)

/**
 * 启动时的自动更新检查，以及 update-pending.json 的读取。
 *
 * 两件事都是因为「静默」而存在：
 *   - 原来只有一次 setTimeout(30s)。开机时代理往往还没监听端口，
 *     readCurrentVersion 返回 undefined，三个仓被一次性全跳过，
 *     而下一次检查在 24 小时后 —— 于是「启动时自动更新」变成看运气。
 *   - update-pending.json 一直有人写、没人读，后台自动合并的结果无人知晓。
 */

/** 假 check：按脚本返回「解析成功几个仓」。 */
function fakeCheck(counts: number[], total: number) {
  const calls: number[] = []
  let i = 0
  return {
    calls,
    check: async () => {
      calls.push(i)
      const n = counts[Math.min(i, counts.length - 1)]
      i++
      return { results: Array.from({ length: n }, (_, k) => ({ name: `r${k}` })) }
    },
    total,
  }
}

const noSleep = async () => {}

// ---------- B：退避重试 ----------

test('代理慢启动时不会漏掉：第 3 轮才就绪，也要完成检查', async () => {
  // 0 / 0 / 0 / 3 —— 前三轮一个仓都解析不出来
  const f = fakeCheck([0, 0, 0, 3], 3)
  const r = await startupUpdateCheck({
    check: f.check, total: 3, delaysMs: STARTUP_RETRY_DELAYS_MS, sleep: noSleep, log: () => {},
  })
  assert.equal(r.gaveUp, false, '不该放弃')
  assert.equal(r.rounds, 4, '前三轮空转后第四轮才拿到全部版本号')
  assert.equal(f.calls.length, 4)
})

test('代理一开始就绪：只查一轮就收工，不做无谓的退避等待', async () => {
  const f = fakeCheck([3], 3)
  const r = await startupUpdateCheck({
    check: f.check, total: 3, delaysMs: STARTUP_RETRY_DELAYS_MS, sleep: noSleep, log: () => {},
  })
  assert.equal(r.gaveUp, false)
  assert.equal(r.rounds, 1, '一轮就够了')
})

test('始终不就绪：放弃时必须留下日志，绝不静默', async () => {
  const f = fakeCheck([0], 3)
  const logs: string[] = []
  const r = await startupUpdateCheck({
    check: f.check, total: 3, delaysMs: STARTUP_RETRY_DELAYS_MS, sleep: noSleep,
    log: m => logs.push(m),
  })
  assert.equal(r.gaveUp, true)
  assert.equal(r.rounds, STARTUP_RETRY_DELAYS_MS.length)
  assert.ok(logs.length > 0, '放弃必须有日志，否则使用者永远不知道更新被跳过了')
  assert.match(logs.join('\n'), /跳过|未就绪/)
})

test('退避序列递增，且总窗口在十分钟内（不能让人等太久）', () => {
  const total = STARTUP_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
  assert.ok(total > 0 && total <= 10 * 60_000, `总等待 ${total}ms，超出可接受范围`)
  for (let i = 1; i < STARTUP_RETRY_DELAYS_MS.length; i++) {
    assert.ok(STARTUP_RETRY_DELAYS_MS[i] >= STARTUP_RETRY_DELAYS_MS[i - 1], '延迟应非递减')
  }
})

test('check 抛异常时不炸掉整个启动流程，继续下一轮', async () => {
  let n = 0
  const r = await startupUpdateCheck({
    total: 1,
    delaysMs: [0, 1, 2],
    sleep: noSleep,
    log: () => {},
    check: async () => {
      n++
      if (n === 1) throw new Error('代理连接被拒')
      return { results: [{ name: 'a' }] }
    },
  })
  assert.equal(r.gaveUp, false, '第一轮炸了不该终止整个重试')
  assert.equal(r.rounds, 2)
})

// ---------- D：读 update-pending.json ----------

test('正常内容：解析出待重启的仓库与检查时间', () => {
  const raw = JSON.stringify({
    checkedAt: 1759047887000,
    pending: [{ name: 'workbuddy-proxy', latest: '1.3.19' }, { name: 'trae-proxy', latest: '1.2.8' }],
  })
  const r = parseUpdatePending(raw)
  assert.equal(r.repos.length, 2)
  assert.equal(r.repos[0], 'workbuddy-proxy')
  assert.equal(r.latest['trae-proxy'], '1.2.8')
  assert.equal(r.checkedAt, 1759047887000)
})

test('文件不存在 / 为空：降级成「无待重启」，不抛', () => {
  assert.equal(parseUpdatePending(null).repos.length, 0)
  assert.equal(parseUpdatePending('').repos.length, 0)
  assert.equal(parseUpdatePending(undefined).repos.length, 0)
})

test('内容损坏：降级而不是让面板崩掉', () => {
  // 这文件是自动生成的，损坏时不该把整个「服务」页打不开
  const r = parseUpdatePending('{ 这不是 json')
  assert.equal(r.repos.length, 0)
})

test('结构不对（pending 不是数组 / 元素不是对象）：逐项跳过，不整体丢弃', () => {
  const r = parseUpdatePending(JSON.stringify({
    pending: [{ name: 'ok-repo', latest: '1.0.0' }, '垃圾', null, 42, { latest: '1.1' }],
  }))
  assert.deepEqual(r.repos, ['ok-repo'], '只认带 name 的对象元素')
})

test('陈旧的待重启标记也要显示（但带上时间，让使用者知道是多久前的）', () => {
  // 自动更新是 24h 一轮，标记可能已经躺了一天；直接隐藏等于让人以为没更新过
  const r = parseUpdatePending(JSON.stringify({
    checkedAt: 1, pending: [{ name: 'x', latest: '2' }],
  }))
  assert.equal(r.repos.length, 1)
  assert.equal(r.checkedAt, 1, '时间必须原样带出，由面板决定怎么显示')
})

// ---------- 陈旧标记必须被剔掉（实测踩到过）----------

test('代理已经重启到标记里的版本 → 该条标记不算「待重启」', async () => {
  // 实测：workbuddy 昨天被自动合并到 1.3.15 并写了标记，之后代理重启、代码又推到
  // 1.3.18。标记文件从没被清过，于是面板会永远挂着「→ v1.3.15，重启后生效」——
  // 一条永不消失的假提示，比不显示更糟。
  const raw = JSON.stringify({
    checkedAt: Date.now() - 86400_000,
    pending: [{ name: 'workbuddy-proxy', latest: '1.3.15' }],
  })
  const running = new Map([['workbuddy-proxy', '1.3.18']])
  const r = await filter(parseUpdatePending(raw), running)
  assert.equal(r.repos.length, 0, '跑着的版本已经 >= 标记版本，说明重启过了，不该再提示')
  assert.equal(r.latest['workbuddy-proxy'], undefined)
})

test('代理还没重启（跑的是旧版本）→ 标记保留', async () => {
  const raw = JSON.stringify({
    checkedAt: Date.now(),
    pending: [{ name: 'workbuddy-proxy', latest: '1.3.19' }],
  })
  const running = new Map([['workbuddy-proxy', '1.3.18']])
  const r = await filter(parseUpdatePending(raw), running)
  assert.deepEqual(r.repos, ['workbuddy-proxy'], '确实还没重启，必须提示')
  assert.equal(r.latest['workbuddy-proxy'], '1.3.19')
})

test('只剔掉已重启的那几个，其余照留', async () => {
  const raw = JSON.stringify({
    pending: [
      { name: 'a', latest: '2.0.0' },
      { name: 'b', latest: '2.0.0' },
      { name: 'c', latest: '2.0.0' },
    ],
  })
  const running = new Map([['a', '2.0.0'], ['b', '1.0.0'], ['c', '1.5.0']])
  const r = await filter(parseUpdatePending(raw), running)
  assert.deepEqual(r.repos, ['b', 'c'], 'a 已重启被剔掉，b/c 未重启保留')
})

test('版本信息缺失时保守保留，不凭空断言已重启', async () => {
  const raw = JSON.stringify({ pending: [{ name: 'a', latest: '2.0.0' }, { name: 'b' }] })
  // a 有 latest 没 current；b 反之 —— 都判为「信息不足，保留」
  const r = await filter(parseUpdatePending(raw), new Map([['a', '1.0.0']]))
  assert.deepEqual(r.repos, ['a', 'b'])
})
