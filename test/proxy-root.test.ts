/**
 * proxy-root 的测试。
 *
 * 这套逻辑的失败方式很隐蔽：解析错了**不抛异常**，面板照样起得来，
 * 只是积分读空、重启按钮没反应。所以每一条都在钉「解析结果对不对」，
 * 而不是「有没有报错」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveProxyRoot, readManifestProxyRoot, suiteDir, SUITE_ROOT_ENV, SUITE_MANIFEST } from '../src/proxy-root.ts'

function tmpHub(manifest?: string): { hubRoot: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'suite-'))
  const hubRoot = join(base, 'agent-hub')
  mkdirSync(hubRoot, { recursive: true })
  if (manifest !== undefined) {
    writeFileSync(join(hubRoot, SUITE_MANIFEST), manifest, 'utf8')
  }
  return { hubRoot, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('环境变量优先级最高，能覆盖声明文件', () => {
  const { hubRoot, cleanup } = tmpHub(JSON.stringify({ proxyRoot: '/from/manifest' }))
  try {
    const root = resolveProxyRoot(hubRoot, { [SUITE_ROOT_ENV]: '/from/env' })
    // 用 resolve() 归一化后比较：Windows 上 resolve('/from/env') 得到的是
    // 盘符开头的形式，直接比字面量会因平台差异而假红。
    assert.equal(root, resolve('/from/env'), '环境变量应当压过声明文件——它就是临时覆盖用的')
    assert.notEqual(root, resolve('/from/manifest'))
  } finally { cleanup() }
})

test('没有环境变量时用声明文件里的 proxyRoot', () => {
  const { hubRoot, cleanup } = tmpHub(JSON.stringify({ proxyRoot: '/from/manifest' }))
  try {
    assert.equal(resolveProxyRoot(hubRoot, {}), resolve('/from/manifest'))
  } finally { cleanup() }
})

test('声明文件里的绝对路径不被静默改写', () => {
  // Windows 上 isAbsolute('/from/x') 是 false（前导斜杠不算绝对路径），
  // 若只信 isAbsolute，就会走相对分支、resolve 给它补上盘符变成 C:\from\x——
  // 声明文件里写 POSIX 风格绝对路径被悄悄改了地方。
  // 这条钉住「以斜杠或盘符开头都算绝对路径」。
  const { hubRoot, cleanup } = tmpHub(JSON.stringify({ proxyRoot: '/from/manifest' }))
  try {
    assert.equal(readManifestProxyRoot(join(hubRoot, SUITE_MANIFEST)), resolve('/from/manifest'))
  } finally { cleanup() }
})

test('声明文件里的相对路径按文件所在目录解析，不按进程 cwd', () => {
  // cwd 会随调用方变化（钩子、计划任务、面板自身各不相同）。
  // 按 cwd 解析会让同一条配置在不同启动方式下指向不同目录——
  // 这种错误只在「某种启动方式下积分是空的」时才显形，极难定位。
  const { hubRoot, cleanup } = tmpHub(JSON.stringify({ proxyRoot: '../siblings' }))
  try {
    // 期望值 = 声明文件所在目录（hub 自己）的上一级再拼 siblings
    const expected = resolve(hubRoot, '..', 'siblings')
    assert.equal(resolveProxyRoot(hubRoot, {}), expected)
    // 显式排除「按 cwd 解析」这个错误实现
    assert.notEqual(resolveProxyRoot(hubRoot, {}), resolve('siblings'))
  } finally { cleanup() }
})

test('声明文件缺失/损坏时退回 hub 上一级，不抛异常', () => {
  // 声明文件是「可选增强」：它坏了不该让面板起不来。
  // 退回旧行为继续工作，好过抛异常把面板自己拖死。
  const cases: Array<[string, string | undefined]> = [
    ['文件不存在', undefined],
    ['JSON 语法坏', '{ 这不是 JSON'],
    ['proxyRoot 缺失', JSON.stringify({ other: 1 })],
    ['proxyRoot 是空串', JSON.stringify({ proxyRoot: '   ' })],
    ['proxyRoot 类型不对', JSON.stringify({ proxyRoot: 123 })],
  ]
  for (const [why, manifest] of cases) {
    const { hubRoot, cleanup } = tmpHub(manifest)
    try {
      const root = resolveProxyRoot(hubRoot, {})
      assert.ok(root, `${why}：应回退到某个确定的目录，而不是 undefined`)
      assert.ok(
        root.endsWith('agent-hub') === false,
        `${why}：回退值是 hub 的上一级，不该等于 hub 自己（${root}）`,
      )
    } finally { cleanup() }
  }
})

test('兜底是 hub 的上一级，平级与嵌套布局都能命中', () => {
  // 两种布局下代理目录名都没变，所以「上一级」这个兜底对两者都成立：
  //   平级：opencode\agent-hub  + opencode\trae-proxy
  //   嵌套：proxy-suite\agent-hub + proxy-suite\trae-proxy
  const { hubRoot, cleanup } = tmpHub()
  try {
    assert.equal(resolveProxyRoot(hubRoot, {}), resolve(hubRoot, '..'))
  } finally { cleanup() }
})

test('dirName="." 是 hub 自己，其余是 proxyRoot 下的兄弟目录', () => {
  const root = '/s/agent-hub'
  const proxyRoot = '/s'
  assert.equal(suiteDir('.', proxyRoot, root), root)
  assert.equal(suiteDir('trae-proxy', proxyRoot, root), join(proxyRoot, 'trae-proxy'))
  // 这一条钉住当年那个坑：join(root,'..','.') 在 Windows 上得到 '...\.'
  assert.ok(!suiteDir('.', proxyRoot, root).endsWith('.'), 'hub 自己不该解析成以 "." 结尾的路径')
})

test('readManifestProxyRoot 对缺失文件返回 null，而不是抛错', () => {
  const { hubRoot, cleanup } = tmpHub()
  try {
    assert.equal(readManifestProxyRoot(join(hubRoot, SUITE_MANIFEST)), null)
  } finally { cleanup() }
})
