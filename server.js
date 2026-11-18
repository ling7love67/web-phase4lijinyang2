/**
 * 项目列表后端：Node.js + Express
 *
 * 接口
 *   GET    /api/health            健康检查（部署后先访问它）
 *   GET    /api/list              查询列表
 *   POST   /api/add               { title, desc } 新增
 *   DELETE /api/del?id=xxx        删除
 *   POST   /api/chat              { messages } AI 流式对话（SSE）
 *
 * 关键点
 *   - 跨域在服务端用 CORS 响应头解决，前端不做任何代理、不改浏览器安全策略
 *   - 数据落到 data/projects.json，重启服务、刷新页面都不会丢
 *   - 写文件先写临时文件再 rename，避免写到一半把数据写坏
 *   - API Key 只放在服务端 .env，/api/chat 负责转发和裁剪上下文
 *   - /api/chat 支持 add_item / query_items 工具，执行结果会回填给模型
 *
 * 启动
 *   npm install
 *   npm start                      默认 http://127.0.0.1:3001
 *   DEBUG_DELAY_MS=3000 npm start  让列表接口慢 3 秒，方便截「加载中」状态
 */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ---------- 环境变量 ----------
// 只读项目根目录的 .env；不把 Key 写进代码，也不发给前端。
// 部署平台注入的环境变量优先于 .env，方便线上直接配置。
(function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) return;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 系统环境变量优先，避免 .env 覆盖部署平台配置
    if (process.env[key] === undefined) process.env[key] = value;
  });
})(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3001;
// 本地默认只监听 127.0.0.1；部署到 Render / Railway 这类平台时用 HOST=0.0.0.0
const HOST = process.env.HOST || "127.0.0.1";
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "data", "projects.json");
const DEBUG_DELAY_MS = Math.max(0, Number(process.env.DEBUG_DELAY_MS) || 0);

// ---------- AI 对话配置 ----------
const ARK_API_KEY = String(process.env.ARK_API_KEY || "").trim();
const ARK_BASE_URL = String(
  process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"
).replace(/\/+$/, "");
// 以火山方舟控制台「模型广场 / 快速接入」里的模型 ID 为准
// 也兼容控制台示例里常见的 MODEL_ID 写法
const ARK_MODEL = String(
  process.env.ARK_MODEL || process.env.MODEL_ID || "doubao-seed-evolving"
).trim();
const ARK_MAX_TOKENS = envInt("ARK_MAX_TOKENS", 1200, 200, 4096);
const CHAT_TIMEOUT_MS = envInt("CHAT_TIMEOUT_MS", 120000, 5000, 180000);
const CHAT_MAX_MESSAGES = envInt("CHAT_MAX_MESSAGES", 8, 2, 20);
const CHAT_MAX_CHARS = envInt("CHAT_MAX_CHARS", 6000, 1000, 20000);

const CHAT_SYSTEM_PROMPT = String(
  process.env.CHAT_SYSTEM_PROMPT ||
    [
      "你是「小豆」，一个面向前端初学者的学习助手。",
      "你帮助用户理解 HTML、CSS、JavaScript、Node.js/Express 和前后端联调，默认用中文回答。",
      "回答要具体、可操作：先给结论，再给步骤或最小可运行代码，最后给一句验收或排错提示。",
      "边界：",
      "1. 不编造事实、API、运行结果或链接；不确定时明确说明，并给出验证方法。",
      "2. 不索要、不复述、不输出任何 API Key、密码、身份证号等敏感信息；涉及密钥时只给环境变量写法。",
      "3. 不声称能直接访问用户的电脑、浏览器、账号或线上系统，也不做越权操作。",
      "4. 不提供违法、有害或侵犯他人隐私的内容。",
      "5. 问题超出前端/编程学习范围时，简短说明后把话题拉回你能提供的帮助。",
      "6. 当用户要求新增项目/任务，或查询项目清单时，必须调用提供的工具；工具执行结果才是事实，不要只口头答应，也不要编造工具结果。",
      "7. 工具执行失败时，把错误用自然语言告诉用户，并给出下一步建议。",
      "默认简洁；用户要求展开时再详细解释。"
    ].join("\n")
).trim();

