import assert from 'node:assert/strict'
import { test } from 'node:test'

import { traeCreditView, type TraeCreditView } from '../src/server.ts'

/**
 * Trae 积分包映射。
 *
 * Trae 的 `/credits` 是**原样透传上游**（`usage: u.body`），所以解析全在 hub 侧。
 *
 * ## 这里有个实测踩过的坑
 *
 * 上游每个包给的是 `entitlement_base_info.quota.credits_limit`（额度上限）和
 * `usage.credits_amount`。**`credits_amount` 是「已消耗」，不是「剩余」。**
 *
 * 三个数对上才敢下结论：
 *
 *   Σ credits_limit  = 7950.000  =  usage_summary.total
 *   Σ credits_amount = 7350.886  ≈  usage_summary.consumed
 *   limit − amount    =  599.114  =  剩余
 *
 * 而且发请求后实测：`amount` 0.886 → 1.1412，**涨了**。若是「剩余」，用掉 0.25
 * 应该让它减少。所以余额必须自己算 `limit - amount`，不能拿 amount 当余额。
 */

const pack = (name: string, endTimeSec: number, limit: unknown, used: unknown) => ({
  display_desc: name,
  entitlement_base_info: {
    end_time: endTimeSec,
    ent_status: 0,
    quota: limit === undefined ? {} : { credits_limit: limit },
  },
  usage: used === undefined ? {} : { credits_amount: used },
})

const wrap = (packs: unknown[], consumed = 7000, total = 7950) => ({
  region: 'cn',
  http: 200,
  usage: {
    usage_summary: { consumed_amount: consumed, total_amount: total, consumption_ratio: consumed / total },
    user_entitlement_pack_list: packs,
  },
})

const nowSec = () => Math.floor(Date.now() / 1000)

// ---------- 余额必须自己算 ----------

test('余额 = credits_limit − credits_amount（amount 是已消耗）', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([
    pack('签到奖励', t + 10 * 86400, 150, 1.1412),
    pack('签到奖励', t + 11 * 86400, 150, 0),
  ]))
  assert.equal(v.packages.length, 2)
  assert.equal(v.packages[0]?.remain, 148.8588, '150 − 1.1412')
  assert.equal(v.packages[0]?.consumed, 1.1412)
  assert.equal(v.packages[0]?.size, 150)
  assert.equal(v.packages[1]?.remain, 150, '没消耗过的就是全额')
})

test('逐包余额之和必须等于 usage_summary 的剩余（对不上就是映射错了）', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([
    pack('A', t + 10 * 86400, 2000, 2000),
    pack('B', t + 11 * 86400, 500, 500),
    pack('C', t + 12 * 86400, 150, 1.14),
  ], 5000, 7950))
  const sum = v.packages.reduce((s, p) => s + p.remain, 0)
  // Σ remain 应等于 Σ(limit - used) = (2000+500+150) - (2000+500+1.14)
  assert.equal(Math.round(sum * 100) / 100, 148.86, `实际 ${sum}`)
})

// ---------- 筛选：已用光的丢掉 ----------

test('已用光（remain=0）的包必须剔除', () => {
  // 实测 27 个包里 22 个已用光；不剔就多出 22 行 0 分
  const t = nowSec()
  const v = traeCreditView(wrap([
    pack('已用光', t + 10 * 86400, 2000, 2000),
    pack('有余额', t + 11 * 86400, 150, 0),
  ]))
  assert.equal(v.packages.length, 1)
  assert.equal(v.packages[0]?.remain, 150)
})

test('credits_limit 缺失的包（「免费」）必须跳过，不能当成 0 分', () => {
  // 那个包 quota 里根本没有 credits_limit；当 0 处理会显示出一个假的空到期组
  const t = nowSec()
  const v = traeCreditView(wrap([
    pack('免费', t + 86400, undefined, undefined),
    pack('正常', t + 2 * 86400, 150, 0),
  ]))
  assert.equal(v.packages.length, 1, '只有 1 个有效包')
  assert.equal(v.packages[0]?.remain, 150)
})

test('packTotal 记过滤**前**的总数（面板要靠它说「27 个里 4 个还有余额」）', () => {
  // 面板原来那句「其余已用光」是无从证实的推断：脏包也是被丢掉的，
  // 说成「已用光」就可能变成假话。让服务端报真实总数。
  const t = nowSec()
  const v = traeCreditView(wrap([
    pack('已用光', t + 86400, 2000, 2000),
    pack('有余额', t + 2 * 86400, 150, 0),
    pack('免费', t + 3 * 86400, undefined, undefined),
  ]))
  assert.equal(v.packTotal, 3, '三个包都被上游看见了')
  assert.equal(v.packages.length, 1, '但只有一个还有余额')
})

test('浮点余额原样保留，不在解析层取整（对账关系不能被破坏）', () => {
  // 150 − 1.1412 = 148.8588。取整放显示层做（面板的 pts()），
  // 这里取了整，Σ packages.remain 就再也对不上 usage_summary 的剩余了。
  const t = nowSec()
  const v = traeCreditView(wrap([pack('签到奖励', t + 10 * 86400, 150, 1.1412)], 7351.14, 7950))
  assert.equal(v.packages[0]?.remain, 148.8588, '原值，不许在这里抹成 148.86')
  assert.equal(Math.round((v.remaining ?? 0) * 100) / 100, 598.86)
})

