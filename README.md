# agent-hub

本机三个 AI 平台本地代理（[workbuddy-proxy](https://github.com/weixiaokuan123/workbuddy-proxy)、[trae-proxy](https://github.com/weixiaokuan123/trae-proxy)、[minimax-proxy](https://github.com/weixiaokuan123/minimax-proxy)）的**统一可视化面板**。

零依赖：纯 `node:http` + 单页原生 HTML/JS，无框架、无构建、无 `npm install`。启动后浏览器打开即用。

## 导览

> 这一节写给「懂技术、但没接触过这套东西」的人。读完这一节就能明白整套东西在干什么。
> 下面原有的技术文档内容一字未改，只是不再需要从头读起。

### 这套东西在解决什么问题

三家 AI 桌面端（WorkBuddy、Trae、MiniMax Code）都只给你一个**图形界面**，没有给命令行或第三方工具用的接口。
而 opencode 这类工具需要 HTTP API 才能调用模型。同时这些桌面端把登录凭据**加密**存在本地、且通信协议是私有的。

所以这套东西共 4 个仓库，做同一件事的四个层次：

```
桌面端（加密凭据 + 私有协议）
   │  各平台一个代理负责「解密 + 转成标准 API + 每天顺手领积分」
   ▼
opencode  ←── agent-hub（一个网页，把三个代理的状态汇总成一张面板）
```

一句话：**让你已经付费登录的桌面端账号，能在 opencode 里当 API 用，并顺手把每日积分领了。**

| 仓库 | 干什么 | 端口 |
| --- | --- | --- |
| `workbuddy-proxy` | WorkBuddy 国内版 / 国际版 | 39301 / 39302 |
| `trae-proxy` | Trae 国内版 / 国际版 | 39303 / 39304 |
| `minimax-proxy` | MiniMax Code 国内版 / 国际版 | 39305 / 39306 |
| `agent-hub`（本仓库） | 汇总面板，看状态 / 手动签到 / 派遣旅行 | 39310 |

每个平台分「国内版 / 国际版」是因为它们是两套独立的账号体系，登录态不通用。

### 面板的四个页签

- **总览** —— 一屏回答两个问题：「一切正常吗」和「现在该我处理什么」。只有**今天需要你动手**的事才会进「需要处理」。
- **账号** —— 每个平台的登录状态、可用模型数、今日签到明细、旅行派遣开关。
- **积分** —— WorkBuddy 按区域分组列出每个账号的余额，并**按到期日聚合**标出积分包（每个账号最多 5 个最近到期的日期组，其余折叠成「另有 N 组」；月度包单列，因为它是刷新不是到期）。Trae 显示国内版的额度用量（已用 / 总额 + 进度条）。
- **服务** —— 六个端口是否在监听、各仓库本地版本与最新版本对比。

> 下文「接口」一节列的是后端 HTTP 接口，不是面板页签；面板的实际功能以本节为准。

### 术语速查

| 词 | 意思 |
| --- | --- |
| **回环 / loopback** | 只监听 `127.0.0.1`，只有本机能访问，局域网和公网都连不上 |
| **bearer key** | 每个代理首次启动时随机生成的一把钥匙，调用时必须带上。防止本机其它程序误用你的账号 |
| **幂等** | 同一操作做多次和做一次结果相同。比如签到：今天已领就自动跳过，不会重复领 |
| **池化 / 切换池** | 账号库里放多个号，某个号触发了限额就自动换一个继续，不中断你的对话 |
| **透传** | 不改内容，原样转发 |
| **签到** | 每天登录平台领一次积分，各代理在随机时刻自动做 |
| **旅行派遣** | WorkBuddy 的「派猫猫旅行」活动：派出换积分，到点自动领。**每个账号每天只能派一次**（服务端硬限制） |

### 最短上手路径

```powershell
# 1. 三个平台代理各自 clone 到 ~/.config/opencode 下并启动（见各自 README）
# 2. 启动本面板
cd "$env:USERPROFILE\.config\opencode\agent-hub"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

启动脚本会打印一个带 key 的本机地址，浏览器打开即用。首次访问后 key 存入浏览器，之后直接访问 `http://127.0.0.1:39310/` 即可。

---

## 它做什么

- **账号总览**：每个平台/区域的登录账号、登录状态、模型数、代理端口运行状态
- **签到面板**：今天签没签、连签天数、今日积分、今天的随机计划时刻、最近一次结果
- **一键签到**：单个平台「立即签到」或顶部「全部签到」（幂等，已签的自动跳过）
- 每 15 分钟自动刷新（标签页隐藏时暂停，切回时立即刷新一次）

**它不接触任何凭据**——只通过各代理已有的回环 HTTP 接口聚合数据。

## 前置条件

先安装并启动三个代理（没装的平台会显示「服务未运行」，不影响其他）：

| 平台 | 端口 |
| --- | --- |
| workbuddy-proxy | 39301（cn）/ 39302（global）|
| trae-proxy | 39303（cn）/ 39304（ai）|
| minimax-proxy | 39305（cn）/ 39306（en）|

## 安装与启动

```powershell
git clone https://github.com/weixiaokuan123/agent-hub.git "$env:USERPROFILE\.config\opencode\agent-hub"
cd "$env:USERPROFILE\.config\opencode\agent-hub"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

启动后会打印带 key 的地址，形如：

```
http://127.0.0.1:39310/?key=<你的hub-key>
```

首次访问会自动把 key 存进浏览器 localStorage，之后直接访问 `http://127.0.0.1:39310/` 即可。

## 安全模型

- 仅监听 `127.0.0.1`，回环 Host/Origin 校验
- 面板自身用固定 bearer（`keys/hub.key`，首次启动生成）；对代理的请求注入各自的 `keys/*.key`
- 只代理 `GET /status`、`GET /signin/status`、`POST /signin/claim` 三个只读/幂等接口
- `keys/`、`logs/`、`state/` 已在 `.gitignore` 排除，仓库不含任何凭据

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | 三平台账号/模型/签到汇总 |
| GET | `/api/services` | 各代理端口监听状态 |
| POST | `/api/signin/claim` | 指定平台立即签到（body `{"id":"trae-cn"}`）|
| GET | `/api/update/check` | 只检查各代理是否有新版（不拉取）|
| POST | `/api/update/apply` | 检查并快进拉取各代理新版（更新后需重启代理生效）|

## 自动更新

agent-hub 会**代为检查并快进更新**四个仓库——三个代理（workbuddy-proxy / trae-proxy /
minimax-proxy）**以及它自己**：

- 启动后在约 7.5 分钟的窗口内退避重试（0/30/90/210/450 秒），之后每 24 小时检查一次
- 判定依据：各代理 `/healthz` 返回的 `version`（agent-hub 自身则读本地常量）↔ 对应
  GitHub 仓库的**最新 tag**（如 `v1.2.1`）
- 有新版本时执行 `git fetch` + `git merge --ff-only`；本地有未提交改动会跳过，不覆盖任何东西
- 更新后**不自动重启进程**（避免打断正在进行的对话），只写 `state/update-pending.json` 标记
- 面板「服务」页有「检测更新 / 立即更新」按钮，可以不等那 24 小时
- 用 `OPCODE_NO_AUTO_UPDATE=1` 可完全关闭

### 让更新生效：代理一键，面板要手动

| | 怎么生效 |
| --- | --- |
| 三个代理 | 面板「服务」页点「**重启 3 个代理**」（会中断进行中的模型请求，对话记录不丢）。不想开面板就跑 `scripts\restart-proxies.ps1` |
| **agent-hub 自己** | **只能手动重启**——处理请求的进程一死就没法回响应，而分离脚本延迟重启会让面板整个挂掉、失败时无从察觉：<br>`cd "$env:USERPROFILE\.config\opencode\agent-hub"`<br>`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop.ps1`<br>`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1` |

> 代理更新后**磁盘上的代码是新的、跑着的进程还是旧的**，所以「已更新」不等于「已生效」，
> 必须重启。面板会把这条显示在「服务」页的「待重启」里，并且会自动识别哪些仓真的还没重启
> （代理重启后旧标记会消失，不会一直挂着"待重启"骗人）。
>
> ⚠️ 更新检测**只认 tag**，不认普通 commit。改了代码但没打新 tag，其他机器不会自动跟进。

### 发版流程（每次都做，否则自动更新形同虚设）

在**有改动的仓库**里：

```powershell
# 1. 递增版本号
#    编辑 src/version.ts，把 '1.2.1' 改成 '1.2.2'
#    规则：**每次发版只递增 PATCH（最后一位 +1）**，例如 1.2.1 → 1.2.2。
#    不发 MINOR / MAJOR，避免版本跳跃导致其他机器的自动更新比对混乱。

# 2. 提交
git add src/version.ts
git commit -m "chore: 版本 1.2.1 → 1.2.2"

# 3. 打带注释的 tag（必须是 vMAJOR.MINOR.PATCH 格式）
git tag -a v1.2.2 -m "v1.2.2: 本次更新说明"

# 4. 推送 commit 与 tag
git push origin main
git push origin v1.2.2
```

打完 tag 后，其他机器上的 agent-hub 会在 24 小时内（或重启后 30 秒）自动拉取。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_HUB_PORT` | `39310` | 面板端口 |
| `OPCODE_NO_AUTO_UPDATE` | 未设置 | 设为任意非空值可关闭自动更新 |

## 自动签到说明

自动签到由**各代理自身**完成（每天本地 07:00–10:00 随机时刻，见各代理 README），本面板只是查看与手动触发的入口。可在各代理用 `*_SIGNIN=off` 关闭自动签到。

## 许可

MIT。
