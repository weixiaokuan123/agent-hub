import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

/**
 * 积分包按到期日聚合。
 *
 * 上游（workbuddy-proxy 的 upstream.ts）本来就返回逐个包的真实到期/刷新时刻，
 * 但 /status 过去只透传了 `packages.length` 一个数字，面板因此看不到任何到期信息。
 * 现在把明细透传下来，由面板按「到期日」聚合展示。
 *
 * 核心性质有三个，缺一个就会误导人：
 *   1. 同一天的包必须合并——否则「10-20」会重复出现两行，看不出那天到底有多少分；
 *   2. 必须按日期升序——最近到期的排最前，这才是「紧急」的含义；
 *   3. 截断到 N 组时，必须报出「还有几组、共多少分」——只显示前 5 组却不提
 *      被藏掉的部分，会让人以为那就是全部，1487 分的账号看着只剩 509 分。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

function loadPanel() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, 'index.html 里应有 <script> 块')
  const pure = m[1].split('/* ================= 渲染总入口 ================= */')[0]
  const src = pure +
    '\n; return { groupCreditPackages };'
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

/** 本地零点，避免测试随时区翻车。 */
function at(y: number, m: number, d: number, h = 0): number {
  return new Date(y, m - 1, d, h).getTime()
}
const gift = (remain: number, ms: number) =>
  ({ packageName: 'p', remain, size: remain, monthly: false, expiresAtMs: ms })
const monthly = (remain: number, ms: number) =>
  ({ packageName: 'm', remain, size: 500, monthly: true, refreshAtMs: ms })

// ---------- 同日合并 ----------

test('同一天的多个包合并成一组，余额相加、包数累加', () => {
  const r = panel.groupCreditPackages([
    gift(80, at(2026, 10, 20)),
    gift(8, at(2026, 10, 20, 23)),   // 同一天但不同小时，必须归同一组
    gift(50, at(2026, 10, 21)),
  ], 5)
  assert.equal(r.expiring.length, 2)
  assert.deepEqual(
    r.expiring.map(g => [g.date, g.remain, g.count]),
    [['2026-10-20', 88, 2], ['2026-10-21', 50, 1]],
  )
})

// ---------- 升序：近的在前 ----------

test('按到期日升序排列，最近到期的排最前', () => {
  const r = panel.groupCreditPackages([
    gift(1, at(2027, 3, 17)),
    gift(2, at(2026, 12, 2)),
    gift(3, at(2026, 10, 20)),
  ], 5)
  assert.deepEqual(r.expiring.map(g => g.date), ['2026-10-20', '2026-12-02', '2027-03-17'])
})

// ---------- 月度包分流 ----------

test('月度包按刷新日单独成组，不混进到期列表', () => {
  const r = panel.groupCreditPackages([
    gift(100, at(2026, 10, 20)),
    monthly(0, at(2026, 9, 30)),
  ], 5)
  assert.equal(r.expiring.length, 1, '月度包不该出现在到期组里')
  assert.equal(r.monthly.length, 1)
  assert.equal(r.monthly[0].date, '2026-09-30')
  assert.equal(r.monthly[0].remain, 0)
})

// ---------- 截断必须报出被藏掉的部分 ----------

test('超过上限时，报出被藏掉的组数与分数（否则总额对不上）', () => {
  // 7 个到期日组，只显示最近 5 个 → 藏起 12-02 与 2027-03-17
  const all = [
    gift(82, at(2026, 10, 20)), gift(28, at(2026, 10, 20)),
    gift(110, at(2026, 10, 21)), gift(55, at(2026, 10, 21)),
    gift(100, at(2026, 10, 22)),
    gift(117, at(2026, 10, 23)),
    gift(200, at(2026, 10, 25)),
    gift(555, at(2026, 12, 2)),
    gift(50, at(2027, 3, 17)),
  ]
  const r = panel.groupCreditPackages(all, 5)
  assert.equal(r.expiring.length, 5, '只显示 5 组')
  assert.equal(r.hiddenGroups, 2, '剩下 2 组要报出来')
  assert.equal(r.hiddenRemain, 555 + 50)
  const shown = r.expiring.reduce((s, g) => s + g.remain, 0)
  assert.equal(shown + r.hiddenRemain, all.reduce((s, p) => s + p.remain, 0),
    '显示的 + 藏起来的必须等于总额')
  // 藏起来的一定是最近的之外那些，也就是日期更远的
  assert.deepEqual(r.expiring.map(g => g.date),
    ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-25'])
})

test('不超上限时不报「另有」，避免出现「另有 0 组」', () => {
  const r = panel.groupCreditPackages([gift(1, at(2026, 10, 20))], 5)
  assert.equal(r.hiddenGroups, 0)
  assert.equal(r.hiddenRemain, 0)
})

// ---------- 边界 ----------

test('空数组不炸', () => {
  const r = panel.groupCreditPackages([], 5)
  assert.deepEqual(r.expiring, [])
  assert.deepEqual(r.monthly, [])
  assert.equal(r.hiddenGroups, 0)
})

test('缺到期时刻的一次性包归入「不过期」，排最后且不隐藏', () => {
  const r = panel.groupCreditPackages([
    gift(30, undefined),
    gift(10, at(2026, 10, 20)),
  ], 5)
  const never = r.expiring[r.expiring.length - 1]
  assert.equal(never.date, '不过期')
  assert.equal(never.remain, 30)
  assert.equal(r.hiddenGroups, 0, '不过期的部分不该被藏起来')
})

test('没有月度包时 monthly 为空数组（面板据此不画分隔线）', () => {
  const r = panel.groupCreditPackages([gift(1, at(2026, 10, 20))], 5)
  assert.deepEqual(r.monthly, [])
})

// ---------- 脏数据：老代理可能不返回明细 ----------

test('包列表缺失/非数组时安全降级（老版本代理没有这个字段）', () => {
  assert.deepEqual(panel.groupCreditPackages(undefined, 5).expiring, [])
  assert.deepEqual(panel.groupCreditPackages(null, 5).expiring, [])
})
