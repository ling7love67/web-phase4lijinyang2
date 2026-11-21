/* ============================================================
 * 后端可用性检查
 * 线上（GitHub Pages）只有静态文件，POST /api/chat 会返回 405。
 * 这里先探一次 /api/health：失败就顶部提示并禁用发送，
 * 避免用户点了发送只看到一句「请求失败（HTTP 405）」。
 * ============================================================ */
(function () {
  "use strict";

  var cfg = window.APP_CONFIG || {};
  var api = cfg.API_BASE;
  if (!api) return;

  function showTip(text) {
    var main = document.querySelector("main");
    if (!main) return;
    if (document.getElementById("backendTip")) return;

    var box = document.createElement("div");
    box.id = "backendTip";
    box.className = "status warn";
    box.setAttribute("role", "status");
    box.textContent = text;
    main.insertBefore(box, main.firstChild);

    var send = document.getElementById("sendBtn");
    if (send) {
      send.disabled = true;
      send.textContent = "线上不可用";
    }
    var input = document.getElementById("chatInput");
    if (input) {
      input.disabled = true;
      input.placeholder = "线上演示版没有后端，AI 对话需本地运行 npm start";
    }
  }

  // 4 秒还没回应就当不可用，不要一直转
  var ctrl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () {
    if (ctrl) ctrl.abort();
  }, 4000);

  fetch(api + "/api/health", {
    cache: "no-store",
    signal: ctrl ? ctrl.signal : undefined
  })
    .then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
    })
    .catch(function () {
      clearTimeout(timer);
      showTip("线上演示版没有后端，AI 对话暂不可用。本地运行 npm start 后访问 http://127.0.0.1:3001/chat.html 即可；或在 js/config.js 里填写部署好的 ONLINE_API_BASE。");
    });
})();