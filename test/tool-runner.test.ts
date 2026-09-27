import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCliOutput, describeExitCode, CLI_CWD } from '../src/tool-runner.ts'

/**
 * 这一组用例钉住的是「CLI 输出怎么被理解」这件事本身。
 *
 * 背景：myuseofminerU 的 CLI 有一个不对称行为——成功时 stdout 是 JSON，
 * 但**参数错误（退出码 2）时 stdout 是空的，错误信息只在 stderr**。
 * 如果实现假设「有退出码就一定有 JSON」，那么在用户输错路径这个最常见
 * 的场景上就会抛异常，而不是给出可读提示。这里的每一条都对应实测过的
 * 真实输出。
 */

test('parseCliOutput：成功路径，输出合法 JSON', () => {
  const stdout = JSON.stringify({ ok: true, plan: [], quota_files_remaining: 5000 })
  const r = parseCliOutput(0, stdout, '')
  assert.equal(r.code, 0)
  assert.equal(r.ok, true)
  assert.deepEqual(r.json, { ok: true, plan: [], quota_files_remaining: 5000 })
})

test('parseCliOutput：退出码 2 时 stdout 为空，错误在 stderr，不得抛异常', () => {
  const r = parseCliOutput(2, '', '[ERROR] 输入目录不存在: X:\\nope\n')
  assert.equal(r.code, 2)
  assert.equal(r.ok, false)
  assert.equal(r.json, null)
  assert.match(r.stderr, /输入目录不存在/)
})

test('parseCliOutput：stdout 被日志行污染时，仍提取出 JSON', () => {
  const stdout = '正在初始化…\n' + JSON.stringify({ ok: true, plan: [] }) + '\n完成\n'
  const r = parseCliOutput(0, stdout, '')
  assert.deepEqual(r.json, { ok: true, plan: [] })
  assert.equal(r.ok, true)
})

test('parseCliOutput：stdout 完全不是 JSON 时不抛异常', () => {
  const r = parseCliOutput(1, '这不是 JSON', '')
  assert.equal(r.json, null)
  assert.equal(r.ok, false)
  assert.equal(r.code, 1)
})

test('parseCliOutput：stdout 里有花括号但不合法时降级为 null', () => {
  const r = parseCliOutput(0, 'config = { not json }', '')
  assert.equal(r.json, null)
})

test('describeExitCode：六个语义码都能给出中文说明', () => {
  assert.match(describeExitCode(0), /成功/)
  assert.match(describeExitCode(2), /参数/)
  assert.match(describeExitCode(3), /部分/)
  assert.match(describeExitCode(4), /失败/)
  assert.match(describeExitCode(5), /额度|密钥/)
  assert.match(describeExitCode(6), /续跑|未完成/)
})

test('describeExitCode：未知码不抛异常', () => {
  assert.equal(typeof describeExitCode(99), 'string')
})

test('CLI_CWD 指向 myuseofminerU 目录', () => {
  assert.match(CLI_CWD, /myuseofminerU$/)
})