const MAX_TOOL_ROUNDS = envInt("MAX_TOOL_ROUNDS", 4, 1, 8);

// 交给模型的工具定义：只暴露业务能力，不暴露文件路径和内部函数
const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "add_item",
      description:
        "向项目清单新增一条记录。用户明确要求新增、添加、记录一个项目/任务/待办时调用。" +
        "title 必填，desc 可选；不要代替用户编造没有说过的内容。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "条目标题，例如「明天交实验报告」，最多 60 字"
          },
          desc: {
            type: "string",
            description: "可选描述，最多 200 字"
          }
        },
        required: ["title"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_items",
      description:
        "查询项目清单。用户问有哪些项目、有没有某个项目、按关键词查找项目时调用。" +
        "不传 keyword 时返回全部；返回结果包含 total 和 items。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "可选关键词，匹配项目标题或描述"
          },
          limit: {
            type: "integer",
            description: "最多返回几条，1-20，默认 10",
            minimum: 1,
            maximum: 20
          }
        },
        additionalProperties: false
      }
    }
  }
];

function envInt(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

// 默认允许所有来源；部署后想收紧就设 ALLOW_ORIGINS=https://a.com,https://b.com
const allowOrigins = (process.env.ALLOW_ORIGINS || "*")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");

// ---------- 中间件 ----------

app.use(
  cors({
    // "*" 时反射请求的 Origin 并带上 Vary: Origin，本地 file:// 和线上域名都能调
    origin: allowOrigins.includes("*") ? true : allowOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 86400
  })
);
app.use(express.json({ limit: "1mb" }));

// ---------- 数据读写 ----------

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    writeList([]);
  }
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  // 兼容早期只写了 name 的旧数据
  const title = typeof item.title === "string" ? item.title : item.name;
  if (typeof title !== "string" || !title.trim()) return null;
  return {
    id: item.id != null ? item.id : Date.now(),
    title: title.trim(),
    desc: typeof item.desc === "string" ? item.desc : "",
    createdAt: item.createdAt || null
  };
}

function readList() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, "utf8").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("data/projects.json 的内容必须是数组");
  }
  return parsed.map(normalizeItem).filter(Boolean);
}

function writeList(list) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, DATA_FILE);
}

function fail(res, status, msg) {
  return res.status(status).json({ code: status, data: null, msg });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 工具调用：真正的数据操作在这里执行 ----------

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, args: {} };
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "工具参数必须是 JSON 对象" };
    }
    return { ok: true, args: parsed };
  } catch (err) {
    return { ok: false, error: "工具参数不是合法 JSON：" + err.message };
  }
}

function toolAddItem(args) {
  if (typeof args.title !== "string") {
    return { ok: false, tool: "add_item", error: "title 必须是字符串", summary: "参数校验失败：title 必须是字符串" };
  }
  if (args.desc !== undefined && typeof args.desc !== "string") {
    return { ok: false, tool: "add_item", error: "desc 必须是字符串", summary: "参数校验失败：desc 必须是字符串" };
  }

  const title = args.title.trim();
  const desc = typeof args.desc === "string" ? args.desc.trim() : "";
  if (!title) {
    return { ok: false, tool: "add_item", error: "title 不能为空", summary: "参数校验失败：title 不能为空" };
  }
  if (title.length > 60) {
    return { ok: false, tool: "add_item", error: "title 最多 60 个字", summary: "参数校验失败：title 最多 60 个字" };
  }
  if (desc.length > 200) {
    return { ok: false, tool: "add_item", error: "desc 最多 200 个字", summary: "参数校验失败：desc 最多 200 个字" };
  }

  const list = readList();
  let id = Date.now();
  while (list.some((item) => String(item.id) === String(id))) id += 1;

  const item = { id, title, desc, createdAt: new Date().toISOString() };
  list.push(item);
  writeList(list);

  return {
    ok: true,
    tool: "add_item",
    item,
    count: list.length,
    summary: "已新增「" + title + "」，当前共 " + list.length + " 条项目"
  };
}

