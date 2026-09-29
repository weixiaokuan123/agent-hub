import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { minimaxCreditView, type MinimaxCreditView } from '../src/server.ts'

/**
 * MiniMax 积分 → 面板的映射，以及「到期前 7 天提醒」。
 *
 * 提醒逻辑住在**面板**的 collectAttention() 里（提醒是显示职责），所以这里
 * 把 index.html 的 <script> 抽出来沙箱求值后直接驱动它——测的是真正在跑的那段。
 *
 * 曾经踩过的坑：一开始我在 server.ts 里写了个同规则的 expiringSoonNotice() 并配了
 * 7 条测试，全绿，但**面板跑的是另一份 inline 实现**，服务端那份从头到尾没人调用。
 * 测试绿了却什么都没保证。所以这里坚持测执行路径，不测副本。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

function loadPanel() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, 'index.html 里应有 <script> 块')
  const pure = m[1].split('/* ================= 渲染总入口 ================= */')[0]
  const src = pure + '\n; return { __setData: d => { DATA = d }, collectAttention };'
  const el = () => ({ innerHTML: '', textContent: '' })
  const sandbox = {
    document: { getElementById: el, createElement: el, querySelectorAll: () => [], addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '' },
    history: { replaceState: () => {} },
    window: { scrollTo: () => {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }
  return new Function(...Object.keys(sandbox), src)(...Object.values(sandbox))
}

const panel = loadPanel()
const DAY = 86_400_000
const pkg = (remain: number, days: number) => ({
  remain, size: remain, consumed: 0, expiresAtMs: Date.now() + days * DAY, monthly: false,
})

/** 只放积分，概览留空——这样 todo 里出现的东西只可能来自积分提醒。 */
function todosWith(mm: unknown) {
  panel.__setData({ overview: { regions: [] }, wbCredits: null, mmCredits: mm })
  return panel.collectAttention().todo
}

// ---------- 映射（服务端侧） ----------

test('代理的返回原样带出，面板直接能用', () => {
  const v = minimaxCreditView({
    region: 'cn', total: 3400,
    packages: [pkg(800, 25), pkg(1000, 27)],
    expiringSoon: 0, nearestExpiryMs: Date.now() + 25 * DAY,
  })
  assert.equal(v.total, 3400)
  assert.equal(v.packages.length, 2)
  assert.equal(v.packages[0]?.monthly, false, '字段必须在，否则面板 groupCreditPackages 会判 undefined')
  assert.equal(v.packages[0]?.expiresAtMs > 0, true)
})

test('代理报错时降级成「不可用」，而不是编一个 0 出来', () => {
  // 0 会被面板读成「余额为零」，比报错更糟
  const v = minimaxCreditView({ error: '上游 502' })
  assert.equal(v.error, '上游 502')
  assert.equal(v.total, undefined)
  assert.equal(v.packages.length, 0)
})

test('代理给了怪东西不能崩', () => {
  for (const bad of [null, undefined, 0, 'x', {}, { packages: 'x' }, { packages: { n: 1 } }]) {
    assert.doesNotThrow(() => minimaxCreditView(bad), `输入 ${JSON.stringify(bad)} 不该抛`)
  }
  assert.equal(minimaxCreditView({}).packages.length, 0)
})

test('缺 remain 或 expiresAtMs 的包被跳过（面板要靠这两个字段排序求和）', () => {
  const v = minimaxCreditView({ packages: [{ remain: 1 }, { expiresAtMs: 1 }, { remain: 5, expiresAtMs: Date.now() }] })
  assert.equal(v.packages.length, 1)
  assert.equal(v.packages[0]?.remain, 5)
})

// ---------- 提醒：测真正在跑的那段 ----------

test('7 天内到期 → 进「需要处理」，并说清几天、多少钱', () => {
  const todo = todosWith({ total: 1200, packages: [pkg(400, 3), pkg(800, 5)] })
  const t = todo.find(x => x.why === '积分将过期')
  assert.ok(t, `应有一条积分过期待办，实际 ${JSON.stringify(todo)}`)
  assert.match(t.text, /1200/, '要写清涉及多少分')
  assert.match(t.text, /3 天/, '要写清还有几天')
  assert.equal(t.provider, 'MiniMax')
})

test('刚好第 7 天整要算在内（边界别搞反）', () => {
  assert.equal(todosWith({ total: 400, packages: [pkg(400, 7)] }).filter(x => x.why === '积分将过期').length, 1)
})

test('8 天后到期不提醒 —— 你现在的真实情况（最近 10-25，还有 26 天）', () => {
  const todo = todosWith({ total: 3400, packages: [pkg(400, 25), pkg(800, 28)] })
  assert.equal(todo.filter(x => x.why === '积分将过期').length, 0, '还早，不该打扰')
})

test('已过期的额度不提醒（否则每天一条永远消不掉的僵尸提醒）', () => {
  assert.equal(todosWith({ total: 400, packages: [pkg(400, -2)] }).filter(x => x.why === '积分将过期').length, 0)
})

test('没有额度 / 没有包明细都不提醒', () => {
  for (const mm of [{ total: 0, packages: [] }, { total: 400, packages: [] }, null, undefined]) {
    assert.equal(todosWith(mm).filter(x => x.why === '积分将过期').length, 0, `输入 ${JSON.stringify(mm)} 不该提醒`)
  }
})

test('代理报错时也不提醒（拿不到 ≠ 快过期）', () => {
  assert.equal(todosWith({ error: '上游 502' }).filter(x => x.why === '积分将过期').length, 0)
})

test('多笔时只产生一条待办，不刷屏', () => {
  const todo = todosWith({ total: 2500, packages: [pkg(400, 1), pkg(1000, 2), pkg(1100, 6)] })
  assert.equal(todo.filter(x => x.why === '积分将过期').length, 1, '同一区域只该有一条')
  assert.match(todo.find(x => x.why === '积分将过期').text, /2500/, '金额应是窗口内全部之和')
})

// ---------- 面板没有硬编码第二份阈值 ----------

test('面板里不得出现第二份到期阈值常量', () => {
  // 曾经服务端与面板各写一份 7 天，测试还只测了服务端那份
  const hits = [...html.matchAll(/const\s+win\s*=\s*([^;]+);/g)].map(m => m[1].trim())
  assert.equal(hits.length, 1, `应只有一处阈值定义，实际 ${hits.length} 处：${hits.join(' | ')}`)
})
