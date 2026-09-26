/**
 * agent-hub：三个本地代理（WorkBuddy / Trae / MiniMax）的统一可视化面板后端。
 *
 * 它不直接接触任何凭据，只通过各代理已有的回环 HTTP 接口聚合数据：
 *   GET  /healthz              面板自身存活
 *   GET  /api/overview         三平台账号/模型/签到汇总（并发拉取）
 *   POST /api/signin/claim     指定平台立即签到（幂等）
 *   GET  /api/services         各代理端口监听状态
 *
 * 安全：只听 127.0.0.1，回环 Host/Origin 校验；面板自身用固定 bearer；
 * 对代理的请求注入各自 keys/*.key。
 *
 * @module agent-hub/server
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_HUB_VERSION } from './version.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PUBLIC_DIR = join(ROOT, 'public')
const KEYS_DIR = join(ROOT, 'keys')

const PORT = Number(process.env['AGENT_HUB_PORT'] ?? 39310)
const HOST = '127.0.0.1'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

interface RegionDef {
  id: string
  provider: string
  label: string
  port: number
  keyName: string
  supportsSignin: boolean
}

/** 每个代理区域：端口与 key 文件名。支持 cn/en(global) 两区，未登录的自然显示未登录。 */
const REGIONS: RegionDef[] = [
  { id: 'workbuddy-cn', provider: 'WorkBuddy', label: '国内版', port: 39301, keyName: 'workbuddy-proxy/keys/cn.key', supportsSignin: true },
  { id: 'workbuddy-global', provider: 'WorkBuddy', label: '国际版', port: 39302, keyName: 'workbuddy-proxy/keys/global.key', supportsSignin: true },
  { id: 'trae-cn', provider: 'Trae', label: '国内版', port: 39303, keyName: 'trae-proxy/keys/cn.key', supportsSignin: true },
  { id: 'trae-ai', provider: 'Trae', label: '国际版', port: 39304, keyName: 'trae-proxy/keys/ai.key', supportsSignin: true },
  { id: 'minimax-cn', provider: 'MiniMax', label: '国内版', port: 39305, keyName: 'minimax-proxy/keys/cn.key', supportsSignin: true },
  { id: 'minimax-en', provider: 'MiniMax', label: '国际版', port: 39306, keyName: 'minimax-proxy/keys/en.key', supportsSignin: true },
]

/** 可自动更新的本地仓库（owner/name 与本地目录、健康检查端口）。 */
const UPDATABLE: Array<{ name: string; repo: string; dirName: string; port: number; keyName: string }> = [
  { name: 'workbuddy-proxy', repo: 'weixiaokuan123/workbuddy-proxy', dirName: 'workbuddy-proxy', port: 39301, keyName: 'workbuddy-proxy/keys/cn.key' },
  { name: 'trae-proxy', repo: 'weixiaokuan123/trae-proxy', dirName: 'trae-proxy', port: 39303, keyName: 'trae-proxy/keys/cn.key' },
  { name: 'minimax-proxy', repo: 'weixiaokuan123/minimax-proxy', dirName: 'minimax-proxy', port: 39305, keyName: 'minimax-proxy/keys/cn.key' },
]
const UPDATE_PENDING_FILE = join(ROOT, 'state', 'update-pending.json')
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000

/**
 * 日志落盘 + 运行期轮转。
 *
 * 历史上日志由 start.ps1 用 cmd 重定向（node ... >> out.log 2>> err.log），
 * 文件句柄在 cmd 手里 —— 本进程拿不到句柄，**无法在运行期轮转**，只能在重启时
 * 轮一次。后果是「长期不重启的进程，日志无上限增长」。
 *
 * 因此改为：若环境变量指明了日志路径，由本进程直接持有该文件并在超限时自行轮转；
 * 未设置（前台调试）时退回 stdout/stderr。
 *
 * 轮转策略与 start.ps1 里的 Rotate-Log 保持一致：超限改名为 .1，只保留一份。
 */

/** 单个日志文件上限，与 start.ps1 的 Rotate-Log 同一阈值。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

interface LogSink {
  path: string
  /** 当前文件已有字节数，作为轮转基线。 */
  size: number
}

