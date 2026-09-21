/**
 * 轻量自动更新检查（零依赖）。
 *
 * 策略（安全、保守，绝不在后台强行重启正在服务的代理）：
 *  1. 读取本机各代理的 version.ts 常量；
 *  2. 查询 GitHub 仓库的最新 release tag（如 v1.2.0）；
 *  3. 语义版本比对，远端更新则在对应仓库目录执行 `git fetch + git merge --ff-only`；
 *  4. 代码更新后**不自动重启进程**（避免打断正在进行的对话），只写一个
 *     `state/update-pending.json` 标记 + 打日志；下次开机/手动重启即生效。
 *     hub 面板或启动脚本可据此提示用户。
 *
 * 只做 `--ff-only` 快进合并：本地若有未提交改动会失败并跳过，不会覆盖任何东西。
 *
 * 环境变量：
 *   OPCODE_NO_AUTO_UPDATE=1   完全关闭
 *   各代理目录必须是 git 仓库（安装时 clone 得到）。
 *
 * @module agent-hub/updater
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface RepoSpec {
  /** 展示名 */
  name: string
  /** GitHub 仓库 owner/name */
  repo: string
  /** 本地仓库目录 */
  dir: string
  /** 当前版本（semver，不含 v 前缀）*/
  currentVersion: string
}

export interface RepoUpdateResult {
  name: string
  repo: string
  current: string
  latest: string
  /** none=已是最新 | updated=已快进更新（待重启）| behind=有更新但拉取失败 | error */
  state: 'none' | 'updated' | 'behind' | 'error'
  message?: string
}

const CHECK_TIMEOUT_MS = 15_000

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, stdout, stderr: 'timeout' }) }, timeoutMs)
    child.stdout.on('data', d => { stdout += String(d) })
    child.stderr.on('data', d => { stderr += String(d) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err.message) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
  })
}

/** 解析 semver 字符串，忽略非数字后缀；失败返回 [0,0,0]。 */
export function parseSemver(v: string): [number, number, number] {
  const m = String(v).trim().replace(/^v/i, '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return [0, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a > b 返回 true。 */
export function isNewer(a: string, b: string): boolean {
  const [ax, ay, az] = parseSemver(a)
  const [bx, by, bz] = parseSemver(b)
  return ax > bx ? true : ax < bx ? false : ay > by ? true : ay < by ? false : az > bz
}

/** 查 GitHub 最新 release tag（优先 latest release，回退 tags 列表最新一个）。 */
async function fetchLatestTag(repo: string): Promise<string | undefined> {
  const ctrl = AbortSignal.timeout(CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'opencode-local-proxy-updater' },
      signal: ctrl,
    })
    if (res.ok) {
      const j = await res.json() as { tag_name?: string }
      if (j.tag_name) return j.tag_name
    }
  } catch {
    // 回退到 tags
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'opencode-local-proxy-updater' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (res.ok) {
      const arr = await res.json() as Array<{ name: string }>
      return arr.find(t => /^v?\d+\.\d+\.\d+$/.test(t.name))?.name
    }
  } catch {
    // 离线：静默
  }
  return undefined
}

/** 对外暴露：只查 GitHub 最新 tag（不更新）。 */
export async function peekLatestTag(repo: string): Promise<string | undefined> {
  const tag = await fetchLatestTag(repo)
  return tag?.replace(/^v/, '')
}

/** 对单个仓库执行：检查 → 快进更新。 */
export async function checkAndUpdate(spec: RepoSpec): Promise<RepoUpdateResult> {
  const base: RepoUpdateResult = { name: spec.name, repo: spec.repo, current: spec.currentVersion, latest: spec.currentVersion, state: 'none' }
  if ((process.env['OPCODE_NO_AUTO_UPDATE'] ?? '') !== '') return base

  const tag = await fetchLatestTag(spec.repo)
  if (!tag) return { ...base, message: '无法获取远端版本（离线？）' }
  const latest = tag.replace(/^v/, '')
  if (!isNewer(latest, spec.currentVersion)) return base

  // 有新版本：快进拉取
  const fetchRes = await run('git', ['fetch', '--quiet', 'origin', 'main'], spec.dir)
  if (fetchRes.code !== 0) {
    // 默认分支可能叫 master
    const f2 = await run('git', ['fetch', '--quiet', 'origin'], spec.dir)
    if (f2.code !== 0) return { ...base, latest, state: 'behind', message: 'git fetch 失败' }
  }
  const merge = await run('git', ['merge', '--ff-only', '--quiet', 'origin/main'], spec.dir)
  if (merge.code !== 0) {
    const m2 = await run('git', ['merge', '--ff-only', '--quiet', 'origin/master'], spec.dir)
    if (m2.code !== 0) {
      return { ...base, latest, state: 'behind', message: '本地有改动或分叉，跳过自动更新' }
    }
  }
  return { ...base, latest, state: 'updated', message: `已更新到 v${latest}，重启代理后生效` }
}

/** 批量检查所有仓库，并把待重启标记写到 agent-hub/state/update-pending.json。 */
export async function checkAll(specs: RepoSpec[], stateFile: string, log?: (m: string) => void): Promise<RepoUpdateResult[]> {
  const results: RepoUpdateResult[] = []
  for (const spec of specs) {
    try {
      const r = await checkAndUpdate(spec)
      results.push(r)
      if (r.state === 'updated') log?.(`更新[${spec.name}] ${spec.currentVersion} → ${r.latest}（重启生效）`)
      else if (r.state === 'behind') log?.(`更新[${spec.name}] 有 v${r.latest} 但未能自动更新：${r.message ?? ''}`)
    } catch (error) {
      results.push({ ...({ name: spec.name, repo: spec.repo, current: spec.currentVersion, latest: spec.currentVersion, state: 'error' }), message: String(error) })
    }
  }
  const pending = results.filter(r => r.state === 'updated')
  if (pending.length > 0) {
    try {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(stateFile, JSON.stringify({ checkedAt: Date.now(), pending, all: results }, null, 2) + '\n', 'utf8')
    } catch {
      // 写标记失败不影响主流程
    }
  } else {
    // 没有待更新时顺手读一下旧标记是否存在（不强制删除，交给面板）
    void readFile(stateFile, 'utf8').catch(() => '')
  }
  return results
}
