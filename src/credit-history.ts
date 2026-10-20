/**
 * 每日积分用量历史：纯数据层，不做任何 IO、不碰网络。
 *
 * ## 为什么只能靠「余额差值」推算
 *
 * 四家上游都**只给余额，不给按天的累计消耗**：
 *  - WorkBuddy：`total` 是各包 `CapacityRemain` 求和（余额）；
 *  - Trae：`consumed` 是**当前额度周期内**的累计，不是某一天的；
 *  - MiniMax / Qoder：同样只有当前余额。
 *
 * 所以「某天用了多少」只能：
 *
 *     某日用量 = 该日基准余额 − 次日基准余额 + 该日签到所得
 *
 * ## 签到为什么要加回来
 *
 * 签到窗口是 7:00–10:00（写死在 workbuddy-proxy 的 signin 配置里），而基准在
 * 0:00 采。于是顺序是：0:00 采基准 → 7:00 签到 +100 → 余额凭空多 100。
 * 若直接用差值，当天「用量」会被这 100 稀释掉（甚至变负）。把当天**实际领到**的
 * 签到分加回去，才等于真正的消耗。
 *
 * 签到是**按账号**记录的（WorkBuddy 池里有多个号），而这里要的是**按提供商**汇总。
 * 所以累加的是「当天所有签到成功事件的 dailyCredit 之和」，不是某个号的余额差。
 *
 * ## 其他会让余额上升的情况
 *
 * 月度包刷新、旅行派遣奖励、赠送礼包——这些**没有签到记录可扣**。差额算出来是负的
 * 时，按 0 处理并标记该日「含入账」。绝不显示负数用量（那会被读成「赚了积分」）。
 *
 * @module agent-hub/credit-history
 */

/** 记录的提供商（只要国内版，用户明确要求按「国内版用了多少」呈现）。 */
export const HISTORY_PROVIDERS = ['workbuddy', 'trae', 'minimax', 'qoder'] as const
export type HistoryProvider = (typeof HISTORY_PROVIDERS)[number]

/** 提供商展示名，与积分页其它地方保持一致。 */
export const PROVIDER_LABELS: Readonly<Record<HistoryProvider, string>> = {
  workbuddy: 'WorkBuddy 国内',
  trae: 'Trae 国内',
  minimax: 'MiniMax 国内',
  qoder: 'Qoder 国内',
}

/**
 * 一天一份采样。
 *
 * `balances` 只存**成功取到**的提供商；取不到的直接缺键，而不是写 0——
 * 写 0 会让次日算出一个巨大的假用量。
 */
export interface DailySample {
  /** 本地日期 YYYY-MM-DD（采样那一刻的日历日）。 */
  date: string
  /** 采样时刻（epoch ms），用于排查「这天到底是几点采的」。 */
  sampledAtMs: number
  /** 各提供商当次余额快照；缺失 = 那次没取到。 */
  balances: Partial<Record<HistoryProvider, number>>
  /**
   * 该采样时刻**当天已签到成功**的积分合计（按提供商）。
   * 与 balances 同刻采集，保证「差值与签到分」口径一致。
   */
  signinCredits: Partial<Record<HistoryProvider, number>>
}

/** 历史文件的顶层结构。 */
export interface CreditHistoryFile {
  /** 结构版本号，将来改格式时用于迁移。 */
  version: 1
  /** 按日期升序（写入时保证）。 */
  samples: DailySample[]
}

/** 某一天的用量结果。 */
export interface DailyUsage {
  date: string
  /** 各提供商当天用量；null = 当天无法计算（缺基准或缺次日基准）。 */
  used: Record<HistoryProvider, number | null>
  /**
   * 各提供商当天是否「含入账」——即余额上升超过了签到所得，
   * 只能是月度包刷新/旅行奖励/赠送之类的非签到入账。此时用量按 0 记。
   */
  credited: Record<HistoryProvider, boolean>
}