function makeLogSink(envKey: string): LogSink | null {
  const p = process.env[envKey]
  if (p === undefined || p.trim() === '') return null
  try {
    mkdirSync(dirname(p), { recursive: true })
    // 追加而非截断：既有内容保留，并把当前大小作为轮转基线
    return { path: p, size: statSync(p, { throwIfNoEntry: false })?.size ?? 0 }
  } catch {
    return null // 建不出来就退回 stdout/stderr，不让日志问题拦住启动
  }
}

function writeLogSink(sink: LogSink, text: string): void {
  const bytes = Buffer.byteLength(text)
  if (sink.size + bytes > LOG_MAX_BYTES) {
    try {
      rmSync(`${sink.path}.1`, { force: true })
      renameSync(sink.path, `${sink.path}.1`)
      sink.size = 0
    } catch {
      // 轮转失败就继续往当前文件追加：丢日志比不轮转更糟
    }
  }
  appendFileSync(sink.path, text, 'utf8')
  sink.size += bytes
}

const LOG_OUT = makeLogSink('AGENT_HUB_LOG_OUT')
const LOG_ERR = makeLogSink('AGENT_HUB_LOG_ERR')

function ts(): string {
  return new Date().toISOString()
}

function log(level: string, ...args: unknown[]): void {
  const line = `[${ts()}] [${level}] ${args.map(String).join(' ')}\n`
  const sink = level === 'error' || level === 'warn' ? LOG_ERR : LOG_OUT
  if (sink !== null) {
    writeLogSink(sink, line)
  } else if (level === 'error' || level === 'warn') {
    process.stderr.write(line)
  } else {
    process.stdout.write(line)
  }
}

async function loadOrCreateHubKey(): Promise<string> {
  const file = join(KEYS_DIR, 'hub.key')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 生成
  }
  const key = randomBytes(32).toString('base64url')
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 })
  await writeFile(file, `${key}\n`, { mode: 0o600 })
  return key
}

/**
 * 区域 key 在进程运行期内不变，读到一次后驻留内存。
 * 读取失败（尤其 ENOENT = 代理还没生成 key）**不写入缓存**，
 * 否则代理稍后启动时这里仍会一直返回 null。
 */
const regionKeyCache = new Map<string, string>()

async function readRegionKey(keyName: string): Promise<string | null> {
  const cached = regionKeyCache.get(keyName)
  if (cached !== undefined) return cached
  try {
    const value = (await readFile(join(ROOT, '..', keyName), 'utf8')).trim()
    if (value === '') return null
    regionKeyCache.set(keyName, value)
    return value
  } catch {
    return null
  }
}

/** key 目录清单同样运行期不变；目录缺失（ENOENT，代理还没起来）不缓存。 */
const keyDirCache = new Map<string, string[]>()

async function readKeyDir(dirName: string): Promise<string[]> {
  const cached = keyDirCache.get(dirName)
  if (cached !== undefined) return cached
  try {
    const names = await readdir(join(ROOT, '..', dirName))
    keyDirCache.set(dirName, names)
    return names
  } catch {
    return []
  }
}

async function fetchJson(url: string, key?: string, method = 'GET', timeoutMs = 20000): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key !== undefined && key !== '') headers['Authorization'] = `Bearer ${key}`
    const res = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data: unknown = text
    try { data = JSON.parse(text) } catch { /* 保留原文 */ }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * WorkBuddy 积分汇总：live 国内(39301) + live 国际(39302) + 多账号
 * (keys 目录下 acct-*.key，端口 39320+ i)。缺失的 key 文件自动跳过。
 *
 * 两个要点：
 *  1. **按区域分组**：从各端口 /status 的 `auth.domain` 判断区域
 *     （www.codebuddy.cn → cn 国内版，www.workbuddy.ai → global 国际版），
 *     国内与国际分开列出，各自小计，互不混合。
 *  2. **同账号去重后不再列出**：live 端口与某个 acct 端口可能是同一个号
 *     （桌面端切号后 live 跟随），按账号标识（account / uin）去重，
 *     重复项直接丢弃，只保留 live 优先的那一条，不进入返回结果。
 */
