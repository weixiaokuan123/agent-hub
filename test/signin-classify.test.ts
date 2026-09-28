import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

/**
 * 签到状态的分类判定。
 *
 * 这套逻辑住在 index.html 里（单文件面板，没有模块系统），所以这里直接把
 * <script> 抽出来在沙箱里求值后驱动它——用构造数据而不是真实 API，
 * 这样测试不依赖「代理正在跑」，在 CI 上也能过。
 *
 * 要钉住的核心性质：**「这个号/这个区就是没有签到活动」绝不能进待办**。
 * 判错的代价不是显示难看，而是面板每天都会亮一条红灯，点不动也修不了，
 * 久而久之就没人看「需要处理」了。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

function loadPanel() {
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m, 'index.html 里应有 <script> 块')
  // 只取到渲染总入口之前：那里是纯函数，不依赖真实 DOM
  const pure = m[1].split('/* ================= 渲染总入口 ================= */')[0]
  // DATA 是被求值那段脚本里的 let，闭包内可以直接赋值，
  // 所以额外吐一个 __setData —— 不必为了测试去改 index.html。
  const src = pure +
    '\n; return { __setData: d => { DATA = d }, signinStats, collectAttention, isLiveSlot, hasVerdict, isBlocked, uniqueTargets };'
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

/** 造一个最小的 legacy 形状区域（Trae / MiniMax 那类聚合 view）。 */
function region(over: Record<string, unknown>) {
  return {
    id: 'r1', provider: 'P', label: '国内版', port: 1, running: true,
    auth: { state: 'signed-in', account: 'a@example.org' },
    models: [], signin: null, travel: null,
    ...over,
  } as never
}

function withSignin(signin: Record<string, unknown>) {
  return region({ signin })
}

// ---------- 「没有签到活动」必须归为已知情况，不是待办 ----------

test('账号级：签到活动未开启 -> unsupported，措辞为账号级', () => {
  for (const msg of ['签到活动未开启', '活动未开启', '不适用']) {
    const si = panel.signinStats(withSignin({ claimedToday: false, lastResult: msg, view: {} }))
    assert.equal(si.legacy?.unsupported, true, `"${msg}" 应判为 unsupported`)
    assert.equal(si.legacy?.unsupportedLabel, '该账号未开启签到')
  }
})

test('区域级：文案含「不支持」-> unsupported，措辞为区域级', () => {
  // 实测文案是「国际区暂不支持自动签到」，以「国际区暂」开头而不是「不支持」，
  // 所以判定必须是子串匹配而不是前缀匹配。
  const si = panel.signinStats(withSignin({ claimedToday: true, lastResult: '国际区暂不支持自动签到', view: { enabled: false } }))
  assert.equal(si.legacy?.unsupported, true)
  assert.equal(si.legacy?.unsupportedLabel, '该区不签到')
})

test('view.enabled 为 undefined 时也要能判出 unsupported（真实踩过的坑）', () => {
  // workbuddy-global 实测：view.enabled 是 undefined、view.active 才是 false，
  // 只认 enabled === false 会漏判，于是这条每天都被当成待办。
  const si = panel.signinStats(withSignin({ claimedToday: false, lastResult: '签到活动未开启', view: { active: false } }))
  assert.equal(si.legacy?.unsupported, true)
})

// ---------- 别把真问题也一起藏了 ----------

test('可重试的报错绝不能被判为 unsupported', () => {
  for (const msg of ['失败：登录态 token 已加密', '失败：网络超时', '失败：HTTP 502', '失败：余额不足']) {
    const si = panel.signinStats(withSignin({ claimedToday: false, lastResult: msg, view: { enabled: true } }))
    assert.equal(si.legacy?.unsupported, false, `"${msg}" 不该被判为 unsupported`)
  }
})

test('已领取的账号不算 unsupported', () => {
  const si = panel.signinStats(withSignin({ claimedToday: true, lastResult: '签到成功，+100 积分（连签 5 天）', view: { enabled: true } }))
  assert.equal(si.legacy?.checked, true)
  assert.equal(si.legacy?.unsupported, false)
})

// ---------- 端到端：待办列表里不许出现「未开启/不支持」 ----------

test('collectAttention：「未开启/不支持签到」既不进待办也不进已知情况', () => {
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [
        region({ id: 'a1', auth: { state: 'signed-in' } }),
        withSignin({ claimedToday: false, lastResult: '签到活动未开启', view: { active: false } }),
      ],
    },
    wbCredits: null,
  })
  const { todo, note } = panel.collectAttention()
  const bad = [...todo, ...note].filter(x => /未开启|不支持/.test(x.text) || /未开启|不支持/.test(x.why))
  assert.equal(bad.length, 0, `提醒面板里不该有未开启/不支持，实际: ${JSON.stringify(bad)}`)
})

// ---------- 桌面端登录槽位：永不进待办，但必须露出来 ----------

/** 造一个带 targets 的 WorkBuddy 形状区域。 */
function wbRegion(targets: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: 'w1', provider: 'WorkBuddy', label: '国内版', port: 39301, running: true,
    auth: { state: 'signed-in', account: 'a' },
    models: [],
    signin: { claimedToday: false, lastResult: '', view: {}, targets },
    travel: null,
    ...over,
  } as never
}