/** 本地日期 YYYY-MM-DD。用本地时区，与用户看日历的方式一致。 */
export function localDateOf(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 从签到结果文本里解析领到的积分。
 *
 * 实测四家的文案都是 `签到成功，+100 积分（连签 21 天）` / `签到成功，+400 积分（连续额...）`。
 * 解析不出来就返回 undefined，调用方应当**当作未知**而不是 0——
 * 把「不认识」当成「没领到」会让当天的用量被高估。
 */
export function parseSigninCredits(resultText: string | undefined): number | undefined {
  if (typeof resultText !== 'string' || resultText === '') return undefined
  // 匹配 +100 / 100 分 这两类写法；先试带加号的，避免匹配到「连签 21 天」里的数字。
  const plus = /\+(\d+(?:\.\d+)?)\s*积?分?/.exec(resultText)
  if (plus !== null) {
    const n = Number(plus[1])
    if (Number.isFinite(n) && n >= 0) return n
  }
  return undefined
}

/**
 * 把一批签到状态条目汇总成「当天各提供商领到的积分」。
 *
 * @param entries 每项含：提供商、该条目的日期、是否 claimed、结果文本
 */
export function sumSigninCredits(
  entries: ReadonlyArray<{ provider: HistoryProvider; date: string; claimed: boolean; result?: string }>,
  date: string,
): Partial<Record<HistoryProvider, number>> {
  const out: Partial<Record<HistoryProvider, number>> = {}
  for (const e of entries) {
    if (e.date !== date) continue
    if (!e.claimed) continue
    const n = parseSigninCredits(e.result)
    // 解析不出金额就不计入：宁可少算签到分（用量偏高），也不编一个数。
    if (n === undefined) continue
    out[e.provider] = (out[e.provider] ?? 0) + n
  }
  return out
}

/**
 * 写入/更新某一天的采样（同一天多次采样以最后一次为准，除了签到分取较大值）。
 *
 * 为什么签到分取**较大值**而不是覆盖：签到的 dailyCredit 是单调累加的（当天领了
 * 几个号就累加几个），采样时刻越晚越完整；但若某次采样在签到前、一次在签到后，
 * 取最后一次会正确；若两次都在签到后且后一次因为上游抖动少读到一个号，取较大值
 * 能避免把已确认的签到分丢掉。
 */
export function upsertSample(file: CreditHistoryFile, next: DailySample): CreditHistoryFile {
  const samples = file.samples.filter(s => s.date !== next.date)
  samples.push(next)
  samples.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { version: 1, samples }
}

/**
 * 由连续两天的采样推导「前一天」的用量。
 *
 * 规则（用户拍定）：
 *  - 缺当天基准 → null（无记录，绝不补 0）；
 *  - 缺次日基准 → null（还没到次日 0 点，今天还没结算）；
 *  - 某提供商在任一端缺失 → 该家 null（不拿单边数据编结果）；
 *  - `used = 基准 − 次日基准 + 当天签到分`；
 *  - `used < 0` → 记 0，并标记 credited（余额涨了，只能是入账 > 签到分）。
 */
export function usageForDay(day: DailySample, nextDay: DailySample | undefined): DailyUsage {
  const used = {} as Record<HistoryProvider, number | null>
  const credited = {} as Record<HistoryProvider, boolean>
  for (const p of HISTORY_PROVIDERS) {
    const start = day.balances[p]
    const end = nextDay?.balances[p]
    if (typeof start !== 'number' || typeof end !== 'number') {
      used[p] = null
      credited[p] = false
      continue
    }
    const signin = day.signinCredits[p] ?? 0
    const raw = start - end + signin
    if (raw < 0) {
      used[p] = 0
      credited[p] = true
    } else {
      // 保留两位小数：Trae 的额度是带小数的（7950.000、7350.886）。
      used[p] = Math.round(raw * 100) / 100
      credited[p] = false
    }
  }
  return { date: day.date, used, credited }
}

/**
 * 把一份历史文件换算成逐日用量（升序），最多返回最近 `limit` 天。
 *
 * 最后一天**总是** null：它还没有次日基准，尚未结算。这是正确行为，
 * 不是 bug——面板据此把最新一行显示成「统计中」。
 */
export function dailyUsages(file: CreditHistoryFile, limit = 30): DailyUsage[] {
  const out: DailyUsage[] = []
  for (let i = 0; i < file.samples.length; i++) {
    const day = file.samples[i] as DailySample
    out.push(usageForDay(day, file.samples[i + 1]))
  }
  return out.slice(-Math.max(1, limit))
}

/**
 * 裁到最近 `keepDays` 天（按日期字符串排序，保留尾部）。
 *
 * 用户要求只留最近 30 天。多数 1 天：文件不会无限增长。
 */
export function pruneSamples(file: CreditHistoryFile, keepDays = 30): CreditHistoryFile {
  const keep = Math.max(1, Math.floor(keepDays))
  if (file.samples.length <= keep) return file
  const sorted = [...file.samples].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { version: 1, samples: sorted.slice(-keep) }
}

/**
 * 解析历史文件；任何畸形输入都降级成空文件，绝不抛错。
 *
 * 这文件是自动生成的：写坏了不该让面板打不开。但也**不能**把坏文件当成空之后
 * 立刻写回——那样会把好数据覆盖掉。调用方读到空时应当先确认文件确实不存在。
 */
export function parseHistoryFile(raw: string | null | undefined): CreditHistoryFile {
  const empty: CreditHistoryFile = { version: 1, samples: [] }
  if (typeof raw !== 'string' || raw.trim() === '') return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const obj = parsed as { samples?: unknown }
  if (!Array.isArray(obj.samples)) return empty
  const samples: DailySample[] = []
  for (const item of obj.samples) {
    if (typeof item !== 'object' || item === null) continue
    const s = item as Record<string, unknown>
    const date = typeof s['date'] === 'string' ? s['date'] : ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const sampledAtMs = typeof s['sampledAtMs'] === 'number' ? s['sampledAtMs'] : 0
    const balances: Partial<Record<HistoryProvider, number>> = {}
    const bal = (typeof s['balances'] === 'object' && s['balances'] !== null ? s['balances'] : {}) as Record<string, unknown>
    for (const p of HISTORY_PROVIDERS) {
      const v = bal[p]
      // 只接受有限非负数：负余额是上游脏值，当成「没取到」比留着好。
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) balances[p] = v
    }
    const signinCredits: Partial<Record<HistoryProvider, number>> = {}
    const sc = (typeof s['signinCredits'] === 'object' && s['signinCredits'] !== null ? s['signinCredits'] : {}) as Record<string, unknown>
    for (const p of HISTORY_PROVIDERS) {
      const v = sc[p]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) signinCredits[p] = v
    }
    samples.push({ date, sampledAtMs, balances, signinCredits })
  }
  samples.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return { version: 1, samples }
}

/**
 * 计算「到下一个本地 0 点」还有多少毫秒。
 *
 * 与 workbuddy-proxy 的刷新对齐同一思路：`Date.now()` 是 UTC epoch，
 * 直接用 `% 一天` 得到的是 UTC 午夜基准，必须用 `getTimezoneOffset()` 平移回本地。
 *
 * 返回恒为正（> 0）；恰在 0 点整时返回一整天（那一刻已经过了）。
 */
export function msUntilNextLocalMidnight(
  now: number = Date.now(),
  tzOffsetMinutes: number = new Date(now).getTimezoneOffset(),
): number {
  const DAY = 24 * 60 * 60 * 1000
  const eastwardMs = -tzOffsetMinutes * 60 * 1000
  const dayProgress = (((now + eastwardMs) % DAY) + DAY) % DAY
  return DAY - dayProgress
}
