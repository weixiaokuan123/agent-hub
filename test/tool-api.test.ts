import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createToolRouter } from '../src/tool-api.ts'

/**
 * 路由层测试只钉「认不认这条路」和「鉴权失败怎么答」。
 * 真正跑 Python 的部分在 tool-runner 的测试里，这里一律不碰网络与子进程。
 */

/** 造一个最小的假 req/res，够路由判断用。 */
function fakeReq(method: string, authorized: boolean): IncomingMessage {
  return {
    method,
    headers: authorized ? { authorization: 'Bearer test-key' } : {},
  } as unknown as IncomingMessage
}

interface Captured { status: number; body: string }
function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: '' }
  const res = {
    writeHead: (status: number) => { captured.status = status; return res },
    end: (chunk?: string) => { captured.body = chunk ?? '' },
    headersSent: false,
  } as unknown as ServerResponse
  return { res, captured }
}

/**
 * runCli 是注入进来的，不是模块内直接 import 的。
 *
 * 理由：路由层测试不该真的去 spawn Python —— 那会让测试依赖本机装了
 * py -3.14、依赖 myuseofminerU 目录存在，还要等几秒钟。把 runCli 当依赖
 * 传进来，这些用例才能在毫秒级跑完，且能构造各种退出码而不必制造真实故障。
 */
type RunCli = (options: { args: string[]; timeoutMs?: number }) => Promise<{
  code: number; ok: boolean; json: unknown | null; stderr: string; raw: string
}>

/** 默认的假 runCli：永不真正执行，返回一个固定的成功 JSON。 */
function fakeRunCli(result?: Partial<{ code: number; json: unknown; stderr: string }>): RunCli {
  const code = result?.code ?? 0
  // 注意用 'json' in result 判断，而不是 ?? —— 需要能显式传 json: null
  // 来模拟「CLI 没吐 JSON」这条真实存在的路径（退出码 2 时的行为）。
  const hasJson = result !== undefined && 'json' in result
  return async () => ({
    code,
    ok: code === 0,
    json: hasJson ? (result as { json: unknown }).json : { ok: true, probe: 'fake' },
    stderr: result?.stderr ?? '',
    raw: '',
  })
}

const deps = {
  authed: (req: IncomingMessage) => Boolean(req.headers.authorization),
  log: () => {},
  runCli: fakeRunCli(),
}

test('不认领非 /tool/api 开头的路径', async () => {
  const router = createToolRouter(deps)
  const { res } = fakeRes()
  const handled = await router(fakeReq('GET', true), res, '/api/overview')
  assert.equal(handled, false)
})

test('认领 /tool/api/info', async () => {
  const router = createToolRouter(deps)
  const { res } = fakeRes()
  const handled = await router(fakeReq('GET', true), res, '/tool/api/info')
  assert.equal(handled, true)
})

test('未鉴权时 /tool/api/* 返回 401', async () => {
  const router = createToolRouter(deps)
  const { res, captured } = fakeRes()
  await router(fakeReq('GET', false), res, '/tool/api/info')
  assert.equal(captured.status, 401)
  assert.match(captured.body, /未授权/)
})

test('未知的 /tool/api/xxx 返回 404 但认领（不再往下传）', async () => {
  const router = createToolRouter(deps)
  const { res, captured } = fakeRes()
  const handled = await router(fakeReq('GET', true), res, '/tool/api/nonexistent')
  assert.equal(handled, true)
  assert.equal(captured.status, 404)
})

test('方法不匹配时返回 405', async () => {
  const router = createToolRouter(deps)
  const { res, captured } = fakeRes()
  await router(fakeReq('DELETE', true), res, '/tool/api/info')
  assert.equal(captured.status, 405)
})

test('/tool/api/info 成功时把 CLI 的 JSON 原样透传', async () => {
  const router = createToolRouter({
    ...deps,
    runCli: fakeRunCli({ json: { provider: 'mistral', quota_files_remaining: 5000 } }),
  })
  const { res, captured } = fakeRes()
  await router(fakeReq('GET', true), res, '/tool/api/info')
  assert.equal(captured.status, 200)
  const parsed = JSON.parse(captured.body) as { provider: string; quota_files_remaining: number }
  assert.equal(parsed.provider, 'mistral')
  assert.equal(parsed.quota_files_remaining, 5000)
})

test('退出码 2（stdout 无 JSON）时返回 502 且带上退出码说明', async () => {
  const router = createToolRouter({
    ...deps,
    runCli: fakeRunCli({ code: 2, json: null, stderr: '[ERROR] 输入目录不存在' }),
  })
  const { res, captured } = fakeRes()
  await router(fakeReq('GET', true), res, '/tool/api/info')
  assert.equal(captured.status, 502)
  const parsed = JSON.parse(captured.body) as { error: string; code: number }
  assert.equal(parsed.code, 2)
  assert.match(parsed.error, /参数错误/)
})

test('/tool/api/dry-run 缺 inputDir 时返回 400，不调用 CLI', async () => {
  let called = false
  const router = createToolRouter({
    ...deps,
    runCli: async (o) => { called = true; return fakeRunCli()(o) },
  })
  const req = fakeReq('POST', true) as IncomingMessage & {
    on: (event: string, cb: (chunk?: Buffer) => void) => void
  }
  // 模拟一个空 body 的 POST
  req.on = (event: string, cb: (chunk?: Buffer) => void) => {
    if (event === 'end') cb()
    return req
  }
  const { res, captured } = fakeRes()
  await router(req, res, '/tool/api/dry-run')
  assert.equal(captured.status, 400)
  assert.match(captured.body, /inputDir/)
  assert.equal(called, false, '缺参时不该调用 CLI')
})
