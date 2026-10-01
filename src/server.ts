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
import { isNewer } from './updater.ts'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_HUB_VERSION } from './version.ts'
import { createToolRouter } from './tool-api.ts'
import { resolveProxyRoot, suiteDir } from './proxy-root.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PUBLIC_DIR = join(ROOT, 'public')
const KEYS_DIR = join(ROOT, 'keys')

/**
 * 三个代理共同所在的目录。
 *
 * 解析规则见 proxy-root.ts。**不要**再在这里写 `join(ROOT, '..')`：
 * 那条路径在四个仓一起搬进 proxy-suite\ 之后会指向 proxy-suite 的父目录，
 * 于是积分读空、重启按钮失效，而且**不报错**——是那种能瞒很久的静默退化。
 */
const PROXY_ROOT = resolveProxyRoot(ROOT)

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

/**
 * 可自动更新的本地仓库。
 *
 * 包含 **agent-hub 自己**——之前只有三个代理，于是本面板的更新永远传不出去：
 * 别人收不到，而 hub 恰恰是承载"自动更新"的那个仓。
 *
 * 两类来源：
 *   - `remote`：问该代理的 /healthz 要版本号（代理可能压根没启动，读不到就跳过）；
 *   - `local` ：读本地常量（agent-hub 自身——问自己没意义，跑的就是当前这版）。
 *
 * 注意 agent-hub **无法从面板重启自己**：处理请求的进程一死就没法回响应，
 * 而分离脚本延迟重启会让面板整个挂掉、失败时无从察觉。所以合并照常做，
 * 生效交给使用者手动重启（见 selfRestartHint）。
 */
export const UPDATABLE: Array<{
  name: string
  repo: string
  /** 相对 ROOT/.. 的目录名；'.' 表示 agent-hub 自身目录。 */
  dirName: string
  source: 'remote' | 'local'
  port?: number
  keyName?: string
}> = [
  { name: 'workbuddy-proxy', repo: 'weixiaokuan123/workbuddy-proxy', dirName: 'workbuddy-proxy', source: 'remote', port: 39301, keyName: 'workbuddy-proxy/keys/cn.key' },
  { name: 'trae-proxy', repo: 'weixiaokuan123/trae-proxy', dirName: 'trae-proxy', source: 'remote', port: 39303, keyName: 'trae-proxy/keys/cn.key' },
  { name: 'minimax-proxy', repo: 'weixiaokuan123/minimax-proxy', dirName: 'minimax-proxy', source: 'remote', port: 39305, keyName: 'minimax-proxy/keys/cn.key' },
  { name: 'agent-hub', repo: 'weixiaokuan123/agent-hub', dirName: '.', source: 'local' },
]

/**
 * 某个仓的本地目录。
 *
 * `dirName === '.'` 表示 ROOT 自己。必须显式处理：`join(ROOT, '..', '.')` 在
 * Windows 上会得到 `C:\...\opencode\.` —— 那是个**合法路径，git 在里面照样跑得通**，
 * 所以这个错误不会立刻暴露，只会在日志里显示成一条诡异的路径。
 */
export function resolveUpdateDir(dirName: string, root: string = ROOT, proxyRoot: string = PROXY_ROOT): string {
  return suiteDir(dirName, proxyRoot, root)
}

/**
 * 某个仓能不能从面板里一键重启。
 *
 * 默认 false：未知名字一律不给放行。
 */
export function canRestartFromPanel(name: string): boolean {
  return RESTART_TARGETS.some(t => t.repo === name)
}

/** 某仓更新后该怎么让它生效。代理有一键按钮，自身只能手动。 */
export function selfRestartHint(name: string): string {
  if (canRestartFromPanel(name)) return '点上面的「重启 3 个代理」即可生效'
  if (name === 'agent-hub') {
    return '需手动重启本面板（面板无法重启自己）：' +
      'cd "$env:USERPROFILE\\.config\\opencode\\agent-hub"; ' +
      'powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\stop.ps1; ' +
      'powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\start.ps1'
  }
  return ''
}
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
    const value = (await readFile(join(PROXY_ROOT, keyName), 'utf8')).trim()
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
    const names = await readdir(join(PROXY_ROOT, dirName))
    keyDirCache.set(dirName, names)
    return names
  } catch {
    return []
  }
}

async function fetchJson(
  url: string,
  key?: string,
  method = 'GET',
  timeoutMs = 20000,
  body?: string,
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key !== undefined && key !== '') headers['Authorization'] = `Bearer ${key}`
    const res = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
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
/** 代理透传过来的单个积分包（与 workbuddy-proxy 的 WorkBuddyCreditPackage 对应）。 */
interface CreditPackage {
  packageName?: string
  remain?: number
  size?: number
  monthly?: boolean
  refreshAtMs?: number
  expiresAtMs?: number
}

