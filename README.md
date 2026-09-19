# agent-hub

本机三个 AI 平台本地代理（[workbuddy-proxy](https://github.com/weixiaokuan123/workbuddy-proxy)、[trae-proxy](https://github.com/weixiaokuan123/trae-proxy)、[minimax-proxy](https://github.com/weixiaokuan123/minimax-proxy)）的**统一可视化面板**。

零依赖：纯 `node:http` + 单页原生 HTML/JS，无框架、无构建、无 `npm install`。启动后浏览器打开即用。

## 它做什么

- **账号总览**：每个平台/区域的登录账号、登录状态、模型数、代理端口运行状态
- **签到面板**：今天签没签、连签天数、今日积分、今天的随机计划时刻、最近一次结果
- **一键签到**：单个平台「立即签到」或顶部「全部签到」（幂等，已签的自动跳过）
- 每 60 秒自动刷新

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

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENT_HUB_PORT` | `39310` | 面板端口 |

## 自动签到说明

自动签到由**各代理自身**完成（每天本地 07:00–10:00 随机时刻，见各代理 README），本面板只是查看与手动触发的入口。可在各代理用 `*_SIGNIN=off` 关闭自动签到。

## 许可

MIT。
