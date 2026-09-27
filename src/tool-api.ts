/**
 * 工具台的 HTTP 面。
 *
 * 设计约束来自 agent-hub 现有环境，不是自由发挥：
 *  - 鉴权复用现有 hub-key（调用方传进来的 authed），不新造一套；
 *  - 请求体上限 1 MB，所以**所有接口只收路径字符串，不收文件内容**；
 *  - CSP 是 connect-src 'self'，前端只能打回同源。
 *
 * 路由做成「认领制」：返回 true 表示已处理，false 表示不是我的路。
 * 这样 server.ts 里只需要一行委托，不必把工具台的路由知识塞进主 handle()。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { runCli as defaultRunCli, describeExitCode, type CliResult } from './tool-runner.ts'

type RunCli = (options: { args: string[]; timeoutMs?: number }) => Promise<CliResult>

export interface ToolApiDeps {
  authed: (req: IncomingMessage) => boolean
  log: (level: string, ...args: unknown[]) => void
  /**
   * 可注入的 CLI 调用器。生产环境用默认实现（真 spawn Python）；
   * 测试传入假实现，避免路由层测试依赖本机 Python 环境。
   */
  runCli?: RunCli
}

const PREFIX = '/tool/api'

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 读请求体，超 1 MB 直接返回 null（与 agent-hub 的 BODY_LIMIT 一致）。 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return
      size += c.length
      if (size > 1024 * 1024) { tooLarge = true; chunks.length = 0; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

export function createToolRouter(
  deps: ToolApiDeps,
): (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean> {
  const { authed, log } = deps
  const runCli: RunCli = deps.runCli ?? defaultRunCli

  return async (req, res, url) => {
    if (!url.startsWith(PREFIX)) return false

    if (!authed(req)) {
      json(res, 401, { error: '未授权' })
      return true
    }

    const route = url.slice(PREFIX.length)

    try {
      // ---- GET /tool/api/info：配置与配额 ----
      if (route === '/info') {
        if (req.method !== 'GET') { json(res, 405, { error: '方法不允许' }); return true }
        const r = await runCli({ args: ['info'] })
        if (r.json === null) {
          json(res, 502, { error: describeExitCode(r.code), code: r.code, stderr: r.stderr })
          return true
        }
        json(res, 200, r.json)
        return true
      }

      // ---- POST /tool/api/dry-run：只做计划，不烧额度 ----
      if (route === '/dry-run') {
        if (req.method !== 'POST') { json(res, 405, { error: '方法不允许' }); return true }
        const body = await readBody(req)
        if (body === null) { json(res, 413, { error: '请求体过大' }); return true }
        let dir = ''
        try {
          const parsed = JSON.parse(body || '{}') as { inputDir?: unknown }
          if (typeof parsed.inputDir === 'string') dir = parsed.inputDir
        } catch { /* 解析失败按缺参处理 */ }
        if (dir === '') { json(res, 400, { error: '缺少 inputDir' }); return true }

        const r = await runCli({ args: ['process', '--input-dir', dir, '--dry-run'], timeoutMs: 120_000 })
        if (r.json === null) {
          json(res, 502, { error: describeExitCode(r.code), code: r.code, stderr: r.stderr })
          return true
        }
        json(res, 200, r.json)
        return true
      }

      json(res, 404, { error: '未找到' })
      return true
    } catch (error) {
      log('error', '工具台请求失败：', error)
      if (!res.headersSent) json(res, 500, { error: '内部错误' })
      return true
    }
  }
}
