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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 探测某端口是否有服务监听（TCP 连接探测）。 */
async function probePort(port: number): Promise<boolean> {
  const net = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: HOST, port })
    const done = (v: boolean): void => { socket.destroy(); resolve(v) }
    socket.setTimeout(1200)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
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
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return
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

  const shutdown = (): void => { for (const s of sockets) s.destroy(); server.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => { log('error', 'agent-hub 启动失败：', error); process.exit(1) })