interface WorkBuddyCreditEntry {
  label: string
  port: number
  /** 账号显示名（用于识别，仅本地面板展示）。 */
  account?: string
  total?: number
  packages?: number
  error?: string
}

interface WorkBuddyCreditGroup {
  region: 'cn' | 'global'
  label: string
  entries: WorkBuddyCreditEntry[]
  total: number
}

/**
 * 从 `/status` 响应里解析出池内账号的积分条目。
 *
 * 抽成纯函数以便测试：上游字段可能缺失/异常，这里逐条降级 ——
 * 某账号没有积分就带上 creditsError，而不是整块丢掉。
 */
export function parsePoolEntries(
  statusData: unknown,
  port: number,
): WorkBuddyCreditEntry[] {
  const data = (typeof statusData === 'object' && statusData !== null ? statusData : {}) as {
    pool?: { entries?: Array<{ label?: string; credits?: number; packages?: number; creditsError?: string }> }
  }
  const raw = data.pool?.entries
  if (!Array.isArray(raw)) return []
  return raw.map((e): WorkBuddyCreditEntry => {
    const label = typeof e.label === 'string' && e.label !== '' ? e.label : `端口 ${port}`
    if (typeof e.credits === 'number') {
      return { label, port, account: label, total: e.credits, packages: e.packages }
    }
    return { label, port, account: label, error: e.creditsError ?? '积分未知' }
  })
}

async function workbuddyCredits(): Promise<{
  groups: WorkBuddyCreditGroup[]
  total: number
  note?: string
}> {
  const keyFiles = await readKeyDir('workbuddy-proxy/keys')

  // 池化模型：只连两个入口（cn 39301 / global 39302），
  // 池内账号由 /status 的 pool.entries 展开（每个条目自带积分）。
  // 不再扫描 acct-N.key —— 那些独立端口已默认关闭。
  const ports: Array<{ region: 'cn' | 'global'; label: string; port: number; keyFile: string }> = []
  if (keyFiles.includes('cn.key')) ports.push({ region: 'cn', label: '国内版', port: 39301, keyFile: 'workbuddy-proxy/keys/cn.key' })
  if (keyFiles.includes('global.key')) ports.push({ region: 'global', label: '国际版', port: 39302, keyFile: 'workbuddy-proxy/keys/global.key' })

  const groupMap = new Map<'cn' | 'global', WorkBuddyCreditGroup>()
  const noteParts: string[] = []

  // allSettled：任一入口失败不拖累整个面板 500。
  const settled = await Promise.allSettled(ports.map(async (p): Promise<WorkBuddyCreditGroup> => {
    const key = await readRegionKey(p.keyFile)
    if (key === null) throw new Error(`缺少 key：${p.keyFile}`)
    const st = await fetchJson(`http://${HOST}:${p.port}/status`, key)
    if (!st.ok || typeof st.data !== 'object' || st.data === null) {
      throw new Error(st.error ?? `HTTP ${st.status ?? '?'}`)
    }
    const entries = parsePoolEntries(st.data, p.port)
    const total = entries.reduce((sum, e) => sum + (e.total ?? 0), 0)
    return { region: p.region, label: p.label, entries, total }
  }))

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    const p = ports[i] as { region: 'cn' | 'global'; label: string; port: number }
    if (s?.status === 'fulfilled') {
      groupMap.set(s.value.region, s.value)
    } else {
      const reason = s?.status === 'rejected' ? (s.reason instanceof Error ? s.reason.message : String(s.reason)) : '未知错误'
      noteParts.push(`${p.label}(${p.port}) 读取失败：${reason}`)
      groupMap.set(p.region, { region: p.region, label: p.label, entries: [], total: 0 })
    }
  }

  const order: Array<'cn' | 'global'> = ['cn', 'global']
  const groups = order.map(r => groupMap.get(r)).filter((g): g is WorkBuddyCreditGroup => g !== undefined)
  const total = groups.reduce((sum, g) => sum + g.total, 0)
  return { groups, total, note: noteParts.length > 0 ? noteParts.join('；') : undefined }
}