function toolQueryItems(args) {
  if (args.keyword !== undefined && typeof args.keyword !== "string") {
    return { ok: false, tool: "query_items", error: "keyword 必须是字符串", summary: "参数校验失败：keyword 必须是字符串" };
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20)) {
    return { ok: false, tool: "query_items", error: "limit 必须是 1-20 的整数", summary: "参数校验失败：limit 必须是 1-20 的整数" };
  }

  const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
  const limit = args.limit === undefined ? 10 : args.limit;
  const list = readList();
  const matched = keyword
    ? list.filter((item) =>
        (item.title + " " + item.desc).toLowerCase().includes(keyword.toLowerCase())
      )
    : list;
  const items = matched.slice(0, limit).map((item) => ({
    id: item.id,
    title: item.title,
    desc: item.desc,
    createdAt: item.createdAt
  }));

  return {
    ok: true,
    tool: "query_items",
    keyword,
    total: matched.length,
    returned: items.length,
    items,
    summary:
      "查询完成：匹配 " +
      matched.length +
      " 条，返回 " +
      items.length +
      " 条" +
      (keyword ? "（关键词「" + keyword + "」）" : "")
  };
}

function executeToolCall(name, rawArguments) {
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) {
    return {
      ok: false,
      tool: name,
      error: parsed.error,
      summary: "工具参数解析失败：" + parsed.error
    };
  }

  try {
    if (name === "add_item") return toolAddItem(parsed.args);
    if (name === "query_items") return toolQueryItems(parsed.args);
    return {
      ok: false,
      tool: name,
      error: "未知工具：" + name,
      summary: "工具不存在：" + name
    };
  } catch (err) {
    console.error("[tool] 执行失败", name, err);
    return {
      ok: false,
      tool: name,
      error: "数据操作失败，请检查 data/projects.json 的格式",
      summary: "数据操作失败，请检查 data/projects.json 的格式"
    };
  }
}

// ---------- 接口 ----------

app.get("/api/health", (req, res) => {
  res.json({
    code: 200,
    data: { status: "up", time: new Date().toISOString() },
    msg: "ok"
  });
});

// 查询列表：支持 DEBUG_DELAY_MS 模拟慢请求，用来演示「加载中」
app.get("/api/list", async (req, res) => {
  try {
    if (DEBUG_DELAY_MS) await wait(DEBUG_DELAY_MS);
    res.json({ code: 200, data: readList(), msg: "查询成功" });
  } catch (err) {
    console.error("[GET /api/list]", err);
    fail(res, 500, "读取数据失败，请检查 data/projects.json 的格式");
  }
});

// 新增
app.post("/api/add", (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const desc = typeof body.desc === "string" ? body.desc.trim() : "";

    if (!title) return fail(res, 400, "title 不能为空");
    if (title.length > 60) return fail(res, 400, "title 最多 60 个字");
    if (desc.length > 200) return fail(res, 400, "desc 最多 200 个字");

    const list = readList();
    let id = Date.now();
    while (list.some((item) => String(item.id) === String(id))) id += 1;

    const item = { id, title, desc, createdAt: new Date().toISOString() };
    list.push(item);
    writeList(list);

    res.json({ code: 200, data: item, msg: "新增成功" });
  } catch (err) {
    console.error("[POST /api/add]", err);
    fail(res, 500, "新增失败");
  }
});

