/**
 * agent-hub Qoder 区域映射测试。
 *
 * 覆盖 qoder-proxy /status 响应到面板视图的映射，包括：
 * - 已登录 / 未登录
 * - 账号标识优先级（邮箱 > 手机 > 昵称）
 * - 额度、套餐、签到字段
 *
 * 运行：node --test test/qoder-status.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mapQoderRegion } from '../src/server.ts'

test('mapQoderRegion：未登录时给出 error，不填账号', () => {
  const v = mapQoderRegion({ region: 'cn', loggedIn: false, error: 'no-auth-file', message: '找不到登录凭据' }, 'cn', '国内版', 39320)
  assert.equal(v.loggedIn, false)
  assert.equal(v.error, '找不到登录凭据')
  assert.equal(v.account, undefined)
})

test('mapQoderRegion：未登录且无 message 时回退到 code', () => {
  const v = mapQoderRegion({ region: 'cn', loggedIn: false, error: 'no-auth-file' }, 'cn', '国内版', 39320)
  assert.equal(v.error, 'no-auth-file')
})

test('mapQoderRegion：未登录且无任何线索时显示「未登录」', () => {
  const v = mapQoderRegion({ region: 'cn', loggedIn: false }, 'cn', '国内版', 39320)
  assert.equal(v.error, '未登录')
})

test('mapQoderRegion：账号标识优先邮箱', () => {
  const v = mapQoderRegion(
    { loggedIn: true, email: 'a@b.c', phone: '13800000000', name: 'nick' },
    'global', '国际版', 39320,
  )
  assert.equal(v.account, 'a@b.c')
  assert.equal(v.loggedIn, true)
})

test('mapQoderRegion：无邮箱时用手机号（国内版）', () => {
  const v = mapQoderRegion(
    { loggedIn: true, email: '', phone: '17823437854', name: 'endlessworld17@gmail.com' },
    'cn', '国内版', 39320,
  )
  assert.equal(v.account, '17823437854')
})

test('mapQoderRegion：只有昵称时用昵称', () => {
  const v = mapQoderRegion({ loggedIn: true, name: 'efficient dignified' }, 'global', '国际版', 39320)
  assert.equal(v.account, 'efficient dignified')
})

test('mapQoderRegion：完整额度/套餐/签到映射', () => {
  const v = mapQoderRegion(
    {
      region: 'cn',
      loggedIn: true,
      email: 'a@b.c',
      tokenExpiresIn: '24 天后',
      plan: { planTierName: 'Pro Trial', userType: 'personal_professional_trial' },
      usage: { total: 300, used: 0, remaining: 300, unit: 'credits' },
      signin: {
        todayCheckedIn: true,
        claimable: false,
        claimableAmount: 0,
        hasBenefitCampaign: true,
        dailyCredit: 100,
        streakDays: 5,
      },
    },
    'cn', '国内版', 39320,
  )
  assert.equal(v.account, 'a@b.c')
  assert.equal(v.planName, 'Pro Trial')
  assert.equal(v.total, 300)
  assert.equal(v.remaining, 300)
  assert.equal(v.unit, 'credits')
  assert.equal(v.todayCheckedIn, true)
  assert.equal(v.hasBenefitCampaign, true)
  assert.equal(v.dailyCredit, 100)
  assert.equal(v.streakDays, 5)
  assert.equal(v.tokenExpiresIn, '24 天后')
})

test('mapQoderRegion：套餐缺 planTierName 时回退到 userType', () => {
  const v = mapQoderRegion(
    { loggedIn: true, plan: { userType: 'personal_standard' } },
    'global', '国际版', 39320,
  )
  assert.equal(v.planName, 'personal_standard')
})

test('mapQoderRegion：字段缺失时不产生 undefined 污染（属性应被省略）', () => {
  const v = mapQoderRegion({ loggedIn: true, email: 'a@b.c' }, 'cn', '国内版', 39320)
  assert.equal(v.total, undefined)
  assert.equal(v.remaining, undefined)
  assert.equal(v.todayCheckedIn, undefined)
  assert.equal('total' in v, false, '缺失字段不应写入属性')
})

test('mapQoderRegion：可领取状态映射', () => {
  const v = mapQoderRegion(
    {
      loggedIn: true,
      email: 'a@b.c',
      signin: { claimable: true, claimableAmount: 100, hasBenefitCampaign: true, dailyCredit: 100 },
    },
    'cn', '国内版', 39320,
  )
  assert.equal(v.claimable, true)
  assert.equal(v.claimableAmount, 100)
  assert.equal(v.todayCheckedIn, undefined, '未提供 todayCheckedIn 时不应臆断')
})

test('mapQoderRegion：区域国际版无签到活动', () => {
  const v = mapQoderRegion(
    { loggedIn: true, email: 'a@b.c', signin: { hasBenefitCampaign: false, dailyCredit: 100 } },
    'global', '国际版', 39320,
  )
  assert.equal(v.hasBenefitCampaign, false)
  assert.equal(v.region, 'global')
  assert.equal(v.label, '国际版')
  assert.equal(v.port, 39320)
})