test('负数余额（上游给脏数据）按 0 处理并剔除', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([pack('脏', t + 86400, 150, 999)]))
  assert.equal(v.packages.length, 0, '脏包不该进列表')
  // remaining 来自 usage_summary，与包列表无关：包被剔除不等于余额要清零。
  // 这里若断言 undefined 就等于把「汇总口径」和「明细口径」混为一谈。
  assert.equal(v.remaining, 950, '余额仍按 usage_summary 给：7950 − 7000')
})

// ---------- 形状同构（面板复用全靠这个） ----------

test('字段名必须与 workbuddy/minimax 的包一致', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([pack('签到奖励', t + 86400, 150, 0)]))
  const p = v.packages[0]!
  assert.equal(typeof p.remain, 'number')
  assert.equal(typeof p.size, 'number')
  assert.equal(typeof p.expiresAtMs, 'number')
  assert.equal(p.monthly, false, 'Trae 无月度包，但字段必须在')
})

test('end_time 是秒，要转成毫秒', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([pack('X', t + 86400, 150, 0)]))
  // 若忘了 ×1000，到期日会落在 1970 年，聚合出来一片"已过期"
  assert.equal(v.packages[0]!.expiresAtMs, (t + 86400) * 1000)
  assert.equal(v.packages[0]!.expiresAtMs > 1_700_000_000_000, true, '毫秒时间戳应在 2023 年之后')
})

// ---------- 汇总 ----------

test('remaining 仍由 usage_summary 给出（权威口径，不自己加）', () => {
  const t = nowSec()
  const v = traeCreditView(wrap([pack('X', t + 86400, 150, 0)], 6000, 7950))
  assert.equal(v.consumed, 6000)
  assert.equal(v.total, 7950)
  assert.equal(v.remaining, 1950, '1950 = 7950 − 6000')
})

// ---------- 显示层取整（解析层不许动） ----------

test('面板把浮点余额显示成两位小数，不印 148.8588', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/index.html'), 'utf8')
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m)
  const src = m[1].split('/* ================= 渲染总入口 ================= */')[0] + '\n; return { pts, expiryBlockHtml };'
  const el = () => ({ innerHTML: '', textContent: '' })
  const sandbox = {
    document: { getElementById: el, createElement: el, querySelectorAll: () => [], addEventListener: () => {} },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '' }, history: { replaceState: () => {} }, window: { scrollTo: () => {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  }
  const p = new Function(...Object.keys(sandbox), src)(...Object.values(sandbox))

  assert.equal(p.pts(148.8588), 148.86, '取整到两位')
  assert.equal(p.pts(150), 150, '整数原样，不补 .00')
  assert.equal(p.pts(undefined), 0, '拿不到给 0，不是 NaN')
  assert.equal(p.pts(-0.004), 0, '负零要归零，否则显示 "-0 分"')

  // 端到端：真实 Trae 那个 148.8588 的包，渲染出来不能带浮点尾巴
  const t = nowSec()
  const v = traeCreditView(wrap([pack('签到奖励', t + 10 * 86400, 150, 1.1412)]))
  const out = p.expiryBlockHtml({ creditPackages: v.packages })
  assert.ok(out.includes('148.86'), `渲染结果应含 148.86，实际片段：${out.slice(0, 300)}`)
  assert.ok(!out.includes('148.8588'), '不能把浮点尾巴印到面板上')
})

test('上游给怪东西不能把面板带崩', () => {
  for (const bad of [null, undefined, 0, 'x', {}, { usage: null }, { usage: { user_entitlement_pack_list: 'x' } }]) {
    assert.doesNotThrow(() => traeCreditView(bad), `输入 ${JSON.stringify(bad)} 不该抛`)
  }
})

test('**非对象**输入必须报错，不能静默变成一张空卡片', () => {
  // trae-proxy 若返回状态码 200 的 HTML 错误页，fetchJson 会把原始文本塞进来。
  // 那样面板显示「剩余 —、总额 —」却什么都不说，看着像"本来就没额度"——比报错更糟。
  // 空对象 {} 不算：那确实是"上游什么都没给"，当空视图合理。
  for (const bad of ['<html>502</html>', 42, true, null, undefined]) {
    const v = traeCreditView(bad)
    assert.ok(v.error, `输入 ${JSON.stringify(bad)} 应带 error，实际 ${JSON.stringify(v)}`)
  }
  assert.equal(traeCreditView({}).error, undefined, '空对象不当错误')
  assert.equal(traeCreditView({}).packages.length, 0)
})

test('出错时降级成「不可用」，而不是编一个 0 出来', () => {
  const v = traeCreditView({ error: '上游 502' })
  assert.equal(v.error, '上游 502')
  assert.equal(v.total, undefined, '0 会被读成「余额为零」，比报错更糟')
  assert.equal(v.packages.length, 0)
})
