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
import { dirname, join } from 'node:path'
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

async function readRegionKey(def: RegionDef): Promise<string | null> {
  try {
    return (await readFile(join(ROOT, '..', def.keyName), 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function fetchJson(url: string, key: string, method = 'GET', timeoutMs = 20000): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let data: unknown = text
    try { data = JSON.parse(text) } catch { /* keep text */ }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * WorkBuddy 积分汇总：live 国内(39301) + live 国际(39302) + 多账号
 * (keys 目录下 acct-*.key，端口 39320+ i)。缺失的 key 文件自动跳过。
 *
 * live 端口的登录态可能与某个 acct 账号是同一个号（例如桌面端切到账号B 后，
 * live 也变成账号B），若直接累加会把同一账号算两次。因此先查各端口 /status
 * 取账号标识（account / uin），按标识去重：同一账号只保留一个条目（live 优先）。
 */
interface WorkBuddyCreditEntry {
  label: string
  port: number
  /** 账号显示名（用于识别，仅本地面板展示）。 */
  account?: string
  total?: number
  packages?: number
  error?: string
  /** 该条目与另一个端口是同一账号，已被合并（不参与求和）。 */
  duplicateOf?: number
}

async function workbuddyCredits(): Promise<{ entries: WorkBuddyCreditEntry[]; total: number; note?: string }> {
  let keyFiles: string[] = []
  try { keyFiles = await readdir(join(ROOT, '..', 'workbuddy-proxy', 'keys')) } catch { /* keys 目录缺失 */ }
  const specs: Array<{ label: string; port: number; keyFile: string }> = []
  if (keyFiles.includes('cn.key')) specs.push({ label: '国内版', port: 39301, keyFile: 'workbuddy-proxy/keys/cn.key' })
  if (keyFiles.includes('global.key')) specs.push({ label: '国际版', port: 39302, keyFile: 'workbuddy-proxy/keys/global.key' })
  // acct-0, acct-1, ... → 端口 39320, 39321, ...
  const acct = keyFiles
    .map(f => /^acct-(\d+)\.key$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => Number(m[1]))
    .sort((a, b) => a - b)
  for (const i of acct) {
    specs.push({ label: `账号${String.fromCharCode(66 + i)}`, port: 39320 + i, keyFile: `workbuddy-proxy/keys/acct-${i}.key` })
  }

  const raw = await Promise.all(specs.map(async (s): Promise<WorkBuddyCreditEntry> => {
    try {
      const key = (await readFile(join(ROOT, '..', s.keyFile), 'utf8')).trim()
      // 先取账号标识，用于去重
      let account: string | undefined
      let uin: string | undefined
      try {
        const st = await fetchJson(`http://${HOST}:${s.port}/status`, key)
        if (st.ok && typeof st.data === 'object' && st.data !== null) {
          const auth = (st.data as { auth?: { account?: string; uin?: string } }).auth
          account = auth?.account
          uin = auth?.uin
        }
      } catch { /* 取不到标识就单独计一档 */ }
      const r = await fetchJson(`http://${HOST}:${s.port}/credits`, key)
      if (!r.ok || typeof r.data !== 'object' || r.data === null) {
        return { label: s.label, port: s.port, account, error: r.error ?? `HTTP ${r.status ?? '?'}` }
      }
      const d = r.data as { total?: number; packages?: unknown[] }
      return {
        label: s.label,
        port: s.port,
        account: account ?? uin,
        total: typeof d.total === 'number' ? d.total : undefined,
        packages: Array.isArray(d.packages) ? d.packages.length : undefined,
      }
    } catch (error) {
      return { label: s.label, port: s.port, error: error instanceof Error ? error.message : String(error) }
    }
  }))

  // 按 account 标识去重：同标识只保留第一个（specs 顺序 live 在前），其余标记为重复。
  const seen = new Map<string, number>()
  const entries: WorkBuddyCreditEntry[] = []
  let deduped = false
  for (const e of raw) {
    if (e.account !== undefined && e.account !== '') {
      if (seen.has(e.account)) {
        entries.push({ label: e.label, port: e.port, total: e.total, packages: e.packages, duplicateOf: seen.get(e.account) })
        deduped = true
        continue
      }
      seen.set(e.account, e.port)
    }
    entries.push(e)
  }
  const total = entries.reduce((sum, e) => sum + (e.duplicateOf === undefined ? (e.total ?? 0) : 0), 0)
  return {
    entries,
    total,
    ...(deduped ? { note: '同一账号的多个端口已合并，仅计一次' } : {}),
  }
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
    const key = (await readFile(join(ROOT, '..', 'trae-proxy', 'keys', 'cn.key'), 'utf8')).trim()
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
    const key = await readRegionKey({ keyName } as RegionDef)
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
  const items = await Promise.all(REGIONS.map(async (def) => {
    const key = await readRegionKey(def)
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
  return { regions: items, at: Date.now() }
}

async function claim(id: string): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const def = REGIONS.find(r => r.id === id)
  if (!def) return { ok: false, error: `未知区域：${id}` }
  const key = await readRegionKey(def)
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

async function serveIndex(res: ServerResponse): Promise<void> {
  try {
    const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch {
    res.writeHead(500); res.end('index.html missing')
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0] ?? '/'
  if (!hostIsLoopback(req.headers.host)) { res.writeHead(403); res.end('forbidden'); return }
  if (!originIsLoopback(req.headers.origin)) { res.writeHead(403); res.end('forbidden'); return }

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
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }

  try {
    if (req.method === 'GET' && url === '/api/overview') {
      const data = await overview()
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
      const svc = await Promise.all(REGIONS.map(async d => ({ id: d.id, port: d.port, running: await probePort(d.port) })))
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ services: svc })); return
    }
    if (req.method === 'POST' && url.startsWith('/api/signin/claim')) {
      const body = await readBody(req)
      let id = ''
      try { id = (JSON.parse(body) as { id?: string }).id ?? '' } catch { /* */ }
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing id' })); return }
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
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' }))
  } catch (error) {
    log('error', 'hub request failed', error)
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'internal' })) }
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
  log('info', `首次访问请带上 key：http://${HOST}:${PORT}/?key=${HUB_KEY}`)

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

main().catch((error: unknown) => { log('error', 'agent-hub 启动失败：', error); process.exit(1) })
