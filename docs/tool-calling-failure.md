# 任务 5 失败案例：工具 schema 字段名和执行器不一致

## 1. 现象

初版 `add_item` 的工具定义里，参数名写成了 `item_name`：

```js
parameters: {
  type: "object",
  properties: {
    item_name: { type: "string", description: "项目名称" }
  },
  required: ["item_name"]
}
```

用户说：

> 帮我加一条明天交实验报告

模型**确实调用了工具**，但它是严格按 schema 传参的，返回的 `tool_calls.function.arguments` 是：

```json
{"item_name": "明天交实验报告"}
```

而后端执行器读取的是 `args.title`：

```js
if (typeof args.title !== "string") {
  return { ok: false, error: "title 必须是字符串" };
}
```

结果就是：模型选对了工具，参数也按它看到的 schema 传了，但**工具定义和执行器的字段契约不一致**，
执行器拿到 `undefined`，返回参数校验失败，模型只能告诉用户「添加失败」。

这是任务 5 要求里典型的「参数格式不对」失败，不是模型乱编，也不是网络问题。

## 2. 失败复现记录

用一个独立的最小请求复现（只验证工具定义，不写真实数据）：

```text
tool_calls: [{"name":"add_item","args":""},
             {"args":"{\"item_name\": \""},
             {"args":"明天"},
             {"args":"交"},
             {"args":"实验"},
             {"args":"报告"},
             {"args":"\""},
             {"args":"}"}]
```

把流式参数拼接后得到：

```json
{"item_name":"明天交实验报告"}
```

这证明模型是照着 schema 的 `item_name` 调的；错误出在 schema 与执行器没有统一。

## 3. 怎么定位

1. 打开后端日志，确认 `add_item` 被调用了，模型没有选错工具。
2. 打印/查看 `tool_calls[].function.arguments`，看到字段是 `item_name`。
3. 对照执行器 `toolAddItem(args)`，发现读取的是 `args.title`。
4. 再检查 schema：`item_name` 和 `title` 两套名字，且 `title` 没有出现在 `required` 里。

一句话：**模型按 schema 办事，schema 写错了，执行器当然拿不到值。**

## 4. 修复

### 4.1 统一字段名

工具定义改成 `title`（必填）和 `desc`（可选），和执行器完全一致：

```js
properties: {
  title: { type: "string", description: "条目标题，例如「明天交实验报告」，最多 60 字" },
  desc:  { type: "string", description: "可选描述，最多 200 字" }
},
required: ["title"]
```

### 4.2 执行器补参数校验

`toolAddItem` 现在会检查：

- `title` 必须是字符串且不能为空；
- `title` 最多 60 字；
- `desc` 如果传了必须是字符串，最多 200 字；
- 工具名不存在、参数不是合法 JSON、数据文件格式坏掉，都返回结构化错误给模型，而不是让服务崩溃。

### 4.3 把「什么时候必须调用」写进描述和系统提示词

- `add_item` 描述明确写出：新增、添加、记录项目/任务/待办时调用；标题必填，描述可选。
- 系统提示词增加：涉及项目清单变更/查询时必须调用工具，工具执行结果才是事实，不能只口头答应，也不能编造结果。
- 工具名和参数在页面上可见，方便对照模型到底传了什么。

## 5. 回归验证

用任务 5 的验收句：

> 帮我加一条明天交实验报告

修复后的实际链路：

```text
tool_call:   add_item
args:        {"title":"明天交实验报告"}
tool_result: ok=true
summary:     已新增「明天交实验报告」，当前共 1 条项目
```

数据库 `data/projects.json` 中确实多了一条：

```json
{
  "id": 1794658169385,
  "title": "明天交实验报告",
  "desc": "",
  "createdAt": "2026-11-14T12:09:29.385Z"
}
```

同时测试了查询工具：

> 帮我查一下有没有实验报告相关的项目

```text
tool_call:   query_items
args:        {"keyword":"实验报告"}
tool_result: ok=true
summary:     查询完成：匹配 1 条，返回 1 条（关键词「实验报告」）
```

## 6. 这次失败带来的检查清单

以后新增工具时，按这个顺序对一遍：

1. `function.name` 和执行器 `if (name === ...)` 是否一致；
2. schema 的 `properties` 字段名和 `args.xxx` 是否一致；
3. 必填字段是否真的进了 `required`；
4. description 是否包含用户会说的自然语言和调用边界；
5. 参数错误时，工具是否返回 `{ ok:false, error }` 让模型能自我修正，而不是直接 500；
6. 前端日志是否能看到工具名、原始参数和执行结果。
