import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isNewer, maxSemverTag, parseSemver } from '../src/updater.ts'

/**
 * 版本比较与「取最新 tag」。
 *
 * 这组用例的由来是一个静默失效：GitHub 的 `/tags` 接口**不按 semver 排序**
 * （大致按创建时间倒序），而原实现取的是「第一个匹配 semver 的 tag」。
 * 只要哪天补一个旧版本的 tag，它就可能排到最前面，更新器从此认定「远端最新
 * 就是那个旧版本」，hasUpdate 恒为 false——自动更新从此静默失效，而且没有任何
 * 报错。所以这里必须钉住「按 semver 取最大」这个性质，而不是某次具体的返回值。
 */

test('parseSemver：容忍 v 前缀 / 大写 V / 前后空白 / 非 semver', () => {
  assert.deepEqual(parseSemver('1.3.18'), [1, 3, 18])
  assert.deepEqual(parseSemver('v1.3.18'), [1, 3, 18])
  assert.deepEqual(parseSemver('V1.3.18'), [1, 3, 18])
  assert.deepEqual(parseSemver('  v1.3.18  '), [1, 3, 18])
  assert.deepEqual(parseSemver('nightly'), [0, 0, 0])
  assert.deepEqual(parseSemver(''), [0, 0, 0])
})

test('isNewer：逐段比较，不是字符串比较', () => {
  assert.equal(isNewer('1.3.10', '1.3.9'), true, '1.3.10 > 1.3.9（字符串比会判错）')
  assert.equal(isNewer('1.3.9', '1.3.10'), false)
  assert.equal(isNewer('1.10.0', '1.9.0'), true)
  assert.equal(isNewer('2.0.0', '1.99.99'), true)
  assert.equal(isNewer('1.3.18', '1.3.18'), false)
  assert.equal(isNewer('v1.3.18', '1.3.18'), false, 'v 前缀不应影响比较')
})

test('maxSemverTag：旧 tag 排在最前时仍取版本号最大的', () => {
  // 这正是 GitHub 会返回的顺序：v1.3.9 比 v1.3.18 晚创建（补过历史 tag）
  const tags = ['v1.3.9', 'v1.3.7', 'v1.3.18', 'v1.3.15', 'v1.3.10']
  assert.equal(maxSemverTag(tags), 'v1.3.18')
  // 顺序反过来也一样——性质与顺序无关才是关键
  assert.equal(maxSemverTag([...tags].reverse()), 'v1.3.18')
})

test('maxSemverTag：忽略非 semver 的 tag，不会被它们带偏', () => {
  const tags = ['nightly', 'latest', 'release-candidate', 'v1.3.18', 'some-tag', 'v1.2.0']
  assert.equal(maxSemverTag(tags), 'v1.3.18')
})

test('maxSemverTag：v 前缀可有可无，混用也能正确比较', () => {
  assert.equal(maxSemverTag(['v1.3.18', '1.4.0']), '1.4.0')
  assert.equal(maxSemverTag(['1.3.18', 'v1.4.0']), 'v1.4.0')
})

test('maxSemverTag：空表 / 全是非 semver 时返回 undefined（而不是编一个 0.0.0）', () => {
  assert.equal(maxSemverTag([]), undefined)
  assert.equal(maxSemverTag(['nightly', 'latest']), undefined)
  // 这是关键：若退化成一个假版本，parseSemver 会得到 [0,0,0]，
  // hasUpdate 便恒为 false，且看上去「一切正常」。
})

test('maxSemverTag：单个元素与全同版本', () => {
  assert.equal(maxSemverTag(['v1.3.18']), 'v1.3.18')
  assert.equal(maxSemverTag(['v1.3.18', 'v1.3.18']), 'v1.3.18')
})

test('maxSemverTag：不改动入参', () => {
  const tags = ['v1.3.9', 'v1.3.18']
  const snapshot = [...tags]
  maxSemverTag(tags)
  assert.deepEqual(tags, snapshot)
})
