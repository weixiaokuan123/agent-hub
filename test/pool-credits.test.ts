/**
 * agent-hub 池化积分解析测试（无网络，纯函数）。
 *
 * 背景：WorkBuddy 已从「每账号一个端口」改为「单一入口 + 全池自动切换」，
 * 面板数据源随之从扫描 acct-N.key 改为读 /status 的 pool.entries。
 *
 * 覆盖：
 *  1. 正常池：多个账号各自积分被正确展开、小计求和
 *  2. 某账号积分缺失 → 该条带 creditsError，其余条目照常
 *  3. 某账号 creditsError 透传
 *  4. /status 未提供 pool 字段 → 返回空数组（不抛错）
 *  5. 畸形输入（null / 字符串 / entries 非数组）→ 空数组，不抛
 *  6. label 缺失时退回占位名，不产生 undefined 展示
 *
 * 运行：node --test test/pool-credits.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parsePoolEntries } from '../src/server.ts'

test('正常池：展开每个账号的积分', () => {
  const entries = parsePoolEntries({
    pool: {
      size: 3,
      entries: [
        { id: 'live-cn', label: 'cn·当前登录', preferred: true, rateLimited: false, remainingSec: 0, credits: 2069, packages: 10 },
        { id: 'acct:1', label: 'cn·什么铁环', preferred: false, rateLimited: false, remainingSec: 0, credits: 1382, packages: 20 },
        { id: 'acct:2', label: 'cn·18180938113', preferred: false, rateLimited: true, remainingSec: 900, credits: 2071, packages: 4 },
      ],
    },
  }, 39301)

  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => e.total), [2069, 1382, 2071])
  assert.deepEqual(entries.map(e => e.packages), [10, 20, 4])
  assert.ok(entries.every(e => e.port === 39301))
  assert.ok(entries.every(e => e.error === undefined))
  // 冷却中的账号仍有积分，不因此被剔除
  assert.equal(entries[2]?.total, 2071)
})

test('某账号积分缺失 → 该条带 creditsError，其余照常', () => {
  const entries = parsePoolEntries({
    pool: {
      entries: [
        { label: 'cn·当前登录', credits: 100, packages: 1 },
        { label: 'cn·掉线账号' }, // 无 credits
        { label: 'cn·另一个', credits: 200, packages: 2 },
      ],
    },
  }, 39301)

  assert.equal(entries.length, 3)
  assert.equal(entries[0]?.total, 100)
  assert.equal(entries[1]?.total, undefined)
  assert.equal(entries[1]?.error, '积分未知')
  assert.equal(entries[2]?.total, 200)
})

test('上游给的 creditsError 被透传', () => {
  const entries = parsePoolEntries({
    pool: { entries: [{ label: 'cn·坏号', creditsError: 'token 已过期' }] },
  }, 39301)
  assert.equal(entries[0]?.error, 'token 已过期')
})

test('没有 pool 字段 → 空数组，不抛错', () => {
  assert.deepEqual(parsePoolEntries({ auth: { account: 'x' } }, 39301), [])
})

test('畸形输入 → 空数组，不抛错', () => {
  assert.deepEqual(parsePoolEntries(null, 39301), [])
  assert.deepEqual(parsePoolEntries('oops', 39301), [])
  assert.deepEqual(parsePoolEntries({ pool: { entries: 'not-array' } }, 39301), [])
  assert.deepEqual(parsePoolEntries({ pool: {} }, 39301), [])
})

test('label 缺失时退回占位名（不出现 undefined）', () => {
  const entries = parsePoolEntries({
    pool: { entries: [{ credits: 5, packages: 1 }] },
  }, 39302)
  assert.equal(entries[0]?.label, '端口 39302')
  assert.ok(!String(entries[0]?.label).includes('undefined'))
})

test('小计语义：总和忽略查不到的账号', () => {
  const entries = parsePoolEntries({
    pool: {
      entries: [
        { label: 'a', credits: 10, packages: 1 },
        { label: 'b' },
        { label: 'c', credits: 32, packages: 1 },
      ],
    },
  }, 39301)
  const total = entries.reduce((sum, e) => sum + (e.total ?? 0), 0)
  assert.equal(total, 42)
})