const acct = (label: string, claimed: boolean, lastResult = '') =>
  ({ id: `acct:switch:${label}`, label, claimedToday: claimed, lastResult })

const live = (id: string, label: string, claimed: boolean, lastResult = '') =>
  ({ id, label, claimedToday: claimed, lastResult })

test('signinStats：live 槽位一律不进进度，即使还没试过', () => {
  // 刚过 0 点、状态文件还是空白的情形：之前这里会以「待签到」混进需要处理，
  // 而它今天注定签不到（token 被桌面端加密）——每天早上必亮一次的假警报。
  const si = panel.signinStats(wbRegion([
    live('live-cn', 'cn·当前登录', false, ''),
    acct('cn·甲', true, '今天已签到（连签 12 天）'),
    acct('cn·乙', true, '签到成功，+100 积分'),
  ]))
  assert.equal(si.total, 2, '分母只算真实账号')
  assert.equal(si.done, 2)
  assert.equal(si.done, si.total, '不该出现待办')
  assert.equal(si.targets.some(t => panel.isLiveSlot(t)), false, 'live 槽位不该出现在进度里')
  assert.equal(
    Object.prototype.hasOwnProperty.call(si, 'liveTargets'),
    false,
    'liveTargets 已无人使用，不该留死字段',
  )
})

test('collectAttention：live 槽位既不进待办也不进已知情况', () => {
  // 用户明确要求过「账号能正常读取时不要强调这点」——该区域在账号卡上已经
  // 呈现为「可用 · 账号库 N 个账号」，提醒面板不该再复述一遍。
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [wbRegion([
        live('live-cn', 'cn·当前登录', false, ''),
        acct('cn·甲', true, '今天已签到'),
        acct('cn·乙', true, '签到成功'),
      ])],
    },
    wbCredits: null,
  })
  const { todo, note } = panel.collectAttention()
  assert.equal(todo.length, 0, `不该有待办，实际: ${JSON.stringify(todo)}`)
  assert.equal(note.length, 0, `也不该有已知情况，实际: ${JSON.stringify(note)}`)
})

test('collectAttention：真实账号待签到仍必须进待办（别一起藏了）', () => {
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [wbRegion([
        live('live-cn', 'cn·当前登录', false, ''),
        acct('cn·甲', true, '今天已签到'),
        acct('cn·乙', false, ''),          // 真的还没签
      ])],
    },
    wbCredits: null,
  })
  const { todo } = panel.collectAttention()
  assert.equal(todo.length, 1, `应恰好 1 条待办，实际: ${JSON.stringify(todo)}`)
  assert.ok(/cn·乙/.test(todo[0].text), `待办应指向真实账号，实际: ${todo[0].text}`)
})

test('collectAttention：「不签到」是静态属性，不进提醒面板（账号卡上已写明）', () => {
  const setData = panel.__setData as (d: unknown) => void
  // workbuddy-global 的真实形状：真实账号被剔光 → 落到 legacy 分支
  setData({
    overview: {
      regions: [region({
        id: 'w2', provider: 'WorkBuddy', label: '国际版', port: 39302,
        auth: { state: 'signed-in', account: 'a' },
        signin: {
          claimedToday: false, lastResult: '签到活动未开启', view: {},
          targets: [live('live-global', 'global·当前登录', false, '签到活动未开启')],
        },
      })],
    },
    wbCredits: null,
  })
  const { todo, note } = panel.collectAttention()
  assert.equal(todo.length, 0, `不该有待办，实际: ${JSON.stringify(todo)}`)
  assert.equal(note.length, 0, `静态属性不该反复播报，实际: ${JSON.stringify(note)}`)
})

test('collectAttention：Trae 国际版「该区不签到」同样不进提醒面板', () => {
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [region({
        id: 't1', provider: 'Trae', label: '国际版',
        signin: { claimedToday: true, lastResult: '国际区暂不支持自动签到', view: { enabled: false } },
      })],
    },
    wbCredits: null,
  })
  const { todo, note } = panel.collectAttention()
  assert.equal(todo.length, 0)
  assert.equal(note.length, 0, `静态属性不该进面板，实际: ${JSON.stringify(note)}`)
})

test('collectAttention：真的受阻（有过失败记录）仍要报在已知情况', () => {
  // 与上面几条的区别：这不是静态属性，而是「试过了、卡住了」，值得你知道。
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [wbRegion([
        acct('cn·甲', true, '今天已签到'),
        acct('cn·乙', false, '失败：上游 500，请稍后重试'),
      ])],
    },
    wbCredits: null,
  })
  const { todo, note } = panel.collectAttention()
  assert.equal(todo.length, 0, `有失败结论的不该算待办，实际: ${JSON.stringify(todo)}`)
  assert.equal(note.length, 1, `应报在已知情况，实际: ${JSON.stringify(note)}`)
  assert.match(note[0].why, /^受阻/)
})

test('collectAttention：真·待办仍必须留着（未登录这类）', () => {
  const setData = panel.__setData as (d: unknown) => void
  setData({
    overview: {
      regions: [region({ id: 'u1', provider: 'MiniMax', label: '国际版', auth: { state: 'signed-out' } })],
    },
    wbCredits: null,
  })
  const { todo } = panel.collectAttention()
  assert.equal(todo.length, 1, `未登录必须仍是待办，实际: ${JSON.stringify(todo)}`)
  assert.equal(todo[0].why, '未登录')
})
