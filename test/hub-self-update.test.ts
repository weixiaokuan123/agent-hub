import assert from 'node:assert/strict'
import { test } from 'node:test'

import { UPDATABLE, selfRestartHint, canRestartFromPanel, resolveUpdateDir } from '../src/server.ts'

/**
 * agent-hub 自身也纳入自动更新。
 *
 * 之前 UPDATABLE 只有三个代理，于是**本面板的更新永远传不出去**——别人收不到，
 * 而 hub 恰恰是承载"自动更新"的那个仓。补上之后它和那三个走同一条路：
 * `git fetch` + `git merge --ff-only`。
 *
 * 唯一的差别是版本号来源：那三个是问代理的 /healthz，agent-hub 是读本地常量
 * （问自己没意义，进程跑的就是当前这版）。
 */

/** agent-hub 自己必须在列表里，否则它的更新永远推不出去 */
test('UPDATABLE 包含 agent-hub 自身', () => {
  const names = UPDATABLE.map(u => u.name)
  assert.ok(names.includes('agent-hub'), `UPDATABLE 应含 agent-hub，实际 ${names.join(', ')}`)
  assert.equal(names.length, 4, '三个代理 + 面板自己')
})

test('agent-hub 的版本来源是本地常量，而不是问某个端口', () => {
  const hub = UPDATABLE.find(u => u.name === 'agent-hub')
  assert.ok(hub, '应存在 agent-hub 条目')
  assert.equal(hub.source, 'local', '自身版本只能读本地常量')
  assert.equal(hub.repo, 'weixiaokuan123/agent-hub')
  // 自身没有可问的健康检查端口——写成一个假端口会让版本永远读成 undefined 而被跳过
  assert.equal(hub.port, undefined, '自身不应有 port，否则会被 /healthz 查询分支处理')
  assert.equal(hub.keyName, undefined)
})

test('三个代理仍是 source=remote（问 /healthz）', () => {
  for (const name of ['workbuddy-proxy', 'trae-proxy', 'minimax-proxy']) {
    const u = UPDATABLE.find(x => x.name === name)
    assert.ok(u, `${name} 应在列表里`)
    assert.equal(u.source, 'remote', `${name} 应继续问 /healthz`)
    assert.equal(typeof u.port, 'number')
  }
})

test('每个条目的 dirName 都非空（自身用 "." 表示 ROOT 本身）', () => {
  for (const u of UPDATABLE) {
    assert.equal(typeof u.dirName, 'string')
    assert.ok(u.dirName.length > 0, `${u.name} 的 dirName 不能为空`)
  }
  assert.equal(UPDATABLE.find(u => u.name === 'agent-hub')?.dirName, '.')
})

// ---------- 自身不能从面板里重启 ----------

test('面板不能重启自己：canRestartFromPanel 对 agent-hub 为 false', () => {
  // 端点由这个进程处理，它一死就没法再回响应。用分离脚本延迟重启又会让面板
  // 整个挂掉、失败时无从察觉——比代理重启的失败模式严重得多。所以明确不做。
  assert.equal(canRestartFromPanel('agent-hub'), false)
})

test('面板能重启那三个代理', () => {
  for (const name of ['workbuddy-proxy', 'trae-proxy', 'minimax-proxy']) {
    assert.equal(canRestartFromPanel(name), true, `${name} 应该能一键重启`)
  }
})

test('未知名字一律不当作「可重启」——默认必须安全', () => {
  assert.equal(canRestartFromPanel('something-else'), false)
  assert.equal(canRestartFromPanel(''), false)
})

// ---------- 手动重启指引 ----------

test('自身更新后必须给出可复制的手动重启命令', () => {
  const hint = selfRestartHint('agent-hub')
  assert.ok(hint, '应有提示')
  assert.match(hint, /stop\.ps1/, '必须写出实际命令，而不只是说「请重启」')
  assert.match(hint, /start\.ps1/)
  assert.match(hint, /agent-hub/, '要指明是哪个仓的目录')
})

test('代理的提示应指向面板上的重启按钮，而不是命令', () => {
  const hint = selfRestartHint('workbuddy-proxy')
  assert.ok(hint, '代理也该有说明，只是内容不同')
  assert.ok(!/stop\.ps1/.test(hint), '代理有一键按钮，不该让人手打命令')
})

// ---------- 行为：目录解析 ----------

test('dirName="." 解析成 ROOT 本身，不带尾部的 "."', () => {
  // join(ROOT,'..','.') 在 Windows 上得到 'C:\...\opencode\.' —— 是个合法路径，
  // git 在里面照样跑得通，所以这个错误**不会立刻暴露**，只会在日志里显示成诡异路径。
  const dir = resolveUpdateDir('.', 'C:\\a\\opencode\\agent-hub')
  assert.equal(dir, 'C:\\a\\opencode\\agent-hub')
  assert.ok(!dir.endsWith('.'), `不该以 "." 结尾：${dir}`)
})

test('代理目录从 proxyRoot 解析，不再从 hub 上一级硬推', () => {
  // 旧断言是「代理在 hub 的上一级」。四个仓搬进 proxy-suite\ 之后，
  // 「上一级」变成了 proxy-suite 的父目录，于是所有跨仓路径全错一位——
  // 而且**不报错**，只是积分读空、重启按钮没反应。
  // 所以这里显式传 proxyRoot，证明解析看的是它、而不是 ROOT 的父目录。
  const root = 'C:\\a\\proxy-suite\\agent-hub'
  const proxyRoot = 'C:\\a\\proxy-suite'
  assert.equal(resolveUpdateDir('trae-proxy', root, proxyRoot), 'C:\\a\\proxy-suite\\trae-proxy')
  assert.equal(resolveUpdateDir('workbuddy-proxy', root, proxyRoot), 'C:\\a\\proxy-suite\\workbuddy-proxy')
  assert.equal(resolveUpdateDir('minimax-proxy', root, proxyRoot), 'C:\\a\\proxy-suite\\minimax-proxy')

  // 关键回归：给了 proxyRoot 就绝不能退回「hub 的上一级」。
  // 上一级在嵌套布局下是 C:\\a，指过去等于指到一个跟代理毫无关系的目录。
  assert.notEqual(resolveUpdateDir('trae-proxy', root, proxyRoot), 'C:\\a\\trae-proxy')
})
