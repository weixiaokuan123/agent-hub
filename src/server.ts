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

function ts(): string {
  return new Date().toISOString()
}

function log(level: string, ...args: unknown[]): void {
  const line = `[${ts()}] [${level}] ${args.map(String).join(' ')}\n`
  if (level === 'error' || level === 'warn') process.stderr.write(line)
  else process.stdout.write(line)
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
      let id = ''
      try { id = (JSON.parse(body) as { id?: string }).id ?? '' } catch { /* */ }
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
      const data = await checkUpdates(true)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '未找到' }))
  } catch (error) {
    log('error', '面板请求处理失败：', error)
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: '内部错误' })) }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', c => { data += String(c); if (data.length > 1024 * 1024) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
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
