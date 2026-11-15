https://ling7love67.github.io/web-phase4lijinyang2/
# 前端实训：个人主页 + 项目列表 + AI 流式对话
原生 HTML5 / CSS3 / JavaScript 写页面，Node.js + Express 写接口，数据存 JSON 文件。
没有框架、没有构建步骤，`npm install && npm start` 就能跑。
## 项目简介
**解决的问题**：把「个人主页 / 我的项目 / AI 助手」做成一个**能真正跑起来的站点**，而不是三个互不相干的静态页。
页面上的数据不写死，全部走自己写的 Express 接口，落到 `data/projects.json`；
AI 也不只是聊天，它能通过工具调用直接读写这份数据。
**四者是怎么打通的**（任务 6 的要求）：
| 环节 | 具体实现 | 对应文件 |
| --- | --- | --- |
| 一个页面 | 列表页：查询 / 新增 / 删除，带「加载中 / 空数据 / 请求失败」三态 | `list.html` + `js/list.js` |
| 一套接口 | 统一 `{code,data,msg}`，参数校验失败返回 400，全局异常也返回 JSON | `server.js` |
| 一个数据库 | 本地 JSON 文件，先写临时文件再 `rename`，重启不丢 | `data/projects.json` |
| 一个 AI 能力 | 火山方舟流式对话 + 工具调用（`add_item` / `query_items`） | `POST /api/chat` |
**串起来是什么样**：在对话页说「帮我加一个明天交实验报告的项目」→ 模型返回 `tool_call` →
服务端执行 `toolAddItem` 真的写进 JSON → 回到列表页刷新，新项目就在里面。
反过来，在列表页手动加的记录，问 AI「有哪些项目」时它也能查到 —— 两个方向都是通的。
## 技术栈
| 层 | 选型 | 为什么这么选 |
| --- | --- | --- |
| 页面 | 原生 HTML5 + CSS3 + JavaScript | 这一阶段练的是基本功：语义化结构、响应式布局、fetch 与状态管理，上框架会把它们遮住 |
| 后端 | Node.js 18+ + Express 4 | 起接口十几行就够，中间件生态够用；前后端同一门语言，不用来回切 |
| 存储 | 本地 JSON 文件 | 数据量几十条，一个文件就是一个库，`Get-Content` 就能看内容，排查最快 |
| 通信 | `fetch` + JSON；AI 回答用 SSE | 普通接口用 JSON；AI 必须逐块推送，才能做到「边生成边显示」 |
| AI | 火山方舟 `doubao-seed-evolving` | 支持流式输出和工具调用；Key 只放服务端 `.env`，前端拿不到 |
| 依赖 | `express`、`cors` | 只有两个生产依赖，`npm install` 一分钟内装完 |
## 功能截图
| 截图 | 说明 |
| --- | --- |
| ![首页](screenshots/home.png) | 首页：自我介绍 / 技能栈 / 第一阶段项目三个 Tab |
| ![首页项目](screenshots/home-project.png) | 首页项目卡片区 |
| ![列表页](screenshots/list.png) | 列表页：查询 + 新增 + 删除，数据来自 `GET /api/list` |
| ![空数据](screenshots/state-empty.png) | 空数据状态 |
| ![加载中](screenshots/state-loading.png) | 加载中骨架屏（用 `DEBUG_DELAY_MS` 模拟慢请求截的） |
| ![详情页](screenshots/detail.png) | 详情页：任务清单，勾选状态存 localStorage |
| ![移动端](screenshots/mobile-list.png) | 375px 宽度下的列表页 |
| ![跨域失败](screenshots/cors-before.png) | 跨域失败时的控制台报错（修复前） |
| ![跨域成功](screenshots/cors-after.png) | 修复后的正常请求（修复后） |
> AI 对话页截图补充为 `screenshots/chat.png`；工具调用日志的完整调用链见「任务 5」一节。
## 一、快速开始
```bash
@@ -16,6 +61,31 @@
浏览器打开 <http://127.0.0.1:3001/list.html>（首页是 `/`，项目详情是 `/detail.html`，
AI 对话页是 `/chat.html`）。
### 环境变量示例
服务端只读项目根目录的 `.env`。`.env` 已被 `.gitignore` 忽略，仓库里只提交不含 Key 的 `.env.example`：
```ini
# 复制 .env.example 为 .env，再把 ARK_API_KEY 填成你自己的
ARK_API_KEY=你的火山方舟APIKey
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=doubao-seed-evolving
```
| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ARK_API_KEY` | AI 对话必填 | 无 | 火山方舟 Key，只在服务端使用 |
| `ARK_BASE_URL` | 否 | `https://ark.cn-beijing.volces.com/api/v3` | 模型服务地址 |
| `ARK_MODEL` / `MODEL_ID` | 否 | `doubao-seed-evolving` | 模型 ID，以控制台「快速接入」为准 |
| `ARK_MAX_TOKENS` | 否 | `1200` | 单次回答 token 上限 |
| `CHAT_TIMEOUT_MS` | 否 | `120000` | 等待模型的超时时间 |
| `CHAT_MAX_MESSAGES` / `CHAT_MAX_CHARS` | 否 | `8` / `6000` | 上下文裁剪上限 |
| `MAX_TOOL_ROUNDS` | 否 | `4` | 最多连续调用几轮工具 |
| `PORT` / `HOST` | 否 | `3001` / `127.0.0.1` | 部署平台会自动注入 |
| `DATA_FILE` | 否 | `data/projects.json` | 换数据文件路径，做实验用 |
| `DEBUG_DELAY_MS` | 否 | `0` | 让 `/api/list` 延迟，用来演示「加载中」 |
| `ALLOW_ORIGINS` | 否 | `*` | 跨域白名单，逗号分隔 |
> 端口默认 **3001**，`js/config.js` 里的 `LOCAL_API_BASE` 也是 3001，两边要一致。
> 端口被占用时终端会提示，换端口后记得同步改 `js/config.js`。
> 改过 `.env` 后必须重启 Node，旧进程不会自动读取新 Key。
@@ -371,6 +441,46 @@
> 注意：工具执行是真实的 `data/projects.json` 写入。停止生成只会停止后续模型回答，
> **不会回滚已经成功执行的数据库操作**；工具日志里的「成功」就是实际写入结果。
## 十一、已知问题
按影响从大到小排，每条写清「现象 / 原因 / 现在怎么处理」：
| # | 问题 | 现象 | 原因 | 现在的处理 |
| --- | --- | --- | --- | --- |
| 1 | JSON 文件不适合并发写 | 两个人同时新增，可能丢一条 | 每次增删都是「读全量 → 改 → 整体重写」，没有锁 | 单机单人够用；要并发就得换 SQLite 或加文件锁 |
| 2 | 没有登录鉴权 | 任何能访问 3001 的人都能增删数据 | 作业范围内不做用户体系 | 只在本机/内网用，别长期暴露公网 |
| 3 | 没有分页和排序 | 数据一多，列表一次全返回 | `/api/list` 直接返回整个数组 | 几十条无感；上百条再加 `page/pageSize` |
| 4 | 没有 PUT 修改接口 | 改一条只能先删再重加 | 任务书里 PUT 是加分项，时间优先给了工具调用 | 前端没做编辑入口 |
| 5 | AI 依赖外部服务 | Key 失效、欠费、限流时对话不可用 | 模型是外部依赖 | 上游错误已映射成中文提示（`AUTH`/`BALANCE`/`RATE_LIMIT`…），但功能仍不可用 |
| 6 | 没有自动化测试框架 | 改完代码要手动跑断言 | 没引入 Jest/Vitest | 有 `tests/api-test.ps1`，14 个用例覆盖主要路径 |
| 7 | 单进程、无守护 | 进程挂了不会自动拉起 | 没上 PM2 / 容器 | 本地开发够用 |
| 8 | 静态资源没有版本指纹 | 改了 CSS，用户可能还看旧样式 | 浏览器缓存 | 强制刷新 `Ctrl + F5` |
| 9 | 数据文件必须是 UTF-8 | 用记事本另存成 ANSI 会乱码 | 服务按 `utf8` 读写 | 文档里已标注编码要求 |
| 10 | PowerShell 5.1 的 curl 引号坑 | `-d '{"a":"b"}'` 会变成坏 JSON | PS 5.1 传参给 exe 时会吃掉双引号 | 文档给了两种可靠写法；也可以 `-d "{}"` 或直接用 Postman |
**最容易坏的地方**（答辩第三问可以直接用这个答案）：**AI 工具调用这条链最脆**。
模型 → 参数 JSON → 执行器 → 数据文件，四个环节任何一处字段名对不上，就会「接口 200 但数据没变」地静默失败。
我实际踩过：schema 写的是 `item_name`，执行器读的是 `title`，模型完全按 schema 传，结果参数校验失败。
发现方式是把工具日志（`add_item ok`）和 `data/projects.json` 的内容对照——日志说成功、文件没变，就说明链路中间断了。
完整记录见 [docs/tool-calling-failure.md](docs/tool-calling-failure.md)。
第二容易坏的是**端口占用**：上一轮的 node 进程没退干净，`npm start` 直接 `EADDRINUSE`，
看起来像「代码跑不起来」，其实是老进程还占着 3001。
## 十二、任务 6 交付清单
| 要求 | 在哪 |
| --- | --- |
| 项目简介（解决什么问题） | 本文「项目简介」 |
| 技术栈 | 本文「技术栈」 |
| 本地运行步骤 + 环境变量示例 | 本文「一、快速开始」 |
| 功能截图 | 本文「功能截图」 |
| 已知问题 | 本文「十一、已知问题」 |
| 目录结构 | 本文「二、目录结构」 |
| 接口文档表 | [docs/接口文档.md](docs/接口文档.md) |
| 测试与启动说明 | [docs/测试与启动说明.md](docs/测试与启动说明.md) |
| 演示与答辩准备 | [docs/答辩与演示准备.md](docs/答辩与演示准备.md) |
---
2026 前端实训作业
