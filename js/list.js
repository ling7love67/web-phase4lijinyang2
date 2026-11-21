/* ============================================================
 * 项目列表页：查询 / 新增 / 删除
 * 三种状态都做了：加载中（骨架屏）、空数据、请求失败（带重试）
 * 新增或删除成功后自动重新拉一次列表，数据在后端，F5 也不会丢
 * ============================================================ */
(function () {
  "use strict";

  var els = {
    form: document.getElementById("addForm"),
    title: document.getElementById("titleInput"),
    desc: document.getElementById("descInput"),
    addBtn: document.getElementById("addBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    status: document.getElementById("statusBar"),
    listBox: document.getElementById("listBox"),
    count: document.getElementById("countText"),
    apiHint: document.getElementById("apiHint"),
     search: document.getElementById("searchInput"),        // ★ 必须加
    clearSearch: document.getElementById("clearSearchBtn") // ★ 必须加
  };

  var state = {
    loading: true,
    error: "",
    items: [],
    busyId: null,
    adding: false,
    loadedOnce: false,
    keyword:"",
    readonly: false
  };

  // 每发一次请求 +1，回来时对不上就丢弃，避免快速点刷新时旧数据覆盖新数据
  var seq = 0;

  if (els.apiHint) els.apiHint.textContent = window.APP_CONFIG.API_BASE;

  // ---------- 渲染 ----------

  function skeletonHtml() {
    var row =
      '<div class="skeleton"><span class="w-40"></span><span class="w-90"></span><span class="w-70"></span></div>';
    return row + row + row;
  }

  function timeText(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function itemHtml(item) {
    var id = String(item.id);
    var busy = state.busyId === id;
    var desc = item.desc
      ? window.escapeHtml(item.desc)
      : '<span class="muted">（没有填写描述）</span>';

    return (
      '<article class="item">' +
        '<div class="item-head">' +
          '<h3 class="item-title">' + window.escapeHtml(item.title) + "</h3>" +
          '<span class="item-id">#' + window.escapeHtml(id) + "</span>" +
        "</div>" +
        '<p class="item-desc">' + desc + "</p>" +
        '<div class="item-foot">' +
          '<span class="item-time">' + timeText(item.createdAt) + "</span>" +
          '<button type="button" class="btn btn-danger btn-sm" data-del="' +
            window.escapeHtml(id) + '"' + (busy || state.readonly ? " disabled" : "") +
            (state.readonly ? ' title="线上只读演示，本地启动后端后可删除"' : "") + ">" +
            (busy ? "删除中…" : "删除") +
          "</button>" +
        "</div>" +
      "</article>"
    );
  }

    // 判断一条项目是否命中关键词：不区分大小写，空格分隔的多个词要"全部"命中
  function matchKeyword(item, keyword) {
    if (!keyword) return true;
    var words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    var text = ((item.title || "") + " " + (item.desc || "")).toLowerCase();
    return words.every(function (w) {
      return text.indexOf(w) !== -1;
    });
  }

  // 根据当前关键词，从全部数据里挑出要显示的
  function visibleItems() {
    return state.items.filter(function (item) {
      return matchKeyword(item, state.keyword);
    });
  }

  // 线上静态托管没有后端时，退回仓库里的只读演示数据
  async function loadStaticData() {
    try {
      var res = await fetch("data/projects.json", { cache: "no-cache" });
      if (!res.ok) return false;
      var items = await res.json();
      if (!Array.isArray(items)) return false;
      state.items = items;
      state.readonly = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  // 只读模式下锁住「新增」和「删除」，避免点了必然失败
  function applyReadonly() {
    var ro = state.readonly;
    if (els.title) els.title.disabled = ro;
    if (els.desc) els.desc.disabled = ro;
    if (els.addBtn) {
      els.addBtn.disabled = ro || state.adding;
      els.addBtn.textContent = ro ? "线上只读" : (state.adding ? "提交中…" : "新增项目");
    }
  }

  function setStatus(type, message) {
    if (!els.status) return;
    if (!type) {
      els.status.hidden = true;
      els.status.textContent = "";
      els.status.className = "status";
      return;
    }
    els.status.hidden = false;
    els.status.className = "status " + type;
    els.status.textContent = message;
  }

  function render() {
    if (!els.listBox) return;

    var list=visibleItems();

    if (els.count) {
      if(!state.loadedOnce){
        els.count.textContent="";
      }else if(!state.keyword){
        els.count.textContent = "共 " + state.items.length + " 项";
    }else{
      //2。搜索时把“找到几条/总共几条”都说清楚，别让人以为数据被删了
      els.count.textContent = "找到 " + list.length + "项 / 共 " + state.items.length + "项";
    }
      }
      

    // 1. 加载中：列表为空时用骨架屏占位，避免页面「闪一下空白」
    if (state.loading && state.items.length === 0) {
      els.listBox.setAttribute("aria-busy", "true");
      els.listBox.innerHTML = skeletonHtml();
      return;
    }
    els.listBox.setAttribute("aria-busy", "false");

    // 2. 没有数据：正常情况提示去新增；请求出错时只给一句中性的「暂无数据」，不做失败页
    if (state.items.length === 0) {
      if (state.error) {
        els.listBox.innerHTML =
          '<div class="state">' +
            '<p class="state-title">暂无数据</p>' +
            '<p class="state-desc">等一下点右上角「刷新列表」再试。</p>' +
          "</div>";
      } else {
        els.listBox.innerHTML =
          '<div class="state empty">' +
            '<p class="state-title">还没有项目</p>' +
            '<p class="state-desc">在上面的表单里填项目名称和描述，点「新增项目」就会出现在这里。</p>' +
          "</div>";
      }
      return;
    }

        // 3. 有数据，但被搜索筛空了
    if (list.length === 0) {
      els.listBox.innerHTML =
        '<div class="state empty">' +
          '<p class="state-title">没有找到匹配的项目</p>' +
          '<p class="state-desc">换个关键词试试，或者点搜索框右边的「清空」查看全部。</p>' +
        "</div>";
      return;
    }


    // 4. 正常列表
    els.listBox.innerHTML = list.map(itemHtml).join("");
  }

  // ---------- 请求 ----------

  async function load(options) {
    options = options || {};
    // 已经有数据时静默刷新：不切换成骨架屏，避免列表「跳一下」
    var silent = options.silent === true && state.items.length > 0;
    var mySeq = ++seq;

    if (!silent) {
      state.loading = true;
      state.error = "";
      setStatus(null);
    }
    render();

    try {
      var data = await window.api.get("/api/list");
      if (mySeq !== seq) return;
      state.items = Array.isArray(data) ? data : [];
      state.error = "";
      state.loadedOnce = true;
      state.readonly = false;
      setStatus(options.okText ? "ok" : null, options.okText || "");
    } catch (err) {
      if (mySeq !== seq) return;
      // 线上是静态托管，没有后端 —— 退回仓库里的只读演示数据
      var ok = await loadStaticData();
      if (mySeq !== seq) return;
      if (ok) {
        state.error = "";
        state.loadedOnce = true;
        setStatus("warn", "线上只读演示数据（data/projects.json）；本地 npm start 后可增删。");
      } else {
        state.error = err.message;
        if (state.items.length > 0) {
          // 有旧数据就保留，只在顶部提示，不弹失败页
          setStatus("warn", "刷新失败，下面显示的是上一次的数据。");
        } else {
          setStatus(null);
        }
      }
    } finally {
      if (mySeq === seq) {
        state.loading = false;
        applyReadonly();
        render();
      }
    }
  }

  async function onAdd(event) {
    event.preventDefault();
    if (state.readonly) return;
    if (state.adding) return;

    var title = els.title.value.trim();
    var desc = els.desc.value.trim();

    if (!title) {
      els.title.focus();
      setStatus("warn", "项目名称不能为空。");
      return;
    }
    if (title.length > 60) {
      els.title.focus();
      setStatus("warn", "项目名称最多 60 个字。");
      return;
    }

    state.adding = true;
    els.addBtn.disabled = true;
    els.addBtn.textContent = "提交中…";

    try {
      await window.api.post("/api/add", { title: title, desc: desc });
      els.form.reset();
      els.title.focus();
      // 新增成功后重新拉列表：不靠前端手动 push，保证和服务端一致
      await load({ silent: true, okText: "新增成功，列表已自动刷新。" });
    } catch (err) {
      setStatus("error", "新增失败：" + err.message);
    } finally {
      state.adding = false;
      applyReadonly();
    }
  }

  async function removeItem(id) {
    if (state.readonly) return;
    if (state.busyId) return;
    if (!window.confirm("确定删除这个项目吗？删除后无法恢复。")) return;

    state.busyId = id;
    render();

    try {
      await window.api.del("/api/del?id=" + encodeURIComponent(id));
      state.busyId = null;
      await load({ silent: true, okText: "删除成功，列表已自动刷新。" });
    } catch (err) {
      state.busyId = null;
      render();
      setStatus("error", "删除失败：" + err.message);
    }
  }

  // ---------- 事件 ----------

    if (els.search) {
    els.search.addEventListener("input", function () {
      state.keyword = els.search.value.trim();
      if (els.clearSearch) els.clearSearch.hidden = !state.keyword;
      render();                      // 本地过滤，直接重渲染，不用发请求
    });
  }

  if (els.clearSearch) {
    els.clearSearch.addEventListener("click", function () {
      els.search.value = "";
      state.keyword = "";
      els.clearSearch.hidden = true;
     if(els.search) els.search.focus();            // 清空后光标留在输入框里，方便继续搜
      render();
    });
  }

  if (els.form) els.form.addEventListener("submit", onAdd);

  if (els.refreshBtn) {
    els.refreshBtn.addEventListener("click", function () {
      load({ okText: "列表已刷新。" });
    });
  }

  // 删除按钮用事件委托，列表重渲染后不用重新绑定
  if (els.listBox) {
    els.listBox.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var btn = target.closest("[data-del]");
      if (btn) removeItem(btn.getAttribute("data-del"));
    });
  }

  load({});
})();