/**
 * Trae 额度用量：查询 trae-proxy 的 /credits（上游 /trae/api/v2/pay/ide_user_ent_usage）。
 * 只取用量摘要：已用 consumed、总额 total、比例 ratio、剩余 remaining。
 * 上游字段缺失时各项为 undefined，前端显示「—」。
 */
interface TraeCreditView {
  region: string
  port: number
  enabled: boolean
  consumed?: number
  total?: number
  remaining?: number
  ratio?: number
  error?: string
}

async function traeCredits(): Promise<TraeCreditView> {
  const port = 39303
  const base: TraeCreditView = { region: 'cn', port, enabled: false }
  try {
    const key = await readRegionKey('trae-proxy/keys/cn.key')
    if (key === null) return { ...base, error: '缺少 key' }
    const r = await fetchJson(`http://${HOST}:${port}/credits`, key)
    if (!r.ok || typeof r.data !== 'object' || r.data === null) {
      return { ...base, error: r.error ?? `HTTP ${r.status ?? '?'}` }
    }
    const d = r.data as {
      enabled?: boolean
      usage?: {
        usage_summary?: { consumed_amount?: number; total_amount?: number; consumption_ratio?: number }
      }
    }
    const s = d.usage?.usage_summary
    const consumed = typeof s?.consumed_amount === 'number' ? s.consumed_amount : undefined
    const total = typeof s?.total_amount === 'number' ? s.total_amount : undefined
    return {
      region: 'cn',
      port,
      enabled: d.enabled !== false,
      ...(consumed === undefined ? {} : { consumed }),
      ...(total === undefined ? {} : { total }),
      ...(consumed !== undefined && total !== undefined ? { remaining: Math.max(0, total - consumed) } : {}),
      ...(typeof s?.consumption_ratio === 'number' ? { ratio: s.consumption_ratio } : {}),
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 探测某端口是否有服务监听（TCP 连接探测）。 */
async function probePort(port: number): Promise<boolean> {
  const net = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const socket = net.connect({ host: HOST, port })
    const done = (v: boolean): void => {
      if (settled) return // 只 resolve 一次，避免 connect 后又来 error/timeout
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 从代理 /healthz 读取当前版本（需带该代理的 bearer，healthz 受鉴权保护）。 */
async function readCurrentVersion(port: number, keyName: string): Promise<string | undefined> {
  try {
    const key = await readRegionKey(keyName)
    if (key === null) return undefined
    const res = await fetch(`http://${HOST}:${port}/healthz`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return undefined
    const j = await res.json() as { version?: string }
    return j.version
  } catch {
    return undefined
  }
}

/** 检查（可选并执行）所有仓库更新；force=true 时真正 git 快进，否则只报告。 */
async function checkUpdates(force: boolean): Promise<unknown> {
  const specs = []
  for (const u of UPDATABLE) {
    const currentVersion = await readCurrentVersion(u.port, u.keyName)
    if (currentVersion === undefined) continue // 代理没启动，跳过
    specs.push({
      name: u.name,
      repo: u.repo,
      dir: join(ROOT, '..', u.dirName),
      currentVersion,
    })
  }
  if (!force) {
    // 只检查版本（不拉取、不写盘）
    const { peekLatestTag } = await import('./updater.ts')
    const repos = []
    for (const s of specs) {
      const latest = (await peekLatestTag(s.repo)) ?? s.currentVersion
      const { isNewer } = await import('./updater.ts')
      repos.push({ name: s.name, current: s.currentVersion, latest, hasUpdate: isNewer(latest, s.currentVersion) })
    }
    return { mode: 'check', repos }
  }
  const { checkAll } = await import('./updater.ts')
  const results = await checkAll(specs, UPDATE_PENDING_FILE, m => log('info', m))
  return { mode: 'update', results }
}

/* ------------------------------------------------------------------ *
 * 高危端点：POST /api/update/apply
 *
 * 这个端点会在磁盘上执行 `git fetch` + `git merge --ff-only`，是面板里唯一
 * 有副作用的写操作，因此额外加三道闸：
 *   1. 二次确认：请求体必须是 {"confirm":"apply"}，防误触/防 CSRF 式盲打；
 *   2. 并发锁：git 操作不能并行（会互抢 .git/index.lock），进行中一律 409；
 *   3. 审计日志：每次调用（**含被拒**）都留一行，便于事后追溯是谁触发的。
 *
 * 注意：每日定时自动更新**不经过** HTTP 端点（main() 直接调 checkUpdates(true)），
 * 所以这里的二次确认只约束外部调用，不影响自动更新。以后若要改定时器，
 * 不要去给它加 confirm —— 它是进程内的可信调用方。
 * ------------------------------------------------------------------ */

/** 是否已有一次 apply 在执行。 */
let applyInFlight = false

/** 审计日志：时间、来源、确认结果、执行结果。不落单独文件（避免新增写盘）。 */
function auditApply(req: IncomingMessage, confirmed: boolean, outcome: string): void {
  const ip = req.socket.remoteAddress ?? '?'
  log('info', `[audit] /api/update/apply from=${ip} confirm=${confirmed ? 'ok' : 'rejected'} result=${outcome}`)
}

/** 从请求体里解析确认字段；容忍空体与非法 JSON。 */
function parseConfirm(body: string): string {
  try {
    const parsed = JSON.parse(body) as { confirm?: unknown }
    return typeof parsed.confirm === 'string' ? parsed.confirm : ''
  } catch {
    return ''
  }
}

async function overview(): Promise<unknown> {
  // allSettled 而非 all：任一区故障不能拖累整个面板 500（前端每 15 分钟刷新一次）。
  const settled = await Promise.allSettled(REGIONS.map(async (def) => {
    const key = await readRegionKey(def.keyName)
    const running = await probePort(def.port)
    if (!running) {
      return { ...def, running: false, auth: { state: 'offline' }, signin: null }
    }
    if (!key) {
      return { ...def, running: true, auth: { state: 'no-key' }, signin: null }
    }
    const status = await fetchJson(`http://${HOST}:${def.port}/status`, key)
    let signin: unknown = null
    if (def.supportsSignin) {
      const s = await fetchJson(`http://${HOST}:${def.port}/signin/status`, key)
      signin = s.ok ? s.data : { error: s.error ?? `HTTP ${s.status}` }
    }
    return {
      ...def,
      running: true,
      auth: status.ok ? (status.data as { auth?: unknown })?.auth ?? { state: 'unknown' } : { state: 'error', message: status.error ?? `HTTP ${status.status}` },
      models: status.ok ? (status.data as { models?: unknown })?.models : undefined,
      signin,
    }
  }))
  const items = settled.map(r => r.status === 'fulfilled'
    ? r.value
    : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  return { regions: items, at: Date.now() }
}

/**
 * /api/overview 响应缓存：前端会周期性刷新，而每次组装都要对最多 6 个代理
 * 各发 /status 与 /signin/status 并读 key 文件。30 秒内复用同一份结果，
 * 缓存内容就是 overview() 的原样返回，结构与字段完全不变。
 *
 * 单飞（single-flight）：并发未命中时只发起一次上游查询，
 * 其余请求 await 同一个 Promise，避免缓存击穿/惊群。
 */
const OVERVIEW_TTL_MS = 30 * 1000
let overviewCache: { at: number; data: unknown } | null = null
let overviewInFlight: Promise<unknown> | null = null

async function overviewCached(): Promise<unknown> {
  if (overviewCache !== null && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) {
    return overviewCache.data
  }
  if (overviewInFlight === null) {
    overviewInFlight = overview()
      .then((data) => {
        overviewCache = { at: Date.now(), data }
        return data
      })
      .finally(() => { overviewInFlight = null })
  }
  return overviewInFlight
}

async function claim(id: string): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const def = REGIONS.find(r => r.id === id)
  if (!def) return { ok: false, error: `未知区域：${id}` }
  const key = await readRegionKey(def.keyName)
  if (!key) return { ok: false, error: '该区域缺少 key' }
  const res = await fetchJson(`http://${HOST}:${def.port}/signin/claim`, key, 'POST', 40000)
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  let h = host.trim().toLowerCase()
  if (h.startsWith('[')) { const e = h.indexOf(']'); h = e === -1 ? h : h.slice(0, e + 1) }
  else { const c = h.lastIndexOf(':'); if (c !== -1 && /^\d+$/.test(h.slice(c + 1))) h = h.slice(0, c) }
  return LOOPBACK_HOSTS.has(h)
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try { const hn = new URL(origin).hostname; return LOOPBACK_HOSTS.has(hn) || hn === '::1' } catch { return false }
}

let HUB_KEY = ''
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null
  if (m === null) return false
  const a = Buffer.from(m[1] ?? ''); const b = Buffer.from(HUB_KEY)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** index.html 内存缓存：面板是静态资源，没必要每次请求都读盘（改完重启即可生效）。 */
let indexHtmlCache: string | null = null

/**
 * 统一响应安全头。
 *
 * 面板只在本机回环访问，但仍要挡住两类真实风险：
 *  1. **key 经 URL 传递**：首次访问是 `/?key=…`，若被外链或跨站请求带走，
 *     浏览器的 Referer 会把 key 一起送出去 —— 故必须 `Referrer-Policy: no-referrer`。
 *  2. **点击劫持 / 外链注入**：`frame-ancestors 'none'` + `X-Frame-Options: DENY`，
 *     以及对内联外的资源一律 `default-src 'none'`。
 *
 * 面板是单文件、内联 script/style，所以这两个指令只能放 'unsafe-inline'（其它全关）。
 * `connect-src 'self'` 保证内联脚本只能访问本面板自身的 API，不能外发数据。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 面板与 API 都含账号/积分信息，不该进任何缓存（含浏览器前进后退缓存）
  'Cache-Control': 'no-store',
}

/**
 * 包一层写入器，保证**所有**出口都带上安全头。
 *
 * 之所以不在每个 writeHead 里重复：面板分支多、且有多处提前 return，
 * 逐个写迟早会漏。这里把 res.writeHead 换掉一次即可。
 */
function applySecurityHeaders(res: ServerResponse): void {
  const originalWriteHead = res.writeHead.bind(res)
  // 重载签名较多，统一按「先合并安全头、再走原生实现」处理。
  res.writeHead = ((...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'object' && first !== null) {
      args[0] = { ...SECURITY_HEADERS, ...(first as Record<string, string>) }
    } else if (typeof first === 'number') {
      const headers = args[1]
      if (typeof headers === 'object' && headers !== null) {
        args[1] = { ...SECURITY_HEADERS, ...(headers as Record<string, string>) }
      } else {
        args.splice(1, 0, { ...SECURITY_HEADERS })
      }
    }
    return (originalWriteHead as (...a: unknown[]) => ServerResponse)(...args)
  }) as ServerResponse['writeHead']
}

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    if (indexHtmlCache === null) indexHtmlCache = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(indexHtmlCache)
  } catch {
    res.writeHead(500); res.end('缺少 index.html')
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applySecurityHeaders(res)
  const url = (req.url ?? '/').split('?')[0] ?? '/'
  if (!hostIsLoopback(req.headers.host)) { res.writeHead(403); res.end('禁止访问'); return }
  if (!originIsLoopback(req.headers.origin)) { res.writeHead(403); res.end('禁止访问'); return }

  // index 页面在浏览器直接访问时会带 key（?key=），便于拿到后写入 localStorage
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    await serveIndex(res)
    return
  }
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, version: AGENT_HUB_VERSION })); return
  }
  if (!authed(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '未授权' }))
    return
  }

  try {
    if (req.method === 'GET' && url === '/api/overview') {
      const data = await overviewCached()
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/workbuddy/credits') {
      const data = await workbuddyCredits()
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/trae/credits') {
      const data = await traeCredits()
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/services') {
      const settled = await Promise.allSettled(REGIONS.map(async d => ({ id: d.id, port: d.port, running: await probePort(d.port) })))
      const svc = settled.map(r => r.status === 'fulfilled'
        ? r.value
        : { id: '?', port: 0, running: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ services: svc })); return
    }
    if (req.method === 'POST' && url.startsWith('/api/signin/claim')) {
      const body = await readBody(req)
      if (!body.ok) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体过大' })); return }
      let id = ''
      try { id = (JSON.parse(body.text) as { id?: string }).id ?? '' } catch { /* */ }
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 id' })); return }
      const result = await claim(id)
      res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result)); return
    }
    if (req.method === 'GET' && url === '/api/update/check') {
      const data = await checkUpdates(false)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'POST' && url === '/api/update/apply') {
      const body = await readBody(req)
      if (!body.ok) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体过大' })); return }
      if (parseConfirm(body.text) !== 'apply') {
        auditApply(req, false, 'bad-confirm')
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '缺少二次确认：请求体需为 {"confirm":"apply"}' }))
        return
      }
      if (applyInFlight) {
        auditApply(req, true, 'busy')
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '已有一次更新正在执行，请稍后重试' }))
        return
      }
      applyInFlight = true
      try {
        const data = await checkUpdates(true)
        const results = (data as { results?: Array<{ name: string; state: string; latest: string }> }).results ?? []
        auditApply(req, true, results.map(r => `${r.name}=${r.state}@${r.latest}`).join(',') || 'no-repos')
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
      } catch (error) {
        auditApply(req, true, `error:${error instanceof Error ? error.message : String(error)}`)
        throw error
      } finally {
        applyInFlight = false
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未找到' }))
  } catch (error) {
    log('error', '面板请求处理失败：', error)
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: '内部错误' })) }
  }
}