// 删除：优先 query，也兼容 body 传 id
app.delete("/api/del", (req, res) => {
  try {
    const rawId = req.query.id != null ? req.query.id : (req.body || {}).id;
    if (rawId === undefined || rawId === null || String(rawId).trim() === "") {
      return fail(res, 400, "id 不能为空");
    }

    const list = readList();
    const index = list.findIndex((item) => String(item.id) === String(rawId));
    if (index === -1) {
      return fail(res, 404, "项目不存在，可能已经被删掉了");
    }

    const removed = list.splice(index, 1)[0];
    writeList(list);

    res.json({ code: 200, data: removed, msg: "删除成功" });
  } catch (err) {
    console.error("[DELETE /api/del]", err);
    fail(res, 500, "删除失败");
  }
});

// ---------- AI 对话：只把「最后一条 user + 有限历史」转给模型 ----------

function normalizeChatMessages(body) {
  const raw = body && body.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "messages 必须是非空数组" };
  }

  const messages = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    // 只接受 user / assistant；客户端传 system 会被丢弃
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (typeof item.content !== "string") continue;
    const content = item.content.trim();
    if (!content) continue;
    if (item.role === "user" && content.length > 2000) {
      return { error: "单条用户消息最多 2000 字" };
    }
    // 模型回答可能比用户输入长；保留一个上限，避免单条历史把上下文撑爆
    messages.push({
      role: item.role,
      content: item.role === "assistant" ? content.slice(0, 6000) : content
    });
  }

  if (messages.length === 0) return { error: "messages 中没有有效消息" };
  if (messages[messages.length - 1].role !== "user") {
    return { error: "最后一条消息必须是 user" };
  }
  return { messages };
}

function trimChatMessages(messages) {
  let kept = messages.slice(-CHAT_MAX_MESSAGES);
  let dropped = messages.length - kept.length;

  // 截断后如果开头是 assistant，会缺少对应的用户问题，一并去掉
  while (kept.length > 0 && kept[0].role !== "user") {
    kept.shift();
    dropped += 1;
  }

  const countChars = (list) =>
    list.reduce((sum, item) => sum + item.content.length, 0);

  let chars = CHAT_SYSTEM_PROMPT.length + countChars(kept);

  // 超长就从最早的一轮开始丢，始终保留最新的 user 消息
  while (chars > CHAT_MAX_CHARS && kept.length > 1) {
    const removeCount =
      kept.length > 1 && kept[0].role === "user" && kept[1].role === "assistant"
        ? 2
        : 1;
    const removed = kept.splice(0, removeCount);
    dropped += removed.length;
    chars -= countChars(removed);

    while (kept.length > 0 && kept[0].role !== "user") {
      const orphan = kept.shift();
      dropped += 1;
      chars -= orphan.content.length;
    }
  }

  return { messages: kept, chars, dropped };
}

function describeArkError(status, payload) {
  const err = payload && typeof payload === "object" ? payload.error || payload : {};
  const code = String((err && (err.code || err.type)) || (payload && payload.code) || "");
  const rawMessage = String(
    (err && (err.message || err.msg)) || (payload && (payload.msg || payload.message)) || ""
  ).trim();
  const haystack = (code + " " + rawMessage).toLowerCase();
  const upstreamCode = code || "HTTP_" + status;

  if (status === 401 || /auth|invalid.*(api.?key|token)|api.?key.*invalid/.test(haystack)) {
    return {
      code: "AUTH",
      msg: "API Key 无效或已过期（401）。请检查服务端 .env 中的 ARK_API_KEY，改完要重启 npm start。",
      upstreamCode
    };
  }

  if (/balance|overdue|arrear|insufficient|quota|payment|欠费|余额/.test(haystack)) {
    return {
      code: "BALANCE",
      msg: "账户余额不足或模型额度已用尽。请到火山方舟控制台充值 / 查看免费额度后重试。",
      upstreamCode
    };
  }

  if (status === 429 || /rate.?limit|too many|concurrency|限流|频繁/.test(haystack)) {
    return {
      code: "RATE_LIMIT",
      msg: "请求太频繁或触发限流（429）。请稍等几秒再试；持续出现就去控制台检查免费额度和限流设置。",
      upstreamCode
    };
  }

  if (status === 404 || /model.*(not|does not|unavailable)|not.*found|未开通|不存在/.test(haystack)) {
    return {
      code: "MODEL_NOT_FOUND",
      msg: "模型不存在或尚未开通（404）。请检查 .env 中的 ARK_MODEL（或 MODEL_ID）是否与控制台里的模型 ID 一致。",
      upstreamCode
    };
  }

  if (status === 403) {
    return {
      code: "FORBIDDEN",
      msg: "模型拒绝访问（403）。通常是模型未开通、Key 权限不足或账户状态异常，请到火山方舟控制台检查。",
      upstreamCode
    };
  }

  if (status >= 500) {
    return {
      code: "UPSTREAM_5XX",
      msg: "模型服务暂时不可用（HTTP " + status + "），请稍后重试。",
      upstreamCode
    };
  }

  const safeMessage = rawMessage.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 180);
  return {
    code: "UPSTREAM_ERROR",
    msg:
      "模型接口返回错误（HTTP " + status + "）" +
      (safeMessage ? "：" + safeMessage : "。请稍后重试。"),
    upstreamCode
  };
}

