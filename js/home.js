/* 首页：Tab 切换 + 项目概览（同样有加载中 / 空 / 失败三种状态） */
(function () {
  "use strict";

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab-btn"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".tab-panel"));
  var listBox = document.getElementById("homeList");
  var countEl = document.getElementById("homeCount");
  var apiEl = document.getElementById("homeApi");

  var state = { loading: false, error: "", items: [], loaded: false, offline: false };
  var seq = 0;

  if (apiEl) {
    apiEl.textContent = "GET /api/list（" + window.APP_CONFIG.API_BASE + "）";
  }

  function timeText(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function render() {
    if (!listBox) return;

    if (state.loading) {
      listBox.innerHTML =
        '<div class="skeleton"><span class="w-40"></span><span class="w-90"></span></div>' +
        '<div class="skeleton"><span class="w-40"></span><span class="w-70"></span></div>';
      countEl.textContent = "加载中…";
      return;
    }

    if (!state.items.length) {
      countEl.textContent = state.error ? "" : "共 0 项";
      listBox.innerHTML = state.error
        ? '<div class="state">' +
          '<p class="state-title">暂无数据</p>' +
          '<p class="state-desc">切到别的 Tab 再切回来，或去列表页刷新一下。</p>' +
          "</div>"
        : '<div class="state empty">' +
          '<p class="state-title">还没有项目</p>' +
          '<p class="state-desc">去项目列表页添加第一个项目，这里会同步显示。</p>' +
          "</div>";
      return;
    }

    countEl.textContent = "共 " + state.items.length + " 项" + (state.offline ? "（线上只读）" : "");
    listBox.innerHTML = state.items.map(function (item) {
      return (
        '<article class="item">' +
        '<div class="item-head"><h3 class="item-title">' + window.escapeHtml(item.title) + "</h3>" +
        '<span class="item-time">' + timeText(item.createdAt) + "</span></div>" +
        '<p class="item-desc">' + window.escapeHtml(item.desc || "（没有填写描述）") + "</p>" +
        "</article>"
      );
    }).join("");
  }

  async function load(force) {
    if (state.loading) return;
    if (state.loaded && !state.error && !force) return;

    var mySeq = ++seq;
    state.loading = true;
    state.error = "";
    render();

    try {
      var data = await window.api.get("/api/list");
      if (mySeq !== seq) return;
      state.items = Array.isArray(data) ? data : [];
      state.loaded = true;
      state.offline = false;
    } catch (err) {
      if (mySeq !== seq) return;
      // 线上静态托管没有后端：退回仓库里的只读演示数据
      try {
        var res = await fetch("data/projects.json", { cache: "no-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var items = await res.json();
        if (mySeq !== seq) return;
        state.items = Array.isArray(items) ? items : [];
        state.error = "";
        state.loaded = true;
        state.offline = true;
      } catch (e2) {
        if (mySeq !== seq) return;
        state.error = err.message;
        state.loaded = false;
      }
    } finally {
      if (mySeq === seq) {
        state.loading = false;
        if (apiEl) {
          apiEl.textContent = state.offline
            ? "线上只读演示数据（data/projects.json）；本地 npm start 后可增删"
            : "GET /api/list（" + window.APP_CONFIG.API_BASE + "）";
        }
        render();
      }
    }
  }

  tabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabs.forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");

      panels.forEach(function (panel) {
        panel.classList.toggle("show", panel.id === btn.getAttribute("data-panel"));
      });

      if (btn.getAttribute("data-panel") === "project") load(false);
    });
  });

  // 页面一打开就请求一次，点到「项目概览」时数据已经在手里
  load(true);
})();
