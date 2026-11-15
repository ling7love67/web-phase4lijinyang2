/* ============================================================
 * 接口地址配置 —— 全站只有这一个地方写后端地址
 * 改地址只需要改下面两行，业务代码（list.js / home.js）不碰 URL
 * ============================================================ */
window.APP_CONFIG = (function () {
  "use strict";

  // 本地开发时的后端地址（node server.js 默认监听 3001）
  var LOCAL_API_BASE = "http://127.0.0.1:3001";

  // 线上部署后的后端地址，例如 "https://my-api.onrender.com"
  // 留空表示「前端和后端同源」（用 server.js 同时托管页面和接口时就是这种情况）
  var ONLINE_API_BASE = "";

  var host = location.hostname;
  var isLocal =
    location.protocol === "file:" ||
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0";

  var base = isLocal ? LOCAL_API_BASE : ONLINE_API_BASE || location.origin;

  return {
    // 统一去掉末尾斜杠，拼接口时不会出现 //api/list
    API_BASE: String(base).replace(/\/+$/, ""),
    // 单次请求超时（毫秒）。断网、后端没启动时也能较快进入「失败」状态
    TIMEOUT: 10000,
    IS_LOCAL: isLocal
  };
})();