function startSse(res) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  // SSE 注释行，让浏览器尽早进入接收状态
  res.write(": connected\n\n");
}

function writeSse(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write("data: " + JSON.stringify(payload) + "\n\n");
}

function readSseData(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

async function forwardArkStream(upstream, res) {
  if (!upstream.body) {
    return { error: true, content: "", toolCalls: [], usage: null, finishReason: null };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = null;
  let finishReason = null;
  let content = "";
  const toolCalls = [];

  const handleBlock = (block) => {
    const data = readSseData(block);
    if (!data || data === "[DONE]") return false;

    let event;
    try {
      event = JSON.parse(data);
    } catch (err) {
      console.error("[POST /api/chat] 无法解析上游 SSE：", data.slice(0, 200));
      return false;
    }

    if (event.error) {
      const friendly = describeArkError(502, event);
      console.error("[POST /api/chat] 上游流内错误：", friendly.upstreamCode);
      writeSse(res, { type: "error", ...friendly });
      return true;
    }

    const choice = event.choices && event.choices[0];
    const delta = choice && choice.delta;

    if (delta && typeof delta.content === "string" && delta.content) {
      content += delta.content;
      writeSse(res, { type: "delta", text: delta.content });
    }

    // 流式工具调用：function.arguments 可能被拆成多个 chunk，需要按 index 累积
    if (delta && Array.isArray(delta.tool_calls)) {
      for (const piece of delta.tool_calls) {
        const index = Number.isInteger(piece.index) ? piece.index : toolCalls.length;
        while (toolCalls.length <= index) {
          toolCalls.push({
            id: "",
            type: "function",
            function: { name: "", arguments: "" }
          });
        }
        const target = toolCalls[index];
        if (piece.id) target.id = piece.id;
        if (piece.type) target.type = piece.type;
        if (piece.function) {
          if (typeof piece.function.name === "string" && piece.function.name) {
            target.function.name += piece.function.name;
          }
          if (typeof piece.function.arguments === "string") {
            target.function.arguments += piece.function.arguments;
          } else if (piece.function.arguments && typeof piece.function.arguments === "object") {
            target.function.arguments = JSON.stringify(piece.function.arguments);
          }
        }
      }
    }

    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = event.usage;
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (handleBlock(block)) {
        return { error: true, content, toolCalls, usage, finishReason };
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) handleBlock(buffer);

  return {
    error: false,
    content,
    toolCalls: toolCalls.filter(
      (call) => call.function.name || call.function.arguments
    ),
    usage,
    finishReason
  };
}

app.post("/api/chat", async (req, res) => {
  const normalized = normalizeChatMessages(req.body);
  if (normalized.error) {
    return res.status(400).json({ code: "BAD_REQUEST", data: null, msg: normalized.error });
  }

  if (!ARK_API_KEY) {
    return res.status(500).json({
      code: "CONFIG_MISSING",
      data: null,
      msg: "服务端还没有配置 ARK_API_KEY。请把 Key 写进项目根目录的 .env，然后重启 npm start。"
    });
  }

  const trimmed = trimChatMessages(normalized.messages);

  startSse(res);
  writeSse(res, {
    type: "meta",
    model: ARK_MODEL,
    contextMessages: trimmed.messages.length,
    contextChars: trimmed.chars,
    droppedMessages: trimmed.dropped,
    maxContextMessages: CHAT_MAX_MESSAGES,
    maxContextChars: CHAT_MAX_CHARS
  });

  const upstreamController = new AbortController();
  let didTimeout = false;
  const timeoutTimer = setTimeout(() => {
    didTimeout = true;
    upstreamController.abort();
  }, CHAT_TIMEOUT_MS);

  const onClientClose = () => {
    if (!res.writableEnded) upstreamController.abort();
  };
  res.on("close", onClientClose);

  const conversation = [{ role: "system", content: CHAT_SYSTEM_PROMPT }].concat(
    trimmed.messages
  );
  let toolRounds = 0;

  try {
    while (toolRounds < MAX_TOOL_ROUNDS) {
      const upstream = await fetch(ARK_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + ARK_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ARK_MODEL,
          messages: conversation,
          stream: true,
          max_tokens: ARK_MAX_TOKENS,
          temperature: 0.7,
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto"
        }),
        signal: upstreamController.signal
      });

      if (!upstream.ok) {
        const raw = await upstream.text();
        let payload = null;
        try {
          payload = raw ? JSON.parse(raw) : null;
        } catch (err) {
          payload = null;
        }
        const friendly = describeArkError(upstream.status, payload);
        console.error(
          "[POST /api/chat] 方舟返回 " +
            upstream.status +
            " " +
            friendly.upstreamCode +
            "：" +
            raw.slice(0, 400)
        );
        writeSse(res, { type: "error", ...friendly });
        return;
      }

      const contentType = String(upstream.headers.get("content-type") || "");
      if (!contentType.includes("text/event-stream")) {
        await upstream.text();
        console.error("[POST /api/chat] 上游不是 SSE，Content-Type=" + contentType);
        writeSse(res, {
          type: "error",
          code: "NOT_STREAM",
          msg: "模型服务没有返回流式数据（Content-Type 不是 text/event-stream），请检查模型是否支持 stream=true。",
          upstreamCode: contentType || "unknown"
        });
        return;
      }

      const result = await forwardArkStream(upstream, res);
      if (result.error) return;

      if (result.toolCalls.length === 0) {
        writeSse(res, {
          type: "done",
          finishReason: result.finishReason || null,
          usage: result.usage || null
        });
        return;
      }

      const assistantCalls = result.toolCalls
        .filter((call) => call.function.name)
        .map((call, index) => ({
          id: call.id || "call_" + toolRounds + "_" + index,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments || "{}"
          }
        }));

      if (assistantCalls.length === 0) {
        writeSse(res, {
          type: "error",
          code: "EMPTY_TOOL_CALL",
          msg: "模型触发了工具调用，但没有返回工具名。请重试。"
        });
        return;
      }

      // 把模型这一轮的 assistant(tool_calls) 追加回对话，再追加每个工具结果
      conversation.push({
        role: "assistant",
        content: result.content || "",
        tool_calls: assistantCalls
      });

      for (const call of assistantCalls) {
        let parsedArgs = null;
        let parseError = null;
        try {
          parsedArgs = call.function.arguments
            ? JSON.parse(call.function.arguments)
            : {};
        } catch (err) {
          parseError = err.message;
        }

        // 先让前端看到「调用了哪个工具、参数是什么」，再执行
        writeSse(res, {
          type: "tool_call",
          id: call.id,
          name: call.function.name,
          args: parsedArgs,
          argsRaw: call.function.arguments,
          parseError
        });

        const toolResult = executeToolCall(
          call.function.name,
          call.function.arguments
        );
        console.log(
          "[tool] " +
            call.function.name +
            " " +
            (toolResult.ok ? "ok" : "fail") +
            "：" +
            (toolResult.summary || toolResult.error || "")
        );

        writeSse(res, {
          type: "tool_result",
          id: call.id,
          name: call.function.name,
          ok: toolResult.ok,
          summary: toolResult.summary || toolResult.error || "",
          result: toolResult
        });

        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult)
        });
      }

      toolRounds += 1;
    }

    writeSse(res, {
      type: "error",
      code: "TOOL_LIMIT",
      msg:
        "工具调用超过 " +
        MAX_TOOL_ROUNDS +
        " 轮，已停止。请把任务拆小一点再试。"
    });
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;

    if (didTimeout) {
      console.error("[POST /api/chat] 等待模型超时（" + CHAT_TIMEOUT_MS + "ms）");
      writeSse(res, {
        type: "error",
        code: "TIMEOUT",
        msg:
          "等待模型响应超时（" +
          Math.round(CHAT_TIMEOUT_MS / 1000) +
          " 秒）。可能是网络慢或模型排队，请稍后重试。"
      });
    } else if (upstreamController.signal.aborted) {
      // 浏览器点了「停止生成」，连接已断开，不需要再写响应
      console.log("[POST /api/chat] 客户端已停止生成");
    } else {
      console.error("[POST /api/chat] 请求方舟失败：", err);
      writeSse(res, {
        type: "error",
        code: "NETWORK",
        msg: "无法连接模型服务。请检查服务器网络、ARK_BASE_URL 是否正确，然后重试。"
      });
    }
  } finally {
    clearTimeout(timeoutTimer);
    res.off("close", onClientClose);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

// 没匹配到的接口统一返回 JSON，前端不会拿到一段 HTML 去 JSON.parse
app.use("/api", (req, res) => {
  fail(res, 404, "接口不存在：" + req.method + " " + req.originalUrl);
});

// ---------- 静态页面 ----------
// 只放行页面需要的文件，server.js / data 不对外
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));