const BODY_LIMIT = 1024 * 1024

/**
 * 读取请求体。
 *
 * 返回 ok=false 表示体积超限，调用方据此回 413。
 *
 * 超限时**不能** destroy 请求：destroy 会连带关掉 socket，客户端只会收到
 * ECONNRESET，压根读不到任何响应（实测：2MB 请求体在 destroy 版本下直接连接重置，
 * 而不是 400，更不是 413）。所以这里改为「停止累积、把剩余数据读掉」，
 * 让请求能正常走完 end，响应才写得出去。
 *
 * 内存仍然有界：超限后不再往 chunks 里塞任何东西。读掉剩余流量只是多耗一点
 * 带宽，而 readBody 只在鉴权通过之后才调用，攻击面限于已持有 key 的本地调用方。
 *
 * 长度按**字节**计（Buffer 长度）而非字符串长度：中文在 JS 里是 UTF-16 码元，
 * 一个汉字只算 1，按字符串长度会低估到实际字节数的三分之一左右。
 */
type BodyResult = { ok: true; text: string } | { ok: false; tooLarge: true }

function readBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return // 已超限：继续读但不再累积，内存有界
      size += c.length
      if (size > BODY_LIMIT) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(
      tooLarge ? { ok: false, tooLarge: true } : { ok: true, text: Buffer.concat(chunks).toString('utf8') },
    ))
    req.on('error', () => resolve({ ok: true, text: '' }))
  })
}


