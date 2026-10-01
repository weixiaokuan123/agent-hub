/**
 * 四个仓（面板 + 三个代理）住在一起时，「代理都在哪」的解析规则。
 *
 * ## 为什么需要显式解析，而不是直接 `join(ROOT, '..')`
 *
 * 早期 hub 和三个代理是**平级**的（都在 `~\.config\opencode\` 下），
 * 所以找代理只需要上跳一级。后来四个仓一起搬进 `proxy-suite\`，
 * 「上一级」从「代理所在目录」变成了「proxy-suite 的父目录」——
 * 那次搬迁要是没同步改这里，面板仍能起、仍能读自己的 key，
 * 但**所有跨仓功能会静默失效**：积分读不到、重启按钮报失败。
 * 而这些失败的共同特点是「不抛异常，只是空值」，最难在第一时间发现。
 *
 * 一次具体踩过的坑：某轮搬迁漏改了这里，面板首页照常显示，
 * 只是积分全空、点重启没反应。日志里也没有任何错误。
 *
 * ## 解析优先级
 *
 * 1. 环境变量 `PROXY_SUITE_ROOT` —— 临时指到别处（测试、并行实例）时用；
 * 2. 显式声明文件 `proxy-suite.json` —— 常态路径，把「代理在哪」写进配置
 *    而不是散落在代码的相对路径推算里；
 * 3. 退回「hub 的上一级」—— 兜底，保证任何未知布局下都有确定行为，
 *    而不是解析出 undefined 之后一路崩到调用方。
 *
 * 三级兜底不是可有可无的：宁可指向一个错目录让面板明确报错，
 * 也不要「找不到」时抛异常——后者会连面板自身一起拖死，
 * 用户连「到底哪里错了」都看不到。
 *
 * @module agent-hub/proxy-root
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 环境变量名：临时覆盖代理所在目录。 */
export const SUITE_ROOT_ENV = 'PROXY_SUITE_ROOT'

/** 显式声明文件的名字。放在 hub 自己目录下（随仓分发），内容是代理根的绝对路径。 */
export const SUITE_MANIFEST = 'proxy-suite.json'

/**
 * 读显式声明文件里的 `proxyRoot`。
 *
 * 找不到文件、JSON 坏了、字段缺失——**一律返回 null**，交给调用方退到兜底。
 * 刻意不抛异常：声明文件是「可选增强」，它坏了不该让面板起不来，
 * 而应该退回旧行为（上一级）继续工作。
 */
export function readManifestProxyRoot(manifestPath: string): string | null {
  try {
    if (!existsSync(manifestPath)) return null
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { proxyRoot?: unknown }
    const v = raw?.proxyRoot
    if (typeof v !== 'string' || v.trim() === '') return null
    const s = v.trim()
    // 绝对路径直接用；相对路径按声明文件所在目录解析，而不是按进程 cwd——
    // cwd 随调用方变化（钩子、计划任务、面板自身），
    // 按 cwd 解析会让同一条配置在不同启动方式下指向不同地方。
    //
    // 注意 Windows 上 `isAbsolute('/from/x')` 是 **false**（前导斜杠不算绝对路径），
    // 而 `resolve` 会给它补上当前盘符变成 `C:\from\x`——于是声明文件里
    // 写一个 POSIX 风格的绝对路径，会被当成相对路径悄悄改写。
    // 这里显式把「以斜杠或盘符开头」都当作绝对路径，避免这种静默改写。
    if (isAbsolute(s) || /^[\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) {
      return resolve(s)
    }
    return resolve(dirname(manifestPath), s)
  } catch {
    return null
  }
}

/**
 * 解析三个代理所在的目录。
 *
 * @param hubRoot agent-hub 自己的目录（不是它的 src）
 * @param env     环境变量，通常传 `process.env`；单独抽出来是为了可测
 */
export function resolveProxyRoot(
  hubRoot: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[SUITE_ROOT_ENV]?.trim()
  if (fromEnv) return resolve(fromEnv)

  const fromManifest = readManifestProxyRoot(join(hubRoot, SUITE_MANIFEST))
  if (fromManifest) return fromManifest

  // 兜底：hub 的上一级。平级布局（搬迁前）与嵌套布局（搬迁后）都能命中，
  // 因为两种布局下代理目录名都没变。
  return resolve(hubRoot, '..')
}

/** 某个仓（代理或面板自己）的绝对目录。`dirName === '.'` 表示 hub 自己。 */
export function suiteDir(dirName: string, proxyRoot: string, hubRoot: string): string {
  return dirName === '.' ? hubRoot : join(proxyRoot, dirName)
}