interface WorkBuddyCreditEntry {
  label: string
  port: number
  /** 账号显示名（用于识别，仅本地面板展示）。 */
  account?: string
  total?: number
  packages?: number
  /**
   * 逐包明细（到期 / 刷新时刻 + 剩余额度）。
   *
   * 代理过去只给 `packages` 一个计数，所以面板无法展示任何到期信息；
   * 现在代理把明细一并透传，这里原样带下去，聚合由面板做。
   * 字段缺失（连到旧版本代理）时为 undefined，面板按「无明细」降级。
   */
  creditPackages?: CreditPackage[]
  /** 3 天内到期的积分数；> 0 表示有积分即将作废。 */
  expiringSoon?: number
  /** 最近一个包的到期时刻（ms）。 */
  nearestExpiryMs?: number
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
/**
 * 启动后的自动更新检查：退避重试，而不是一次就放弃。
 *
 * 原来只有 `setTimeout(30s)` 打一枪。开机时代理往往还没监听端口，
 * `readCurrentVersion` 于是返回 undefined，三个仓被一次性全部跳过——
 * 而下一次检查在 24 小时后。结果就是「启动时自动更新」完全看代理启动快慢的运气，
 * 而且失败时**没有任何痕迹**，使用者只会以为"最近没更新"。
 *
 * 所以这里在有限的启动窗口内重试：每轮按 results.length 判断是否三个仓都拿到了
 * 版本号，全齐就收工；始终不齐（真没装 / 真坏了）才放弃，并且必须留下一行日志。
 *
 * 依赖全部注入，便于测试；不引入任何 sleep 实现细节。
 */
export const STARTUP_RETRY_DELAYS_MS: readonly number[] = [0, 30_000, 60_000, 120_000, 240_000]

export async function startupUpdateCheck(deps: {
  /** 执行一次检查，返回 { results } —— 只有解析出版本号的仓才会进来。 */
  check: () => Promise<{ results?: unknown[] }>
  /** 应当解析出的仓数（= UPDATABLE.length）。 */
  total: number
  delaysMs: readonly number[]
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}): Promise<{ rounds: number; gaveUp: boolean }> {
  const { check, total, delaysMs, sleep, log } = deps
  let resolved = 0
  for (let round = 0; round < delaysMs.length; round++) {
    if (delaysMs[round] > 0) await sleep(delaysMs[round])
    try {
      const r = await check()
      resolved = Array.isArray(r?.results) ? r.results.length : 0
    } catch (error) {
      // 代理还没起来时连接被拒是常态，不该把整个重试链打断
      resolved = 0
      log(`更新检查第 ${round + 1} 轮未完成：${error instanceof Error ? error.message : String(error)}`)
    }
    if (resolved >= total) return { rounds: round + 1, gaveUp: false }
  }
  log(`更新检查：${total - resolved}/${total} 个代理始终未就绪，本次跳过自动更新，24 小时后再试`)
  return { rounds: delaysMs.length, gaveUp: true }
}

/**
 * 读 `state/update-pending.json`（后台自动合并后写的待重启标记）。
 *
 * 这文件从加自动更新那天起就一直有人写、**没有人读**——于是「3 个仓库已更新、
 * 重启后生效」这件事没人知道。现在读出来交给面板显示。
 *
 * 解析必须全程降级：文件可能不存在、为空、被写坏（它是自动生成的），
 * 任何一种都不该把「服务」页整个打不开。
 */
export function parseUpdatePending(raw: string | null | undefined): {
  repos: string[]
  latest: Record<string, string>
  checkedAt?: number
} {
  const empty = { repos: [] as string[], latest: {} as Record<string, string> }
  if (typeof raw !== 'string' || raw.trim() === '') return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const obj = parsed as { checkedAt?: unknown; pending?: unknown }
  const list = Array.isArray(obj.pending) ? obj.pending : []
  const repos: string[] = []
  const latest: Record<string, string> = {}
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const name = (item as { name?: unknown }).name
    if (typeof name !== 'string' || name === '') continue
    repos.push(name)
    const v = (item as { latest?: unknown }).latest
    if (typeof v === 'string') latest[name] = v
  }
  return {
    repos,
    latest,
    checkedAt: typeof obj.checkedAt === 'number' ? obj.checkedAt : undefined,
  }
}

/**
 * 拉 MiniMax 积分。只有 cn 区本机有凭据，en 区一律降级。
 * 形状与 workbuddy 同构，所以面板复用同一套聚合。
 */
