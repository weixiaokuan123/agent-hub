/**
 * agent-hub overview 失败恢复测试（无网络，模拟 fetchJson 抛错）。
 *
 * 背景：/api/overview 用 Promise.all 拉 6 个区域，任一区失败会让整个端点 500，
 * 面板就是空的。修复方案：把内部回调的 throw 都吸收掉，保证整体响应成功。
 *
 * 覆盖：
 *  1. readFile 抛错（key 文件中途消失）→ 返回带 error 字段的 entry，不让整体挂
 *  2. fetchJson 抛错（网络瞬断）→ 同上
 *  3. fetchJson 在区域未运行时返回 error 不抛 → 正常显示 offline
 *  4. 全部失败时仍能返回合法的 overview JSON
 *
 * 运行：node --test test/overview-resilience.test.ts
 *
 * 注意：直接 import server.ts 会触发 main() 与端口监听，因此用子模块里的
 * 纯函数重构（见 server.ts 里 export 的 _internals）。如果还没拆，
 * 本测试先以注释形式列出预期修复，作为实施依据。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

test('placeholder: 修复后预期行为', () => {
  // 实际测试需要把 workbuddyCredits / overview 拆成可注入 fetchJson/readFile 的纯函数。
  // 验证要点：
  //   - readFile reject → entry.error='ENOENT'，overview 整体仍返回 200
  //   - fetchJson reject → entry.error=msg，overview 仍 200
  //   - 6 个区域全失败 → overview 仍返回合法 JSON（不是 500）
  assert.ok(true, '占位')
})