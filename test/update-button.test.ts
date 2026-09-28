import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

/**
 * 「服务」页的更新按钮状态机，以及重启代理的确认文案。
 *
 * 底层接口本来就齐了（只读的 GET /api/update/check、带二次确认的 POST /api/update/apply），
 * 缺的只是面板上的入口。这套逻辑住在 index.html 里，所以照样把 <script> 抽出来沙箱求值。
 *
 * 要钉住的是五个状态不能串：特别是「正在更新」必须禁用——apply 会在磁盘上
 * 执行 git merge，连点两次就是并发写同一个 .git/index.lock。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

function loadPanel() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, 'index.html 里应有 <script> 块')
  const pure = m[1].split('/* ================= 渲染总入口 ================= */')[0]
  const src = pure + '\n; return { updateButtonState, restartConfirmText };'
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
const repos = (has: number) => Array.from({ length: 3 }, (_, i) => ({
  name: `r${i}`, current: '1.0.0', latest: has > i ? '2.0.0' : '1.0.0', hasUpdate: has > i,
}))

test('没查过 / 没有更新：只给「检测更新」，不显示「立即更新」', () => {
  const s = panel.updateButtonState(null, false)
  assert.equal(s.showApply, false, '还不知道有没有更新，不该先摆一个「立即更新」')
  assert.equal(s.disabled, false, '检测按钮必须可点')
  assert.match(s.checkLabel, /检测/)
})

test('查过且全部最新：仍可重新检测，「立即更新」不出现', () => {
  const s = panel.updateButtonState(repos(0), false)
  assert.equal(s.showApply, false)
  assert.equal(s.disabled, false)
})

test('有更新：两个按钮都在，并说出是哪几个仓', () => {
  const s = panel.updateButtonState(repos(2), false)
  assert.equal(s.showApply, true)
  assert.equal(s.disabled, false, '此时必须能点')
  assert.match(s.why, /r0/)
  assert.match(s.why, /r1/)
  assert.ok(!/r2/.test(s.why), '不该把已经最新的仓也说成要更新')
})

test('正在应用：两个按钮都必须禁用', () => {
  const s = panel.updateButtonState(repos(2), true)
  assert.equal(s.disabled, true, 'apply 在写 .git/index.lock，连点就是自己撞自己')
  assert.equal(s.showApply, false, '应用中不该再摆一个可点的「立即更新」')
  assert.match(s.checkLabel, /正在|更新中|\.\.\./)
})

test('完成后：不再显示「立即更新」，并说明要重启才生效', () => {
  const s = panel.updateButtonState(repos(0), false, { ok: true, text: '已更新到 v2.0.0' })
  assert.equal(s.showApply, false)
  assert.equal(s.disabled, false, '完成后要能再检测一次')
  assert.match(s.done, /重启/)
  assert.match(s.done, /2\.0\.0/)
})

test('失败：如实显示服务端原因，不假装成功、也不隐藏', () => {
  const s = panel.updateButtonState(repos(2), false, { ok: false, text: '本地有改动或分叉，跳过自动更新' })
  assert.match(s.done, /本地有改动或分叉/)
  assert.ok(!/已更新/.test(s.done), '失败文案里不能出现「已更新」')
})

test('待重启标记：即使已全部最新也要显示（这是后台自动合并的结果）', () => {
  // 关键场景：所有仓都已是最新，但其中三个刚被后台自动合并过，磁盘上的代码是新的、
  // 跑着的进程是旧的。不显示的话使用者永远不知道自己其实已经更新过了。
  const s = panel.updateButtonState(repos(0), false, undefined, { repos: ['workbuddy-proxy', 'trae-proxy', 'minimax-proxy'] })
  assert.match(s.pending, /workbuddy-proxy/)
  assert.match(s.pending, /重启/)
})

test('待重启标记含 agent-hub 时要点明「本面板需手动重启」', () => {
  // 只写「重启 3 个代理」是不够的：面板重启不了自己，照着做的人会发现点了没用。
  const s = panel.updateButtonState(repos(0), false, undefined, {
    repos: ['workbuddy-proxy', 'agent-hub'], latest: { 'workbuddy-proxy': '1.3.20' },
  })
  assert.match(s.pending, /agent-hub/)
  assert.match(s.pending, /手动重启|手动执行/, '必须区分自身与代理的生效方式')
})

test('没有待重启标记时不显示该条（不留空占位）', () => {
  const s = panel.updateButtonState(repos(0), false, undefined, { repos: [] })
  assert.equal(s.pending, '')
})

test('结果优先于「有更新」：刚失败完不该又催你点更新', () => {
  const s = panel.updateButtonState(repos(2), false, { ok: false, text: 'git fetch 失败' })
  assert.equal(s.showApply, false, '同一次会话里不该在失败提示旁边还摆一个立即更新')
  assert.match(s.done, /git fetch 失败/)
})

// ---------- 重启确认框的文案：两头都不能说错 ----------

const targets = [
  { repo: 'workbuddy-proxy', ports: [39301, 39302] },
  { repo: 'trae-proxy', ports: [39303, 39304] },
  { repo: 'minimax-proxy', ports: [39305, 39306] },
]

test('确认框必须说清「请求会失败、需要重发」', () => {
  const t = panel.restartConfirmText(targets)
  assert.match(t, /请求/, '必须提到请求会受影响')
  assert.match(t, /重发|重新发送/, '必须说明用户要做什么')
})

test('确认框必须说清「对话记录不会丢失」', () => {
  // 少了这一句就是在隐瞒风险：用户会以为整个对话没了，从而不敢点
  const t = panel.restartConfirmText(targets)
  assert.match(t, /对话记录不会丢失/)
})

test('确认框必须说清「本面板不在其中」', () => {
  // agent-hub 正在处理这个请求，重启不了自己。不说清楚会让人以为刷新后整个界面也换了
  const t = panel.restartConfirmText(targets)
  assert.match(t, /本面板/)
  assert.match(t, /无法重启自己|不在其中/)
})

test('确认框列出会重启哪几个、哪些端口', () => {
  const t = panel.restartConfirmText(targets)
  for (const g of targets) {
    assert.match(t, new RegExp(g.repo))
    for (const p of g.ports) assert.ok(t.includes(':' + p), `应列出端口 ${p}`)
  }
})

test('目标缺失时不炸，且如实说「未获取到」', () => {
  assert.doesNotThrow(() => panel.restartConfirmText(undefined))
  assert.doesNotThrow(() => panel.restartConfirmText([]))
  assert.match(panel.restartConfirmText([]), /未获取到代理列表/)
})