async function minimaxCredits(): Promise<MinimaxCreditView> {
  const port = 39305
  const base: MinimaxCreditView = { region: 'cn', packages: [] }
  try {
    const key = await readRegionKey('minimax-proxy/keys/cn.key')
    if (key === null) return { ...base, error: '缺少 key' }
    const r = await fetchJson(`http://${HOST}:${port}/credits`, key)
    if (!r.ok || typeof r.data !== 'object' || r.data === null) {
      return { ...base, error: r.error ?? `HTTP ${r.status ?? '?'}` }
    }
    return minimaxCreditView(r.data)
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ================= Trae 积分 ================= */

/**
 * Trae 的积分包视图。字段名与另外两家同构，面板因此复用同一套按到期日聚合。
 */
export interface TraeCreditView {
  region: string
  /** 由 traeCredits() 补上，纯解析函数不知道端口。 */
  port?: number
  enabled?: boolean
  total?: number
  consumed?: number
  /** 权威口径：total − consumed。上游自己的 usage_summary，不要自己加。 */
  remaining?: number
  ratio?: number
  /** 上游一共给了几个包（过滤前）。面板据此说「N 个包里 M 个还有余额」。 */
  packTotal?: number
  packages: Array<{ remain: number; size: number; consumed: number; expiresAtMs: number; monthly: boolean }>
  error?: string
}

/**
 * 把 Trae `/credits` 的原样透传收敛成带包明细的视图。
 *
 * ## 这里有个实测踩过的坑
 *
 * 上游每包给 `entitlement_base_info.quota.credits_limit`（上限）与
 * `usage.credits_amount`。**`credits_amount` 是「已消耗」，不是「剩余」**——
 * 余额必须自己算 `limit − amount`。三个数对上才敢这么写：
 *
 *     Σ credits_limit  = 7950.000  =  usage_summary.total
 *     Σ credits_amount = 7350.886  ≈  usage_summary.consumed
 *     limit − amount    =  599.114  =  剩余
 *
 * 且实测发请求后 `amount` 由 0.886 涨到 1.1412（**涨**）；若它是「剩余」，
 * 用掉 0.25 应该让它减少。
 */
export function traeCreditView(raw: unknown): TraeCreditView {
  // 非对象必须**报错**，不能静默变成空视图。
  // fetchJson 在响应体不是 JSON 时会把原始文本塞进来（上游返回一张状态码 200 的
  // HTML 错误页就是这种），那样面板会显示「剩余 —、总额 —」的空卡片且不报错，
  // 看着像"本来就没额度"。空对象 {} 则不同——那是"上游确实没给"，当空视图合理。
  if (typeof raw !== 'object' || raw === null) {
    return {
      region: 'cn',
      packages: [],
      packTotal: 0,
      error: `上游返回了非对象（${typeof raw}），无法解析`,
    }
  }
  const o = raw as Record<string, unknown>
  const out: TraeCreditView = { region: 'cn', packages: [] }
  if (typeof o['error'] === 'string') { out.error = o['error']; return out }
  if (typeof o['region'] === 'string') out.region = o['region']

  const u = (typeof o['usage'] === 'object' && o['usage'] !== null ? o['usage'] : {}) as Record<string, unknown>
  const s = (typeof u['usage_summary'] === 'object' && u['usage_summary'] !== null
    ? u['usage_summary'] : {}) as Record<string, unknown>
  if (typeof s['total_amount'] === 'number') out.total = s['total_amount']
  if (typeof s['consumed_amount'] === 'number') out.consumed = s['consumed_amount']
  if (typeof s['consumption_ratio'] === 'number') out.ratio = s['consumption_ratio']
  if (typeof out.total === 'number' && typeof out.consumed === 'number') {
    out.remaining = Math.max(0, out.total - out.consumed)
  }

  const list = Array.isArray(u['user_entitlement_pack_list']) ? u['user_entitlement_pack_list'] : []
  // 过滤**前**的总数。面板要靠它说清「27 个包里 4 个还有余额」——
  // 少了这个，面板只能猜，而它猜的「其余已用光」并不总成立（脏包也是被丢掉的）。
  out.packTotal = list.length
  for (const raw2 of list) {
    if (typeof raw2 !== 'object' || raw2 === null) continue
    const p = raw2 as Record<string, unknown>
    const b = (typeof p['entitlement_base_info'] === 'object' && p['entitlement_base_info'] !== null
      ? p['entitlement_base_info'] : {}) as Record<string, unknown>
    const q = (typeof b['quota'] === 'object' && b['quota'] !== null ? b['quota'] : {}) as Record<string, unknown>
    const limit = typeof q['credits_limit'] === 'number' ? q['credits_limit'] : undefined
    // 缺 credits_limit 的包（「免费」）必须跳过：当 0 处理会显示出一个假的空到期组
    if (limit === undefined) continue
    const usedRaw = (typeof p['usage'] === 'object' && p['usage'] !== null ? p['usage'] : {}) as Record<string, unknown>
    const used = typeof usedRaw['credits_amount'] === 'number' ? usedRaw['credits_amount'] : 0
    const remain = Math.max(0, limit - used)
    // 已用光的丢掉：实测 27 个包里 22 个已用光，不剔就多出 22 行 0 分
    if (remain <= 0) continue
    const endTime = typeof b['end_time'] === 'number' ? b['end_time'] : 0
    if (endTime <= 0) continue
    out.packages.push({
      remain,
      size: limit,
      consumed: used,
      expiresAtMs: endTime * 1000,   // 上游是**秒**，忘了 ×1000 会落在 1970 年
      monthly: false,
    })
  }
  return out
}

/* ================= MiniMax 积分 ================= */

/**
 * MiniMax 的积分包视图。
 *
 * 字段名**刻意与 workbuddy 的包一致**——面板的 `groupCreditPackages()` 因此能原样
 * 复用，不必为 MiniMax 写第二套按到期日聚合。这是整个设计的地基。
 */
export interface MinimaxCreditView {
  region: string
  total?: number
  packages: Array<{
    remain: number
    size: number
    consumed: number
    expiresAtMs: number
    monthly: boolean
  }>
  expiringSoon?: number
  nearestExpiryMs?: number
  error?: string
}

/** 把代理的 /credits 返回收敛成一个安全形状。 */
export function minimaxCreditView(raw: unknown): MinimaxCreditView {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: MinimaxCreditView = {
    region: typeof o['region'] === 'string' ? o['region'] : 'cn',
    packages: [],
  }
  if (typeof o['error'] === 'string') {
    // 拿不到就不能编一个 0 出来——0 会被面板读成「余额为零」，比报错更糟
    out.error = o['error']
    return out
  }
  if (typeof o['total'] === 'number') out.total = o['total']
  if (typeof o['expiringSoon'] === 'number') out.expiringSoon = o['expiringSoon']
  if (typeof o['nearestExpiryMs'] === 'number') out.nearestExpiryMs = o['nearestExpiryMs']
  const list = Array.isArray(o['packages']) ? o['packages'] : []
  for (const p of list) {
    if (typeof p !== 'object' || p === null) continue
    const r = p as Record<string, unknown>
    if (typeof r['remain'] !== 'number' || typeof r['expiresAtMs'] !== 'number') continue
    out.packages.push({
      remain: r['remain'],
      size: typeof r['size'] === 'number' ? r['size'] : r['remain'],
      consumed: typeof r['consumed'] === 'number' ? r['consumed'] : 0,
      expiresAtMs: r['expiresAtMs'],
      monthly: r['monthly'] === true,
    })
  }
  return out
}

export function parsePoolEntries(
  statusData: unknown,
  port: number,
): WorkBuddyCreditEntry[] {
  const data = (typeof statusData === 'object' && statusData !== null ? statusData : {}) as {
    pool?: { entries?: Array<{
      label?: string
      credits?: number
      packages?: number
      creditPackages?: unknown
      expiringSoon?: number
      nearestExpiryMs?: number
      creditsError?: string
    }> }
  }
  const raw = data.pool?.entries
  if (!Array.isArray(raw)) return []
  return raw.map((e): WorkBuddyCreditEntry => {
    const label = typeof e.label === 'string' && e.label !== '' ? e.label : `端口 ${port}`
    if (typeof e.credits === 'number') {
      // 明细必须逐项校验后再带下去：面板会读 remain / expiresAtMs 并参与求和，
      // 一个 undefined 混进来就会让「显示的 + 藏起来的 = 总额」这条对不上。
      const detail = Array.isArray(e.creditPackages) ? e.creditPackages : undefined
      return {
        label,
        port,
        account: label,
        total: e.credits,
        packages: e.packages,
        creditPackages: detail as CreditPackage[] | undefined,
        expiringSoon: typeof e.expiringSoon === 'number' ? e.expiringSoon : undefined,
        nearestExpiryMs: typeof e.nearestExpiryMs === 'number' ? e.nearestExpiryMs : undefined,
      }
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
 *
 * 解析全部交给 traeCreditView()（有测试覆盖），这里只负责取凭据、发请求、补端口。
 * 早先这里手搓了一份同字段解析，等于同一套逻辑写两遍——那份现在已删。
 */
async function traeCredits(): Promise<TraeCreditView> {
  const port = 39303
  const base: TraeCreditView = { region: 'cn', port, enabled: false }
  try {
    const key = await readRegionKey('trae-proxy/keys/cn.key')
    if (key === null) return { ...base, error: '缺少 key' }
    const r = await fetchJson(`http://${HOST}:${port}/credits`, key)
    // 非对象必须当错误处理，不能交给 traeCreditView 静默变成空视图。
    // fetchJson 在响应体不是 JSON 时会把**原始文本**塞进 data（比如上游返回
    // 一张状态码 200 的 HTML 错误页）——那样面板会显示一张「剩余 —、总额 —」
    // 的空卡片还不报错，看着像"本来就没额度"。
    if (!r.ok || typeof r.data !== 'object' || r.data === null) {
      return { ...base, error: r.error ?? `HTTP ${r.status ?? '?'}` }
    }
    const d = r.data as { enabled?: boolean }
    return { ...traeCreditView(r.data), port, enabled: d.enabled !== false }
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
/**
 * 读后台自动合并留下的「待重启」标记。
 *
 * 这文件从加自动更新那天起就有人写、没人读——于是「已经自动更新过了、
 * 等你重启代理」这件事只有日志知道。现在读出来交给面板显示。
 */
/**
 * 读后台自动合并留下的「待重启」标记，并**剔掉已经重启过的**。
 *
 * 这个文件从加自动更新那天起就有人写、没人读——于是「已经自动更新过了、
 * 等你重启代理」这件事只有日志知道。现在读出来交给面板显示。
 *
 * 但光读会出事：标记一旦写下就再没人清，而代理重启后代码已经是新的。
 * 于是面板会永远挂着一句「workbuddy-proxy → v1.3.15，重启后生效」，
 * 而那个仓早就到 1.3.18 且重启过。**显示一条永不消失的假提示，比不显示更糟。**
 *
 * 所以这里拿代理**当前跑着的版本**去对：只有「跑着的版本 < 标记里的版本」
 * 才算真的还没重启。信息不全时保守保留，不凭空断言。
 */
export function filterPending(
  parsed: ReturnType<typeof parseUpdatePending>,
  running?: ReadonlyMap<string, string>,
): ReturnType<typeof parseUpdatePending> {
  if (!running || parsed.repos.length === 0) return parsed
  const repos = parsed.repos.filter(name => {
    const cur = running.get(name)
    const want = parsed.latest[name]
    // 拿不到版本信息就别乱下结论，保守留着
    if (cur === undefined || want === undefined) return true
    return isNewer(want, cur)
  })
  const latest: Record<string, string> = {}
  for (const name of repos) {
    const v = parsed.latest[name]
    if (v !== undefined) latest[name] = v
  }
  return { repos, latest, checkedAt: parsed.checkedAt }
}

async function readPending(
  running?: ReadonlyMap<string, string>,
): Promise<ReturnType<typeof parseUpdatePending>> {
  let parsed: ReturnType<typeof parseUpdatePending>
  try {
    parsed = parseUpdatePending(await readFile(UPDATE_PENDING_FILE, 'utf8'))
  } catch {
    return parseUpdatePending(null)
  }
  return filterPending(parsed, running)
}

async function checkUpdates(force: boolean): Promise<unknown> {
  const specs = []
  /** 代理当前跑着的版本，用来判断「待重启」标记是不是已经过期。 */
  const running = new Map<string, string>()
  for (const u of UPDATABLE) {
    // source='local' 的 agent-hub 读本地常量；问自己没意义，跑的就是当前这版。
    // 写成假端口去查 /healthz 的话版本永远读成 undefined，会被静默跳过——
    // 那正是这个条目当初缺席的原因，不能重蹈。
    const currentVersion = u.source === 'local'
      ? AGENT_HUB_VERSION
      : await readCurrentVersion(u.port as number, u.keyName as string)
    if (currentVersion === undefined) continue // 代理没启动，跳过
    running.set(u.name, currentVersion)
    specs.push({
      name: u.name,
      repo: u.repo,
      dir: resolveUpdateDir(u.dirName),
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
    return { mode: 'check', repos, pending: await readPending(running) }
  }
  const { checkAll } = await import('./updater.ts')
  const results = await checkAll(specs, UPDATE_PENDING_FILE, m => log('info', m))
  return { mode: 'update', results, pending: await readPending(running) }
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
/** 是否已有一次重启在执行。并发重启会杀掉对方刚启动的进程，必须互斥。 */
let restartInFlight = false

/* ================= 重启代理（高危） ================= */

/**
 * 可重启的代理目标。**不含 agent-hub 自己**——那个进程正在处理这个请求，
 * 它不可能重启自己；文案里也不许出现"全部"。
 */
export const RESTART_TARGETS: ReadonlyArray<{ repo: string; dirName: string; ports: number[] }> = [
  { repo: 'workbuddy-proxy', dirName: 'workbuddy-proxy', ports: [39301, 39302] },
  { repo: 'trae-proxy', dirName: 'trae-proxy', ports: [39303, 39304] },
  { repo: 'minimax-proxy', dirName: 'minimax-proxy', ports: [39305, 39306] },
]

/** 单个仓的等待上限。实测一个仓 stop+start+端口恢复约 4.8 秒，给 40 秒余量充足。 */
const RESTART_TIMEOUT_MS = 40_000

export interface RestartResult {
  repo: string
  ok: boolean
  error?: string
  ports: number[]
}

/** 解析请求体里的确认字段；容忍空体与非法 JSON。 */
export function parseRestartBody(body: string): { confirmed: boolean } {
  try {
    const parsed = JSON.parse(body) as { confirm?: unknown }
    // 刻意不接受 apply 的口令：两个端点的闸必须各自成立，不能互相通用
    return { confirmed: parsed.confirm === 'restart' }
  } catch {
    return { confirmed: false }
  }
}

/** 跑一个 PowerShell 脚本，返回 { code, stderr }。不继承控制台窗口。 */
function runScript(scriptPath: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    )
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    // 超时要真的杀掉，否则 stop 脚本卡住会把整个端点挂死
    const timer = setTimeout(() => { child.kill(); resolve({ code: 1, stderr: `脚本超时（${timeoutMs}ms）` }) }, timeoutMs)
    child.on('error', (e: Error) => { clearTimeout(timer); resolve({ code: 1, stderr: e.message }) })
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }) })
  })
}

/** 端口是否已经接受连接（够用了：连上说明 HTTP 服务在听）。 */
async function portAccepts(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const sock = new Socket()
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(1000)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, HOST)
  })
}

/**
 * 重启三个代理：逐仓 stop → **等端口关闭** → start → 等端口打开。
 *
 * **串行**而不是并行：并行能把 15 秒压到 5 秒，但省下的那点时间不值当，而串行
 * 能做到「一个仓失败不影响其余」——并行时一个仓的 start 失败会被另一个仓的
 * 动作掩盖过去。
 *
 * ## 中间那步「等端口关闭」是必须的，不是保险
 *
 * 第一版没有这步，出了个很典型的假成功：stop 刚杀掉旧进程、端口还没释放时，
 * start.ps1 会认为「端口已开，跳过」（它本来就是幂等的）并正常返回 0；
 * 紧接着的「等端口打开」又对着那个**正在死掉的旧进程**探测，连上了 → 报成功。
 * 然后旧进程彻底退出，端口就再也没人监听了——**端点说成功，代理实际是死的。**
 *
 * 所以顺序必须是：确认旧端口已经**关掉**，再启动。否则"重启成功"只是运气。
 *
 * 停不下来的仓不会拖住整体：每个仓有自己的超时，失败只记在该条结果上。
 */
export async function restartProxies(deps: {
  /** 执行一步。action='waitClosed'/'waitOpen' 时由实现自己轮询到目标状态或超时。 */
  run: (
    t: { repo: string; dirName: string; ports: number[] },
    action: 'stop' | 'waitClosed' | 'start' | 'waitOpen',
  ) => Promise<{ code: number; stderr: string }>
  sleep: (ms: number) => Promise<void>
  targets?: ReadonlyArray<{ repo: string; dirName: string; ports: number[] }>
  timeoutMs?: number
}): Promise<{ ok: boolean; results: RestartResult[] }> {
  const targets = deps.targets ?? RESTART_TARGETS
  const timeoutMs = deps.timeoutMs ?? RESTART_TIMEOUT_MS
  const secs = Math.round(timeoutMs / 1000)
  const results: RestartResult[] = []

  for (const t of targets) {
    let error = ''
    // stop：本来就没在跑时 stop.ps1 会打印 not running 并正常退出，code 仍是 0
    const stop = await deps.run(t, 'stop')
    if (stop.code !== 0) error = `停止失败：${stop.stderr.trim() || '未知错误'}`
    if (!error) {
      // 等旧进程真正放开端口。见上方注释：跳过这步会得到「报成功但代理已死」。
      const closed = await deps.run(t, 'waitClosed')
      if (closed.code !== 0) {
        error = `停止后 ${secs} 秒内端口仍被占用（可能有别的进程占着）：${closed.stderr.trim() || '超时'}`
      }
    }
    if (!error) {
      const start = await deps.run(t, 'start')
      if (start.code !== 0) error = `启动失败：${start.stderr.trim() || '未知错误'}`
    }
    if (!error) {
      const up = await deps.run(t, 'waitOpen')
      if (up.code !== 0) error = `启动后 ${secs} 秒内端口仍未监听：${up.stderr.trim() || '超时'}`
    }
    results.push(error ? { repo: t.repo, ok: false, error, ports: t.ports } : { repo: t.repo, ok: true, ports: t.ports })
  }
  return { ok: results.every(r => r.ok), results }
}

/** 把结果整理成人话。刻意不说"全部已重启"——agent-hub 自己没被重启。 */
export function describeRestart(r: { ok: boolean; results: RestartResult[] }): string {
  if (r.results.length === 0) return '没有可重启的代理'
  const okList = r.results.filter(x => x.ok).map(x => x.repo)
  const badList = r.results.filter(x => !x.ok)
  if (r.ok) {
    return `已重启 ${okList.length} 个代理：${okList.join('、')}。新代码已生效；面板本身（agent-hub）未重启。`
  }
  const parts = [`已重启 ${okList.length}/${r.results.length} 个：${okList.join('、') || '无'}`]
  for (const b of badList) parts.push(`${b.repo} 失败（${b.error ?? '未知'}）`)
  parts.push('面板本身（agent-hub）未重启。')
  return parts.join('；')
}

/**
 * 审计日志：时间、来源、确认结果、执行结果。不落单独文件（避免新增写盘）。
 *
 * 端点名是**参数**而不是写死的：之前重启端点复用了本函数，日志里却一律写成
 * `/api/update/apply`——审计的全部意义是事后追溯，标错端点名会把排查引向错误的
 * 地方，比不记还糟。
 */
function audit(req: IncomingMessage, endpoint: string, confirmed: boolean, outcome: string): void {
  const ip = req.socket.remoteAddress ?? '?'
  log('info', `[audit] ${endpoint} from=${ip} confirm=${confirmed ? 'ok' : 'rejected'} result=${outcome}`)
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
    // 旅行视图：workbuddy 专有。workbuddy-proxy 未升级时端点返回 404，
    // 此时优雅降级为 travel: null（面板隐藏旅行区块），而不是整块报错。
    let travel: unknown = null
    if (def.provider === 'WorkBuddy') {
      const t = await fetchJson(`http://${HOST}:${def.port}/travel/status`, key)
      travel = t.ok ? t.data : null
    }
    return {
      ...def,
      running: true,
      auth: status.ok ? (status.data as { auth?: unknown })?.auth ?? { state: 'unknown' } : { state: 'error', message: status.error ?? `HTTP ${status.status}` },
      models: status.ok ? (status.data as { models?: unknown })?.models : undefined,
      signin,
      travel,
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

/**
 * 作废 overview 缓存。
 *
 * 任何**改变状态**的操作都要调它——否则 30 秒 TTL 内前端刷新拿到的还是旧值，
 * 表现为「点了开关，按钮却像没反应」。派遣开关就是这个问题。
 */
function invalidateOverview(): void {
  overviewCache = null
}

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

/**
 * 三个积分端点的共享缓存。
 *
 * ## 为什么需要它
 *
 * trae-proxy 的 `/credits` **没有任何缓存**——实测连续 4 次请求耗时
 * 163 / 144 / 296 / 146 ms，每次都真连 Trae 上游（workbuddy 代理侧有 60s TTL，
 * 所以它第二次就掉到 6 ms）。
 *
 * 放大路径有两条：
 *   1. 面板每 15 分钟刷一次，且 `refresh()` 一次性拉**全部**积分端点——
 *      哪怕你正停在「服务」页，Trae 上游照样被敲；
 *   2. 开 N 个标签页就是 N 倍。现在浏览器里就开着十几个 hub 标签。
 *
 * 代理侧加缓存只能压住第 1 条，压不住第 2 条（多标签是并发的）。
 * 放在 hub 这里，一处同时解决两条。
 *
 * ## 为什么是 60 秒
 *
 * 和 workbuddy / minimax 代理侧的 TTL 一致。积分只在真正发请求时才变，
 * 60 秒内的陈旧值用户察觉不到；而这期间上游的结算本身还有 3–5 分钟延迟
 * （Trae 实测），缓存 60 秒并不比上游更不准。
 */
const CREDITS_TTL_MS = 60 * 1000
const creditsCaches = new Map<string, { at: number; data: unknown }>()
const creditsInFlight = new Map<string, Promise<unknown>>()

async function creditsCached(key: string, load: () => Promise<unknown>): Promise<unknown> {
  const hit = creditsCaches.get(key)
  if (hit !== undefined && Date.now() - hit.at < CREDITS_TTL_MS) return hit.data
  // 单飞：并发的未命中只发一次上游请求，其余 await 同一个 Promise。
  // 没有这一步，十几标签同时刷就是同时向上游开十几枪。
  const running = creditsInFlight.get(key)
  if (running !== undefined) return running
  const p = load()
    .then((data) => {
      creditsCaches.set(key, { at: Date.now(), data })
      return data
    })
    .finally(() => { creditsInFlight.delete(key) })
  creditsInFlight.set(key, p)
  return p
}

async function claim(id: string): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const def = REGIONS.find(r => r.id === id)
  if (!def) return { ok: false, error: `未知区域：${id}` }
  const key = await readRegionKey(def.keyName)
  if (!key) return { ok: false, error: '该区域缺少 key' }
  const res = await fetchJson(`http://${HOST}:${def.port}/signin/claim`, key, 'POST', 40000)
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}

/**
 * 手动派遣。
 *
 * 并发锁：连点「全部派遣」时只放行一次，其余立刻回 409，不排队。
 * 不做二次确认——派遣可逆（服务端 daily_limit 每天只给一次机会）且收益为正，
 * 与 /api/update/apply 那种高危不可逆操作不是一个量级。
 */
let travelDepartInFlight = false

/**
 * 切换自动派遣总开关。
 *
 * 语义（用户明确要求）：关掉只停「新派遣」，**已经在途的仍会到点自动领取**——
 * 手动关一下不该把已赚的积分丢掉。开关状态由代理落盘，重启后保持。
 */
async function travelEnable(
  regionId: string,
  enabled: boolean,
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  const def = REGIONS.find(r => r.id === regionId)
  if (!def) return { ok: false, error: `未知区域：${regionId}` }
  if (def.provider !== 'WorkBuddy') return { ok: false, error: '仅 WorkBuddy 支持旅行派遣' }
  const key = await readRegionKey(def.keyName)
  if (!key) return { ok: false, error: '该区域缺少 key' }
  const res = await fetchJson(
    `http://${HOST}:${def.port}/travel/enable`, key, 'POST', 20000, JSON.stringify({ enabled }),
  )
  // 状态变了，作废缓存，让前端紧接着的 refresh 拿到新值
  if (res.ok) invalidateOverview()
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}

async function travelDepart(
  regionId: string,
  accountId?: string,
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  if (travelDepartInFlight) return { ok: false, status: 409, error: '已有派遣请求在处理中，请稍候' }
  const def = REGIONS.find(r => r.id === regionId)
  if (!def) return { ok: false, error: `未知区域：${regionId}` }
  if (def.provider !== 'WorkBuddy') return { ok: false, error: '仅 WorkBuddy 支持派遣' }
  const key = await readRegionKey(def.keyName)
  if (!key) return { ok: false, error: '该区域缺少 key' }
  travelDepartInFlight = true
  try {
    const body = accountId === undefined || accountId === '' ? '{}' : JSON.stringify({ id: accountId })
    // 内部会按账号错开 2 秒依次派出，最坏 3 个账号约十几秒，给足超时。
    const res = await fetchJson(`http://${HOST}:${def.port}/travel/depart`, key, 'POST', 90000, body)
    if (res.ok) invalidateOverview()
    return { ok: res.ok, status: res.status, data: res.data, error: res.error }
  } finally {
    travelDepartInFlight = false
  }
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

/** tool.html 同样内存缓存；改完重启生效，与面板一致。 */
let toolHtmlCache: string | null = null

async function serveTool(res: ServerResponse): Promise<void> {
  try {
    if (toolHtmlCache === null) toolHtmlCache = await readFile(join(PUBLIC_DIR, 'tool.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(toolHtmlCache)
  } catch {
    res.writeHead(500); res.end('缺少 tool.html')
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
  // 工具台页面：与面板同为单文件，但独立存放，互不干扰。
  // 注意它**不需要**鉴权——是个壳，数据全靠 /tool/api/*（那些要鉴权）。
  // 若这里也要求 key，浏览器直接输 URL 就进不去了。CSP 已限制它只能同源请求。
  if (req.method === 'GET' && url === '/tool') {
    await serveTool(res)
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
    // 工具台的接口面。放在鉴权之后，所以 /tool/api/* 自动受 hub-key 保护。
    // 认领制：不是 /tool/api 开头的路径会立刻返回 false，继续往下走原路由链。
    if (await toolRouter(req, res, url)) return

    if (req.method === 'POST' && url === '/api/proxies/restart') {
      const body = await readBody(req)
      if (!body.ok) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体过大' })); return }
      if (!parseRestartBody(body.text).confirmed) {
        audit(req, '/api/proxies/restart', false, 'bad-confirm')
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '缺少二次确认：请求体需为 {"confirm":"restart"}' }))
        return
      }
      if (restartInFlight) {
        audit(req, '/api/proxies/restart', true, 'busy')
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '已有一轮重启正在执行，请等它结束' }))
        return
      }
      restartInFlight = true
      audit(req, '/api/proxies/restart', true, 'begin')
      try {
        const outcome = await restartProxies({
          run: async (t, action) => {
            if (action === 'waitClosed' || action === 'waitOpen') {
              const wantOpen = action === 'waitOpen'
              const deadline = Date.now() + RESTART_TIMEOUT_MS
              while (Date.now() < deadline) {
                // 两个区域都要满足才算到位：只看第一个端口的话，
                // 第二个区域没起来也会被报成成功。
                const states = await Promise.all(t.ports.map(p => portAccepts(p)))
                if (wantOpen ? states.every(Boolean) : states.every(s => !s)) {
                  return { code: 0, stderr: '' }
                }
                await new Promise(r => setTimeout(r, 250))
              }
              return { code: 1, stderr: wantOpen ? '端口未监听' : '端口仍被占用' }
            }
            const script = action === 'stop' ? 'stop.ps1' : 'start.ps1'
            return runScript(join(PROXY_ROOT, t.dirName, 'scripts', script), RESTART_TIMEOUT_MS)
          },
          sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
        })
        const message = describeRestart(outcome)
        audit(req, '/api/proxies/restart', true, outcome.ok ? 'ok' : 'partial')
        for (const r of outcome.results) {
          log('info', `重启代理[${r.repo}] ${r.ok ? '成功' : '失败：' + (r.error ?? '')}`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...outcome, message })); return
      } catch (error) {
        audit(req, '/api/proxies/restart', true, 'error')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return
      } finally {
        restartInFlight = false
      }
    }
    if (req.method === 'GET' && url === '/api/overview') {
      const data = await overviewCached()
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/minimax/credits') {
      // MiniMax 全球区本机没有凭据，那一区拿不到就是拿不到——如实降级，不假装有
      const data = await creditsCached('minimax', minimaxCredits)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/workbuddy/credits') {
      const data = await creditsCached('workbuddy', workbuddyCredits)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/trae/credits') {
      const data = await creditsCached('trae', traeCredits)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    if (req.method === 'GET' && url === '/api/services') {
      const settled = await Promise.allSettled(REGIONS.map(async d => ({ id: d.id, port: d.port, running: await probePort(d.port) })))
      const svc = settled.map(r => r.status === 'fulfilled'
        ? r.value
        : { id: '?', port: 0, running: false, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
      // 一并下发重启目标与「本面板怎么重启」：面板的确认框要列出「会重启哪几个、
      // 哪些端口」，而 agent-hub 自己的生效方式也必须来自这里——硬编码安装路径会在
      // 别人换安装目录时给出跑不通的命令。
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        services: svc,
        restartTargets: RESTART_TARGETS,
        selfRestart: { repo: 'agent-hub', text: selfRestartHint('agent-hub') },
      })); return
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
    if (req.method === 'POST' && url === '/api/travel/depart') {
      const body = await readBody(req)
      if (!body.ok) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体过大' })); return }
      // region 必填；accountId 可省略（省略 = 该区域所有可派账号各派一次）
      let regionId = ''
      let accountId: string | undefined
      try {
        const parsed = JSON.parse(body.text || '{}') as { region?: unknown; id?: unknown }
        if (typeof parsed.region === 'string') regionId = parsed.region
        if (typeof parsed.id === 'string' && parsed.id !== '') accountId = parsed.id
      } catch { /* 解析失败按缺少 region 处理 */ }
      if (!regionId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 region' })); return }
      const result = await travelDepart(regionId, accountId)
      // 409 表示并发占用，如实透传状态码让前端能区分「忙」与「失败」
      res.writeHead(result.status === 409 ? 409 : result.ok ? 200 : 502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result)); return
    }
    if (req.method === 'POST' && url === '/api/travel/enable') {
      const body = await readBody(req)
      if (!body.ok) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '请求体过大' })); return }
      let regionId = ''
      let enabled = true
      try {
        const parsed = JSON.parse(body.text || '{}') as { region?: unknown; enabled?: unknown }
        if (typeof parsed.region === 'string') regionId = parsed.region
        // 缺省视为「开启」；只接受布尔值，不猜。
        if (typeof parsed.enabled === 'boolean') enabled = parsed.enabled
      } catch { /* 按缺省处理 */ }
      if (!regionId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '缺少 region' })); return }
      const result = await travelEnable(regionId, enabled)
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
        audit(req, '/api/update/apply', false, 'bad-confirm')
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '缺少二次确认：请求体需为 {"confirm":"apply"}' }))
        return
      }
      if (applyInFlight) {
        audit(req, '/api/update/apply', true, 'busy')
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '已有一次更新正在执行，请稍后重试' }))
        return
      }
      applyInFlight = true
      try {
        const data = await checkUpdates(true)
        const results = (data as { results?: Array<{ name: string; state: string; latest: string }> }).results ?? []
        audit(req, '/api/update/apply', true, results.map(r => `${r.name}=${r.state}@${r.latest}`).join(',') || 'no-repos')
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return
      } catch (error) {
        audit(req, '/api/update/apply', true, `error:${error instanceof Error ? error.message : String(error)}`)
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


/**
 * 工具台的路由实例。在 main() 里初始化——因为它的依赖（authed）读的是
 * main() 阶段才载入的 HUB_KEY，提前建会在 key 还是空串时把 authed 闭包定死。
 */
let toolRouter: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>

async function main(): Promise<void> {
  HUB_KEY = await loadOrCreateHubKey()
  toolRouter = createToolRouter({ authed, log })
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

  // 每日自动检查更新：启动后在一个约 7.5 分钟的窗口内退避重试，之后每 24 小时一次。
  // 只做 git 快进（ff-only），有更新会写 state/update-pending.json，重启代理后生效。
  //
  // 之所以要在启动窗口内重试：readCurrentVersion 是问代理的 /status 要版本号，
  // 开机时代理常常还没监听端口，一次检查就会把三个仓全跳过，而下一轮在 24 小时后。
  if ((process.env['OPCODE_NO_AUTO_UPDATE'] ?? '') === '') {
    const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))
    void startupUpdateCheck({
      check: async () => await checkUpdates(true) as { results?: unknown[] },
      total: UPDATABLE.length,
      delaysMs: STARTUP_RETRY_DELAYS_MS,
      sleep,
      log: m => log('info', m),
    }).catch(() => {}).finally(() => { /* noop */ })
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
