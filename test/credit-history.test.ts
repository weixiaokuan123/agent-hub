/**
 * 每日积分用量历史：纯函数测试（无网络、无文件 IO）。
 *
 * 重点钉住几条用户拍定的规则：
 *  1. 用量 = 基准 − 次日基准 + 当天签到分（签到分必须加回，否则被稀释）
 *  2. 签到按**事件**累加（多账号签到各自 contribute），不按某个号的余额差
 *  3. 余额上升超过签到分 → 用量记 0 并标记「含入账」，绝不出负数
 *  4. 缺基准 / 缺次日基准 → null（无记录），绝不补 0
 *  5. 只保留最近 30 天
 *
 * 运行：node --test test/credit-history.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  HISTORY_PROVIDERS,
  dailyUsages,
  localDateOf,
  msUntilNextLocalMidnight,
  parseHistoryFile,
  parseSigninCredits,
  pruneSamples,
  sumSigninCredits,
  upsertSample,
  usageForDay,
  type CreditHistoryFile,
  type DailySample,
} from '../src/credit-history.ts'

const HOUR = 3600_000
const DAY = 24 * HOUR

function sample(over: Partial<DailySample> & { date: string }): DailySample {
  return { sampledAtMs: 0, balances: {}, signinCredits: {}, ...over }
}

function file(...samples: DailySample[]): CreditHistoryFile {
  return { version: 1, samples }
}

// ---------- 签到金额解析 ----------

test('parseSigninCredits：解析实测文案「签到成功，+100 积分（连签 21 天）」', () => {
  assert.equal(parseSigninCredits('签到成功，+100 积分（连签 21 天）'), 100)
})

test('parseSigninCredits：解析 +400 这种较大额度', () => {
  assert.equal(parseSigninCredits('签到成功，+400 积分（连签 6 天）'), 400)
})

test('parseSigninCredits：不把「连签 21 天」里的数字当成积分', () => {
  // "+100" 优先；若实现误抓后面的 21 就会错
  const n = parseSigninCredits('签到成功，+100 积分（连签 21 天）')
  assert.equal(n, 100, '必须取 +100 而不是 21')
})

test('parseSigninCredits：解析不出返回 undefined（不编 0）', () => {
  assert.equal(parseSigninCredits('签到活动未开启'), undefined)
  assert.equal(parseSigninCredits('今天已签到（连签 5 天）'), undefined)
  assert.equal(parseSigninCredits(''), undefined)
  assert.equal(parseSigninCredits(undefined), undefined)
})

// ---------- 签到按事件累加 ----------

test('sumSigninCredits：同一天多个账号签到要累加（按提供商汇总）', () => {
  const got = sumSigninCredits([
    { provider: 'workbuddy', date: '2026-10-20', claimed: true, result: '签到成功，+100 积分（连签 21 天）' },
    { provider: 'workbuddy', date: '2026-10-20', claimed: true, result: '签到成功，+100 积分（连签 5 天）' },
  ], '2026-10-20')
  assert.equal(got.workbuddy, 200, '两个号各领 100，合计 200')
})

test('sumSigninCredits：只算 claimed=true 且日期匹配的条目', () => {
  const got = sumSigninCredits([
    { provider: 'workbuddy', date: '2026-10-20', claimed: true, result: '签到成功，+100 积分' },
    { provider: 'workbuddy', date: '2026-10-20', claimed: false, result: '' },
    { provider: 'workbuddy', date: '2026-10-19', claimed: true, result: '签到成功，+100 积分' },
  ], '2026-10-20')
  assert.equal(got.workbuddy, 100, '只算当天且已领取的那一条')
})

test('sumSigninCredits：跨提供商分别汇总，互不干扰', () => {
  const got = sumSigninCredits([
    { provider: 'workbuddy', date: '2026-10-20', claimed: true, result: '签到成功，+100 积分' },
    { provider: 'minimax', date: '2026-10-20', claimed: true, result: '签到成功，+400 积分' },
  ], '2026-10-20')
  assert.equal(got.workbuddy, 100)
  assert.equal(got.minimax, 400)
})

// ---------- 用量推导：核心规则 ----------

test('usageForDay：纯消耗（无签到）', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { workbuddy: 1000 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 880 } }),
  )
  assert.equal(u.used.workbuddy, 120, '1000 − 880 = 用了 120')
  assert.equal(u.credited.workbuddy, false)
})

test('usageForDay：签到分必须加回，否则被稀释', () => {
  // 0 点基准 1000 → 7 点签到 +100 → 余额 1100 → 当天实际用了 200，余额剩 900
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { workbuddy: 1000 }, signinCredits: { workbuddy: 100 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 900 } }),
  )
  // 1000 − 900 + 100 = 200
  assert.equal(u.used.workbuddy, 200, '签到 100 要加回，真实用量是 200')
})

test('usageForDay：用户原话「第二天减去前一天正好等于签到分 → 用量为 0」', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { workbuddy: 1000 }, signinCredits: { workbuddy: 100 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 1100 } }),
  )
  // 1000 − 1100 + 100 = 0
  assert.equal(u.used.workbuddy, 0, '涨的分正好是签到分 → 当天没消耗')
  assert.equal(u.credited.workbuddy, false, '这不算「含入账」，是正常签到')
})

test('usageForDay：余额涨超过签到分 → 记 0 并标含入账（可能是包刷新）', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { workbuddy: 1000 }, signinCredits: { workbuddy: 100 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 2000 } }),
  )
  // 1000 − 2000 + 100 = −900 → 记 0
  assert.equal(u.used.workbuddy, 0, '绝不能显示负数用量')
  assert.equal(u.credited.workbuddy, true, '要标记这天含入账')
})

test('usageForDay：缺当天基准 → null（无记录，不补 0）', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: {} }),
    sample({ date: '2026-10-21', balances: { workbuddy: 500 } }),
  )
  assert.equal(u.used.workbuddy, null)
})

test('usageForDay：缺次日基准 → null（尚未结算）', () => {
  const u = usageForDay(sample({ date: '2026-10-20', balances: { workbuddy: 1000 } }), undefined)
  assert.equal(u.used.workbuddy, null)
})

test('usageForDay：某家单边缺失时只有那家为 null，其他家照常', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { workbuddy: 1000, trae: 500 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 900 } }),
  )
  assert.equal(u.used.workbuddy, 100, 'workbuddy 两端都有，能算')
  assert.equal(u.used.trae, null, 'trae 缺次日基准，只能是 null')
})

test('usageForDay：Trae 的小数额度保留两位小数', () => {
  const u = usageForDay(
    sample({ date: '2026-10-20', balances: { trae: 599.114 } }),
    sample({ date: '2026-10-21', balances: { trae: 598.864 } }),
  )
  assert.equal(u.used.trae, 0.25, '0.25 不能被抹成 0')
})

// ---------- 逐日展开 ----------

test('dailyUsages：最后一行总是 null（还没有次日基准）', () => {
  const us = dailyUsages(file(
    sample({ date: '2026-10-19', balances: { workbuddy: 1000 } }),
    sample({ date: '2026-10-20', balances: { workbuddy: 900 } }),
    sample({ date: '2026-10-21', balances: { workbuddy: 800 } }),
  ))
  assert.equal(us.length, 3)
  assert.equal(us[0]?.used.workbuddy, 100)
  assert.equal(us[1]?.used.workbuddy, 100)
  assert.equal(us[2]?.used.workbuddy, null, '最新一天尚未结算')
})

test('dailyUsages：limit 只取最近 N 天', () => {
  const mk = (d: string, bal: number) => sample({ date: d, balances: { workbuddy: bal } })
  const f = file(mk('2026-10-01', 900), mk('2026-10-02', 800), mk('2026-10-03', 700))
  const us = dailyUsages(f, 2)
  assert.equal(us.length, 2)
  assert.equal(us[0]?.date, '2026-10-02')
})

// ---------- 写入与裁剪 ----------

test('upsertSample：同一天重复采样替换，不产生重复行', () => {
  let f = file(sample({ date: '2026-10-20', balances: { workbuddy: 1000 } }))
  f = upsertSample(f, sample({ date: '2026-10-20', balances: { workbuddy: 950 } }))
  assert.equal(f.samples.length, 1)
  assert.equal(f.samples[0]?.balances.workbuddy, 950, '以最后一次为准')
})

test('upsertSample：写入后按日期升序', () => {
  let f = file()
  f = upsertSample(f, sample({ date: '2026-10-22', balances: {} }))
  f = upsertSample(f, sample({ date: '2026-10-20', balances: {} }))
  f = upsertSample(f, sample({ date: '2026-10-21', balances: {} }))
  assert.deepEqual(f.samples.map(s => s.date), ['2026-10-20', '2026-10-21', '2026-10-22'])
})

test('pruneSamples：只保留最近 30 天', () => {
  const samples = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(2026, 8, 1 + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return sample({ date: key, balances: { workbuddy: 1000 - i } })
  })
  const out = pruneSamples(file(...samples), 30)
  assert.equal(out.samples.length, 30)
  assert.equal(out.samples[29]?.date, samples[39]?.date, '保留的是最后 30 天')
})

// ---------- 解析容错 ----------

test('parseHistoryFile：畸形输入全部降级为空，不抛错', () => {
  for (const raw of [null, undefined, '', 'oops', '{}', '{"samples":"x"}', '[]']) {
    const f = parseHistoryFile(raw as string)
    assert.deepEqual(f.samples, [], `输入 ${String(raw)} 应降级为空`)
  }
})

test('parseHistoryFile：丢弃无效日期与负余额（脏值当没取到）', () => {
  const f = parseHistoryFile(JSON.stringify({
    samples: [
      { date: 'bad', balances: { workbuddy: 100 } },
      { date: '2026-10-20', balances: { workbuddy: -5, trae: 100 } },
    ],
  }))
  assert.equal(f.samples.length, 1, '非法日期被丢')
  assert.equal(f.samples[0]?.balances.workbuddy, undefined, '负余额当没取到')
  assert.equal(f.samples[0]?.balances.trae, 100)
})

test('parseHistoryFile：往返一致（写进去什么读出来什么）', () => {
  const original = file(sample({
    date: '2026-10-20',
    sampledAtMs: 123,
    balances: { workbuddy: 1000, trae: 500.5 },
    signinCredits: { workbuddy: 100 },
  }))
  const back = parseHistoryFile(JSON.stringify(original))
  assert.deepEqual(back, original)
})

// ---------- 本地 0 点 ----------

test('msUntilNextLocalMidnight：本地 0 点前 1 秒 → 1 秒', () => {
  const H = 480 // UTC+8 的 getTimezoneOffset 是 −480
  const localMidnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0) - 8 * HOUR
  assert.equal(msUntilNextLocalMidnight(localMidnightUtc - 1000, -H), 1000)
})

test('msUntilNextLocalMidnight：恰在本地 0 点 → 整天', () => {
  const localMidnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0) - 8 * HOUR
  assert.equal(msUntilNextLocalMidnight(localMidnightUtc, -480), DAY)
})

test('msUntilNextLocalMidnight：本地 18 点 → 6 小时', () => {
  const H = 480
  const localMidnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0) - 8 * HOUR
  assert.equal(msUntilNextLocalMidnight(localMidnightUtc + 18 * HOUR, -H), 6 * HOUR)
})

test('msUntilNextLocalMidnight：恒在 (0, 24h]（含负 now）', () => {
  for (const tz of [0, -480, 480, -330]) {
    for (let t = -2 * DAY; t < 2 * DAY; t += 3600_000) {
      const d = msUntilNextLocalMidnight(t, tz)
      assert.ok(d > 0 && d <= DAY, `tz=${tz} now=${t} 得到 ${d}`)
    }
  }
})

// ---------- 结构自检 ----------

test('HISTORY_PROVIDERS 恰好是四家国内版', () => {
  assert.deepEqual([...HISTORY_PROVIDERS], ['workbuddy', 'trae', 'minimax', 'qoder'])
})

test('localDateOf：用本地时区而非 UTC', () => {
  // UTC 2026-01-01 23:00 = UTC+8 的 2026-01-02 07:00
  const t = Date.UTC(2026, 0, 1, 23, 0, 0)
  const local = new Date(t)
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  assert.equal(localDateOf(t), expected, '必须跟 Date 的本地解析一致')
})
