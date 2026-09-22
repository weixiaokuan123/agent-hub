# Agent-Hub 安装时联动方案

**日期**：2026-09-17
**状态**：待评审
**范围**：仅在安装时（install-time）联动，运行时不改变代理启动/停止行为

## 背景

目前 `agent-hub` 没有自己的 install 流程。其他三个 proxy（workbuddy-proxy / trae-proxy / minimax-proxy）各自有 `install.ps1` / `install-autostart.ps1`。用户在新机器上要手动按 README 跑四遍克隆。

`agent-hub/src/server.ts` 通过相对路径 `../workbuddy-proxy/keys/...` 读兄弟仓库的 key 文件，因此兄弟仓库必须与 `agent-hub` 同级放在 `~/.config/opencode/` 下——这是当前架构强约束。

## 目标

提供 `agent-hub/install.cmd`（双击入口）和 `agent-hub/scripts/install.ps1`，让用户在新机器上一次问完：
- 是否克隆 workbuddy-proxy？
- 是否克隆 trae-proxy？
- 是否克隆 minimax-proxy？

按回答把对应仓库 clone 到 `agent-hub` 同级目录，**仅 clone，不调用任何 proxy 自己的 install.ps1**（避免修改全局 `opencode.jsonc`）。完成后打印每个 proxy 接下来的登录/启动步骤指引。

## 非目标

- 不接管代理的运行时启停：各 proxy 的 `start.ps1` / `stop.ps1` 仍独立运行
- 不修改代理仓库本身；只在 agent-hub 仓库新增脚本和文档
- 不做卸载/清理脚本（YAGNI）
- 不提供 `irm | iex` 一次性安装（先做本地脚本，未来按需扩展）

## 架构

```
~/.config/opencode/
├── agent-hub/                    ← 用户已 clone 或刚 clone
│   ├── install.cmd               ← 新增：双击入口
│   └── scripts/
│       └── install.ps1           ← 新增：PowerShell 主体
├── workbuddy-proxy/              ← 若用户选择克隆，落到这里
├── trae-proxy/                   ← 若用户选择克隆，落到这里
└── minimax-proxy/                ← 若用户选择克隆，落到这里
```

每个 proxy 仓库 `keys/`、`logs/`、`state/` 已在各自 `.gitignore` 里排除，agent-hub 的 install 脚本**不需要**额外处理。

## 组件

### `install.cmd`（双击入口）

Windows 批处理，调起 `install.ps1`。负责：
1. 设置 UTF-8 代码页（`chcp 65001`）以正确显示中文提示
2. 调用 `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"`
3. 退出前 `pause` 以便用户看输出

### `scripts/install.ps1`

主体脚本，参数 `[switch]$WhatIf`。职责：

1. **前置检查**
   - `git --version` 缺失则报错并退出
   - 确认当前脚本所在目录是 `agent-hub`（含 `src\server.ts`），否则退出
2. **交互询问**（PowerShell `Read-Host`，逐项 `[Y/n]`，默认 Y）
   - "是否克隆 workbuddy-proxy? (Y/n)"
   - "是否克隆 trae-proxy? (Y/n)"
   - "是否克隆 minimax-proxy? (Y/n)"
3. **克隆**：对每个被选中的 proxy：
   - 目标路径 = `$PSScriptRoot\..\..\<proxy-name>`（即 `agent-hub` 同级）
   - 若目标已存在：询问 `(R)einstall / (S)kip / (A)bort`，**回车默认 Skip**
   - Reinstall → 删除目录后 `git clone https://github.com/weixiaokuan123/<proxy>.git <目标>`
   - Skip → 打印 "已存在，跳过"
   - Abort → 立即退出整个脚本，不再继续后面的 proxy
   - 任一 `git clone` 失败：打印 stderr，继续下一个（不中断整批）
4. **结果汇总**：打印每个 proxy 的最终状态（新增 / 跳过 / 失败）
5. **下一步指引**：按克隆/跳过的项目，列出每个 proxy 的"打开 `..\<proxy>\README.md`，按其中的 '安装与启动' 步骤操作"。

### `-WhatIf` 模式

不执行任何 `git clone`，只打印计划（用于测试或预览）。也用于人工复检脚本的逻辑。

## 数据流

1. 用户双击 `install.cmd` → cmd → PowerShell `-File install.ps1`
2. PowerShell 在 agent-hub 仓库目录下启动
3. 脚本依次问 3 个问题
4. 对每个被选中的 proxy，决定 clone / skip
5. 调 `git clone`（或 WhatIf 时打印计划）
6. 打印汇总和后续步骤

## 错误处理

| 情形 | 处理 |
| --- | --- |
| 缺 `git` | 报错并退出 1 |
| 不在 agent-hub 目录 | 报错并退出 1 |
| 目标目录已存在 | 询问 R/S/A |
| `git clone` 失败（非 0） | 打印 stderr，继续下一个 |
| 用户 Ctrl+C | `Read-Host` 抛异常时退出（PowerShell 默认会终止）|
| 代理仓库 URL 改了 | 改脚本顶部 `PROXIES` 数组（`name + url`）即可 |

## 安全/隐私

- 脚本不写任何凭据
- `.gitignore` 不动（每个 repo 已有）
- 不会自动调用各 proxy 的 `install.ps1`，避免修改全局 `opencode.jsonc`
- 唯一外部 URL：`https://github.com/weixiaokuan123/<proxy>.git`，写明无遮蔽（公开仓库）

## 测试

### 手动测试

- 全新目录（无 `workbuddy-proxy` 等）：选 Y/Y/Y，验证三个仓库被 clone 到正确位置
- 已有其中一个：选 Y/Y/Y，验证已存在的被问 R/S/A，回答 Skip 后脚本继续
- WhatIf：不实际 clone，只打印计划

### Dry-run 自动化

用 `install.ps1 -WhatIf`，脚本无副作用：
```
PS> .\scripts\install.ps1 -WhatIf
[Plan] workbuddy-proxy: git clone ...\workbuddy-proxy.git ..\workbuddy-proxy
[Plan] trae-proxy: skip (已存在)
[Plan] minimax-proxy: git clone ...\minimax-proxy.git ..\minimax-proxy
```

### 隐私扫描

提交前扫描 `install.cmd` / `install.ps1`：
- 不含账号、邮箱、token、本地路径
- 不含任何具体 token/key 字符串

## 文件清单

新增（都在 agent-hub 仓库）：
- `install.cmd`
- `scripts/install.ps1`
- `docs/superpowers/specs/2026-09-17-agent-hub-install-with-proxy-linkage-design.md`（本文件）

修改：
- `README.md`：在"安装与启动"段落增加"在新机器上推荐先跑 install.cmd"的指引