["index", "list", "detail", "chat"].forEach((name) => {
  app.get("/" + name + ".html", (req, res) => {
    res.sendFile(path.join(__dirname, name + ".html"));
  });
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 其余页面请求交给自定义 404（HTTP 状态码仍然是 404）
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "404.html"));
});

// 兜底错误处理（例如请求体不是合法 JSON）
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return fail(res, 400, "请求体不是合法的 JSON");
  }
  console.error("[server error]", err);
  fail(res, 500, "服务器内部错误");
});

// ---------- 启动 ----------

const server = app.listen(PORT, HOST, () => {
  console.log("服务已启动：http://127.0.0.1:" + PORT);
  console.log("项目列表页：http://127.0.0.1:" + PORT + "/list.html");
  console.log("AI 对话页：http://127.0.0.1:" + PORT + "/chat.html");
  console.log("数据文件：" + DATA_FILE);
  console.log("火山方舟：模型 " + ARK_MODEL + "，API Key " + (ARK_API_KEY ? "已配置" : "未配置（请填写 .env）"));
  console.log(
    "跨域：允许来源 " + (allowOrigins.includes("*") ? "*（任意）" : allowOrigins.join(", "))
  );
  if (DEBUG_DELAY_MS) console.log("调试：/api/list 将延迟 " + DEBUG_DELAY_MS + "ms");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("端口 " + PORT + " 已被占用：可能已经有一个 server.js 在跑，或者被别的程序占了。");
    console.error("处理：关掉旧的 Node 进程；或换个端口，例如 PowerShell 里 $env:PORT=3002; npm start");
    console.error("换端口后记得同步改 js/config.js 里的 LOCAL_API_BASE。");
  } else {
    console.error("启动失败：", err);
  }
  process.exit(1);
});

// Ctrl+C 优雅退出，数据已写在 data/projects.json
["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    console.log("\n收到 " + signal + "，服务关闭，数据已保存在 " + DATA_FILE);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
});
