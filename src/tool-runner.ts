/**
 * 工具台的 Python 桥。
 *
 * 这是**唯一**一处知道「怎么调 myuseofminerU 的 CLI」的代码。集中在这里
 * 的理由：解释器路径、工作目录、输出解析规则都是易错且需要被测试钉住的
 * 东西，散落到路由层就会各写各的。
 *
 * 两条实测得来的硬事实（不要凭直觉改）：
 *  1. 必须用 `py -3.14`。裸 `python` 指向一个已损坏的 uv trampoline
 *     （hermes venv），会直接 `error: uv trampoline failed to spawn`。
 *  2. cwd 必须是 myuseofminerU 目录。cli.py 用相对 import
 *     （from api_client import ...），换目录跑必然 ModuleNotFoundError。
 */

import { spawn } from 'node:child_process'

export const PY_LAUNCHER = 'py'
export const PY_VERSION = '-3.14'
export const CLI_ENTRY = 'cli.py'
export const CLI_CWD = 'D:\\Software\\my_pdfedit\\myuseofminerU'

/** CLI 输出归一化后的形状。 */
export interface CliResult {
  code: number
  ok: boolean
  json: unknown | null
  stderr: string
  raw: string
}

/**
 * 从可能被日志污染的 stdout 里抠出 JSON。
 *
 * 取「首个 `{` 到末个 `}`」的跨度再 parse。这样即使 CLI 前后打了调试行，
 * 只要正文是一个完整对象就能读出来；抠不出或 parse 失败一律返回 null，
 * 由调用方按「有退出码但没数据」处理，而不是抛异常打断整个请求。
 */
function extractJson(stdout: string): unknown | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 把「退出码 + 两路输出」翻译成结构化结果。
 *
 * 刻意做成纯函数：退出码映射是最容易写错、也最值得被测试覆盖的地方，
 * 不需要真的起进程就能测。
 */
export function parseCliOutput(code: number, stdout: string, stderr: string): CliResult {
  const json = extractJson(stdout)
  return {
    code,
    ok: code === 0,
    json,
    stderr: stderr.trim(),
    raw: stdout,
  }
}

/** 退出码的中文说明。语义出自 cli_controller.decide_exit_code（已实测）。 */
export function describeExitCode(code: number): string {
  switch (code) {
    case 0: return '成功'
    case 2: return '参数错误（检查路径是否存在、目录里是否有支持的文件）'
    case 3: return '部分文件失败'
    case 4: return '全部文件失败'
    case 5: return '额度或密钥问题'
    case 6: return '有任务未完成，可续跑'
    default: return `未知退出码 ${code}`
  }
}

export interface RunOptions {
  args: string[]
  timeoutMs?: number
}

/**
 * 起一个 CLI 子进程并把结果收全。
 *
 * 超时不 kill 掉就返回，而是发 SIGTERM 后仍等 stdout 收尾——因为 CLI 在
 * 被中断时会保存状态文件（退出码 6 的语义），粗暴 kill 会丢掉这个状态。
 * 超时后返回码用 -1 表示「本地超时」，与 CLI 自己的语义码区分开。
 */
export function runCli(options: RunOptions): Promise<CliResult> {
  const { args, timeoutMs = 0 } = options
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const child = spawn(PY_LAUNCHER, [PY_VERSION, CLI_ENTRY, ...args], {
      cwd: CLI_CWD,
      windowsHide: true,
    })

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(parseCliOutput(code, stdout, stderr))
    }

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })

    child.on('error', (err: Error) => {
      stderr += `\n[启动失败] ${err.message}`
      finish(-1)
    })
    child.on('close', (code: number | null) => { finish(code ?? -1) })

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stderr += '\n[本地超时] 已请求中断'
        child.kill()
      }, timeoutMs)
    }
  })
}
