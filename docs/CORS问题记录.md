# 一次真实的 CORS 问题记录

> 记录人：李金洋　时间：2026-11-13 21:28　项目：`node\9`（原生前端 + Express）
> 结论：跨域问题在**服务端加响应头**解决，没有关浏览器安全策略，也没有装 Allow CORS 之类的插件。

## 一、环境

| 项 | 值 |
| --- | --- |
| 系统 / 浏览器 | Windows 11 · Chrome 157 |
| 前端页面 | `http://127.0.0.1:3011/list.html`（`node server.js` 托管静态页） |
| 后端接口 | `http://127.0.0.1:3020/api/list`（同一份 `server.js`，换了端口） |
| 依赖 | Express 4.21 · cors 2.8.5 · Node 26 |
| 请求代码 | `js/api.js` 里 `fetch(API_BASE + "/api/list")`，带 `Content-Type: application/json` |

> 说明：平时本地是前后端同源（都跑在 3001），这里把前端放 3011、后端放 3020，就是为了真实触发一次跨域。

## 二、现象

打开 `http://127.0.0.1:3011/list.html`，页面列表一直是「暂无数据」，Network 里能看到一个红色的 `api/list` 请求。

![修复前：页面拿不到数据](../screenshots/cors-before.png)

## 三、报错原文

F12 → Console（原样复制）：

```text
Access to fetch at 'http://127.0.0.1:3020/api/list' from origin 'http://127.0.0.1:3011' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

Network 面板里对应的请求：

```text
Request URL: http://127.0.0.1:3020/api/list
Request Method: OPTIONS        ← 先发的是预检，不是 GET
Status: (failed) net::ERR_FAILED
```

## 四、定位过程

1. 先看 Network，发现真正的请求不是 `GET`，而是浏览器自动发的 `OPTIONS` 预检。
   原因是请求带了 `Content-Type: application/json`，属于「非简单请求」，浏览器必须先预检。
2. 用 curl 手动打一次预检，确认服务端到底回了什么：

```text
> curl -i -X OPTIONS http://127.0.0.1:3020/api/list
  -H "Origin: http://127.0.0.1:3011"
  -H "Access-Control-Request-Method: GET"
  -H "Access-Control-Request-Headers: content-type"

HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
{"code":404,"data":null,"msg":"接口不存在：OPTIONS /api/list"}
```

3. 响应里**完全没有** `Access-Control-Allow-Origin` 等跨域头，而且 `OPTIONS` 被当成未知接口返回了 404。
4. 结论：浏览器同源策略要求跨域响应必须带 `Access-Control-Allow-Origin`；预检都没通过，真正的 `GET` 根本不会发出去。
   当时为了复现，`server.js` 里的 `app.use(cors(...))` 被临时注释掉了，所以服务端一个跨域头都没加。

## 五、为什么不能「改浏览器安全策略」

- 关掉 Chrome 的 `--disable-web-security`、装 Allow CORS 插件，只在自己这台机器有效；
- 换台电脑、换成老师/用户打开，照样失败；
- 更麻烦的是它把问题藏起来了：真实的线上部署（前端 GitHub Pages、后端 Render）一定会再撞一次。

所以要改的是服务端。

## 六、修复

在 `server.js` 里用 `cors` 中间件统一加响应头：

```js
const cors = require("cors");

const allowOrigins = (process.env.ALLOW_ORIGINS || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: allowOrigins.includes("*") ? true : allowOrigins, // 反射 Origin，并自动带 Vary: Origin
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 86400
  })
);
```

要点：

- `OPTIONS` 预检由中间件自动应答，不用自己写路由；
- `origin: true` 会把请求的 `Origin` 原样回写，并带上 `Vary: Origin`，比写死 `*` 更适合以后要带 Cookie 的场景；
- 部署后想收紧来源：`ALLOW_ORIGINS=https://你的前端域名 npm start`。

## 七、修复后的验证

预检请求：

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://127.0.0.1:3011
Vary: Origin
Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

真正的查询请求：

```text
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://127.0.0.1:3011
Vary: Origin
```

页面恢复正常，三条数据都能显示，Console 里没有任何 CORS 报错：

![修复后：跨域请求正常，列表加载出来](../screenshots/cors-after.png)

## 八、复盘

- **预检的触发条件**：方法不是 GET/POST/HEAD、或者带了 `Content-Type: application/json` 这类非简单头、或者有自定义头，浏览器都会先发 `OPTIONS`。
- **报错要看原文**：`No 'Access-Control-Allow-Origin' header is present` 说的是响应头缺失，不是「前端代码写错了」。
- **curl 能通不代表浏览器能通**：curl 不受同源策略限制，所以要用「带 Origin 的 curl」看响应头，或者直接看 Network。
- **部署时的同类坑**：前端 `https://`、后端 `http://` 会被当成混合内容拦掉；前端地址还写死 `127.0.0.1` 就会「本地好好的、线上白屏」。这两条在 README 的部署章节里也写了。