async function main(): Promise<void> {
  HUB_KEY = await loadOrCreateHubKey()
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('connection', s => { sockets.add(s); s.once('close', () => sockets.delete(s)) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, resolve)
  })

  log('info', `agent-hub 已监听 http://${HOST}:${PORT}`)
  // 完整 key 只落在 keys/hub.key（0600），不进日志——日志会被追加保存很久。
  log('info', `首次访问请带上 key（见 keys/hub.key）：http://${HOST}:${PORT}/?key=${HUB_KEY.slice(0, 6)}…`)

  // 每日自动检查更新：启动 30 秒后查一次，之后每 24 小时一次。
  // 只做 git 快进（ff-only），有更新会写 state/update-pending.json，重启代理后生效。
  if ((process.env['OPCODE_NO_AUTO_UPDATE'] ?? '') === '') {
    setTimeout(() => { void checkUpdates(true).catch(() => {}) }, 30_000).unref?.()
    const updateTimer = setInterval(() => { void checkUpdates(true).catch(() => {}) }, UPDATE_CHECK_MS)
    updateTimer.unref?.()
  }

  const shutdown = (): void => { for (const s of sockets) s.destroy(); server.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// 仅在被直接运行时启动服务；被测试 import 时不应占用端口。
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error: unknown) => { log('error', 'agent-hub 启动失败：', error); process.exit(1) })
}
