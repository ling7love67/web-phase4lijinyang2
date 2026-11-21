/* ============================================================
 * 任务 4：AI 流式对话
 *
 * 前端只做三件事：
 *   1. 用 fetch 发 messages，交给服务端转发（Key 不在浏览器里）
 *   2. 逐块读取 SSE，把 delta 追加到当前气泡
 *   3. 用 AbortController 实现「停止生成」
 *
 * 上下文只保留「已完成的轮次」；出错/停止时不会把半截回答塞进历史。
 * ============================================================ */
(function () {
  "use strict";

  var MAX_INPUT = 2000;
  var CHAT_KEY = "node9.chat.v1";        // 本轮对话（sessionStorage）
  var DRAFT_KEY = "node9.chat.draft.v1"; // 输入框草稿

  var cfg = window.APP_CONFIG || {};
  var apiBase = String(cfg.API_BASE || "").replace(/\/+$/, "");

  var els = {
    window: document.getElementById("chatWindow"),
    input: document.getElementById("chatInput"),
    sendBtn: document.getElementById("sendBtn"),
    stopBtn: document.getElementById("stopBtn"),
    clearBtn: document.getElementById("clearBtn"),
    status: document.getElementById("chatStatus"),
    badge: document.getElementById("contextBadge"),
    inputHint: document.getElementById("inputHint"),
    toolPanel: document.getElementById("toolPanel"),
    toolLog: document.getElementById("toolLog"),
    toolCount: document.getElementById("toolCount"),
    toolToggle: document.getElementById("toolToggle")
  };

  if (!els.window || !els.input || !els.sendBtn) return;

  var history = []; // [{ role: "user" | "assistant", content: "..." }]
  var busy = false;
  var controller = null;
  var stopRequested = false;
  var lastMeta = null;
  var toolEntries = {};
  var toolCallCount = 0;

  function ChatError(message, code) {
    this.name = "ChatError";
    this.message = message;
    this.code = code || "";
  }
  ChatError.prototype = Object.create(Error.prototype);
  ChatError.prototype.constructor = ChatError;

  function setStatus(message, tone) {
    if (!message) {
      els.status.hidden = true;
      els.status.textContent = "";
      els.status.className = "status";
      return;
    }
    els.status.hidden = false;
    els.status.className = "status " + (tone || "warn");
    els.status.textContent = message;
  }

  function updateBadge(meta) {
    var turns = history.filter(function (item) {
      return item.role === "user";
    }).length;

    var text = turns + " 轮上下文";
    if (meta && meta.droppedMessages > 0) {
      text += " · 已省略最早 " + meta.droppedMessages + " 条";
    }
    if (meta && meta.contextChars) {
      text += " · " + meta.contextChars + " 字";
    }
    els.badge.textContent = text;

    if (meta && meta.maxContextMessages) {
      els.badge.title =
        "服务端最多携带 " +
        meta.maxContextMessages +
        " 条消息 / " +
        meta.maxContextChars +
        " 字（含系统提示词），超出后从最早的消息开始丢弃";
    } else {
      els.badge.title = "服务端会自动裁剪上下文，只保留最近的消息";
    }
  }

  function updateInputHint() {
    var len = els.input.value.length;
    els.inputHint.textContent =
      "Enter 发送 · Shift + Enter 换行 · " + len + "/" + MAX_INPUT;
    els.inputHint.classList.toggle("is-near-limit", len > MAX_INPUT * 0.95);
  }

  // ---------- 富文本：只处理 ``` 代码块和 `行内代码`，其余保持纯文本 ----------
  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderRich(text) {
    var safe = escapeHtml(text);
    safe = safe.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, function (_, code) {
      return '<pre class="code-block"><code>' + code.replace(/\n$/, "") + "</code></pre>";
    });
    safe = safe.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return safe;
  }

  // ---------- 复制 ----------
  function flashCopied(btn) {
    if (!btn) return;
    var old = btn.getAttribute("data-label") || "复制";
    btn.setAttribute("data-label", old);
    btn.textContent = "已复制";
    setTimeout(function () { btn.textContent = old; }, 1200);
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text, btn) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        flashCopied(btn);
      }, function () {
        if (fallbackCopy(text)) flashCopied(btn);
        else setStatus("复制失败，请长按选择文本。", "warn");
      });
      return;
    }
    if (fallbackCopy(text)) flashCopied(btn);
    else setStatus("复制失败，请长按选择文本。", "warn");
  }

  // ---------- 会话持久化（sessionStorage：关掉标签页就清空） ----------
  function saveChat() {
    try {
      sessionStorage.setItem(CHAT_KEY, JSON.stringify({
        history: history,
        meta: lastMeta
      }));
    } catch (e) { /* 隐私模式存不了就跳过 */ }
  }

  function restoreChat() {
    try {
      var raw = sessionStorage.getItem(CHAT_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      var list = data && Array.isArray(data.history) ? data.history : [];
      list.forEach(function (m) {
        if (!m || !m.content) return;
        var node = appendMessage(m.role === "user" ? "user" : "assistant", m.content);
        if (m.role !== "user") node.textEl.innerHTML = renderRich(m.content);
        history.push({ role: m.role, content: m.content });
      });
      if (data.meta) lastMeta = data.meta;
    } catch (e) { /* 数据坏了就当没存过 */ }
  }

  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, els.input.value); } catch (e) { /* 忽略 */ }
  }

  function restoreDraft() {
    try {
      var draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) els.input.value = draft;
    } catch (e) { /* 忽略 */ }
  }

  function autoGrow() {
    if (!els.input) return;
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 180) + "px";
  }

  function scrollToBottom(force) {
    var distance =
      els.window.scrollHeight - els.window.scrollTop - els.window.clientHeight;
    if (force || distance < 120) {
      els.window.scrollTop = els.window.scrollHeight;
    }
  }

  function makeTyping() {
    var wrap = document.createElement("span");
    wrap.className = "typing";
    wrap.setAttribute("aria-label", "正在生成");
    for (var i = 0; i < 3; i += 1) {
      wrap.appendChild(document.createElement("span"));
    }
    return wrap;
  }

  function appendMessage(role, text) {
    var row = document.createElement("div");
    row.className = "chat-message " + role;

    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = role === "user" ? "我" : "AI";

    var bubble = document.createElement("div");
    bubble.className = "bubble";

    var messageText = document.createElement("div");
    messageText.className = "message-text";
    if (text) {
      messageText.textContent = text;
    } else {
      messageText.appendChild(makeTyping());
    }

    var meta = document.createElement("div");
    meta.className = "bubble-meta";
    meta.textContent = role === "user" ? "你" : "AI · 流式输出";

    bubble.appendChild(messageText);
    bubble.appendChild(meta);

    if (role !== "user") {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "msg-copy";
      copyBtn.textContent = "复制";
      copyBtn.setAttribute("data-label", "复制");
      copyBtn.addEventListener("click", function () {
        copyText(messageText.textContent, copyBtn);
      });
      bubble.appendChild(copyBtn);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    els.window.appendChild(row);
    scrollToBottom(true);

    return { row: row, bubble: bubble, textEl: messageText };
  }

  function addErrorNote(bubble, message, className) {
    var note = document.createElement("div");
    note.className = className || "message-error";
    note.textContent = message;
    bubble.appendChild(note);
    scrollToBottom(true);
  }

  function dropPendingUser() {
    // 失败或停止的这一轮没有 assistant，问题也不写入下一次上下文
    if (history.length && history[history.length - 1].role === "user") {
      history.pop();
      return true;
    }
    return false;
  }

  function normalizeForRequest(messages) {
    // 某一轮失败后，历史里可能连续出现 user；合并成一条，避免模型看到奇怪的角色序列
    var result = [];
    messages.forEach(function (item) {
      var previous = result[result.length - 1];
      if (item.role === "user" && previous && previous.role === "user") {
        previous.content += "\n\n" + item.content;
      } else {
        result.push({ role: item.role, content: item.content });
      }
    });
    return result;
  }

  function readSseData(block) {
    return block
      .split(/\r?\n/)
      .filter(function (line) {
        return line.indexOf("data:") === 0;
      })
      .map(function (line) {
        return line.slice(5).replace(/^ /, "");
      })
      .join("\n")
      .trim();
  }

  async function consumeSse(response, onEvent) {
    if (!response.body) {
      throw new ChatError("浏览器没有拿到响应流，请换用新版 Chrome / Edge。", "NO_STREAM");
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";

    function handleBlock(block) {
      var data = readSseData(block);
      if (!data || data === "[DONE]") return;

      var event;
      try {
        event = JSON.parse(data);
      } catch (err) {
        // 不把格式错误当成用户能看懂的报错，继续读下一块
        return;
      }
      onEvent(event);
    }

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      var match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        var block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        handleBlock(block);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) handleBlock(buffer);
  }

  async function readErrorBody(response) {
    var text = "";
    try {
      text = await response.text();
    } catch (err) {
      /* 读不到就用状态码兜底 */
    }

    if (text) {
      try {
        var body = JSON.parse(text);
        if (body && body.msg) return body.msg;
      } catch (err) {
        // 不是 JSON，例如代理返回 HTML：不直接显示整页 HTML
      }
    }
    return "请求失败（HTTP " + response.status + "）";
  }

  function setBusy(value) {
    busy = value;
    els.sendBtn.disabled = value;
    els.sendBtn.textContent = value ? "生成中…" : "发送";
    els.stopBtn.hidden = !value;
    els.stopBtn.disabled = false;
    els.clearBtn.disabled = value;
    els.input.disabled = value;
  }

  function setToolPanelCollapsed(collapsed) {
    if (!els.toolLog || !els.toolToggle) return;
    els.toolLog.hidden = collapsed;
    els.toolToggle.textContent = collapsed ? "展开" : "收起";
    els.toolToggle.setAttribute("aria-expanded", String(!collapsed));
  }

  function resetToolLog() {
    toolEntries = {};
    toolCallCount = 0;
    if (!els.toolPanel) return;
    els.toolPanel.hidden = true;
    if (els.toolLog) els.toolLog.textContent = "";
    if (els.toolCount) els.toolCount.textContent = "0";
    setToolPanelCollapsed(false);
  }

  function findLastPendingToolEntry() {
    var ids = Object.keys(toolEntries);
    for (var i = ids.length - 1; i >= 0; i -= 1) {
      var record = toolEntries[ids[i]];
      if (record && record.status && record.status.textContent === "调用中") return record;
    }
    return null;
  }

  function addToolCallEvent(event) {
    if (!els.toolPanel || !els.toolLog) return;

    els.toolPanel.hidden = false;
    setToolPanelCollapsed(false);

    var entry = document.createElement("div");
    entry.className = "tool-entry";

    var head = document.createElement("div");
    head.className = "tool-entry-head";

    var name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = event.name || "(unknown)";

    var status = document.createElement("span");
    status.className = "tool-status pending";
    status.textContent = "调用中";

    head.appendChild(name);
    head.appendChild(status);

    var args = document.createElement("div");
    args.className = "tool-args";
    var argsText = "";
    if (event.args && typeof event.args === "object") {
      argsText = JSON.stringify(event.args, null, 2);
    } else if (event.argsRaw) {
      argsText = String(event.argsRaw);
    } else {
      argsText = "{}";
    }
    if (event.parseError) {
      argsText += "\n\n解析错误：" + event.parseError;
    }
    args.textContent = argsText;

    entry.appendChild(head);
    entry.appendChild(args);
    els.toolLog.appendChild(entry);
    els.toolLog.scrollTop = els.toolLog.scrollHeight;

    toolCallCount += 1;
    if (els.toolCount) els.toolCount.textContent = String(toolCallCount);

    toolEntries[event.id] = { entry: entry, status: status };
  }

  function addToolResultEvent(event) {
    if (!els.toolPanel || !els.toolLog) return;

    var record = toolEntries[event.id] || findLastPendingToolEntry();
    if (!record) {
      // 极端情况下先收到结果：补一个只有工具名和结果的最小条目
      addToolCallEvent({
        id: event.id,
        name: event.name,
        args: {},
        argsRaw: ""
      });
      record = toolEntries[event.id];
    }
    if (!record) return;

    record.status.className = "tool-status " + (event.ok ? "ok" : "fail");
    record.status.textContent = event.ok ? "成功" : "失败";

    var result = document.createElement("div");
    result.className = "tool-result " + (event.ok ? "ok" : "fail");
    result.textContent = event.summary || (event.ok ? "执行成功" : "执行失败");
    record.entry.appendChild(result);

    els.toolLog.scrollTop = els.toolLog.scrollHeight;
  }

  async function send() {
    if (busy) return;

    var text = els.input.value.trim();
    if (!text) {
      setStatus("先输入一句话再发送。", "warn");
      els.input.focus();
      return;
    }
    if (text.length > MAX_INPUT) {
      setStatus("单条消息最多 " + MAX_INPUT + " 字，请删减后再发。", "warn");
      return;
    }

    setStatus("");
    els.input.value = "";
    updateInputHint();

    appendMessage("user", text);
    history.push({ role: "user", content: text });
    updateBadge(lastMeta);
    saveChat();

    var assistant = appendMessage("assistant", "");
    assistant.row.classList.add("is-streaming");

    var assistantText = "";
    var streamError = null;
    var metaForTurn = null;
    var hadToolCall = false;

    controller = new AbortController();
    stopRequested = false;
    setBusy(true);

    try {
      var response = await fetch(apiBase + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: normalizeForRequest(history) }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new ChatError(await readErrorBody(response), "HTTP_" + response.status);
      }

      await consumeSse(response, function (event) {
        if (!event || typeof event !== "object") return;

        if (event.type === "meta") {
          metaForTurn = event;
          lastMeta = event;
          updateBadge(event);
          return;
        }

        if (event.type === "delta" && typeof event.text === "string") {
          if (!assistantText) assistant.textEl.textContent = "";
          assistantText += event.text;
          assistant.textEl.textContent = assistantText;
          scrollToBottom(true);
          return;
        }

        if (event.type === "tool_call") {
          hadToolCall = true;
          addToolCallEvent(event);
          setStatus("正在调用工具 " + (event.name || "") + "…", "warn");
          return;
        }

        if (event.type === "tool_result") {
          addToolResultEvent(event);
          setStatus(
            event.ok
              ? "工具执行成功，模型正在总结结果…"
              : "工具执行失败，模型正在处理错误…",
            event.ok ? "ok" : "warn"
          );
          return;
        }

        if (event.type === "error") {
          streamError = event;
        }
      });

      if (stopRequested) {
        throw new ChatError("已停止生成。", "STOPPED");
      }
      if (streamError) {
        throw new ChatError(streamError.msg || "模型返回错误。", streamError.code);
      }
      if (!assistantText) {
        if (hadToolCall) {
          assistantText = "工具已经执行完成，但模型没有返回自然语言总结。结果见上方工具日志。";
          assistant.textEl.textContent = assistantText;
        } else {
          throw new ChatError("模型没有返回任何文字，请重试一次。", "EMPTY");
        }
      }

      assistant.row.classList.remove("is-streaming");
      assistant.textEl.innerHTML = renderRich(assistantText);
      history.push({ role: "assistant", content: assistantText });
      lastMeta = metaForTurn || lastMeta;
      updateBadge(lastMeta);
      setStatus("");
      saveChat();
    } catch (err) {
      assistant.row.classList.remove("is-streaming");
      if (dropPendingUser()) lastMeta = null;

      if (stopRequested || (err && err.name === "AbortError")) {
        assistant.row.classList.add("has-error");
        if (!assistantText) {
          assistant.textEl.textContent = "已停止生成。";
        }
        addErrorNote(
          assistant.bubble,
          "已停止生成，本轮不会写入上下文。",
          "message-note"
        );
        setStatus("已停止生成。可以修改问题后重新发送。", "warn");
      } else {
        var message =
          err && err.message ? err.message : "请求失败，请检查后端是否启动。";
        assistant.row.classList.add("has-error");
        if (!assistantText) {
          assistant.textEl.textContent = "这一轮没有生成成功。";
        }
        addErrorNote(assistant.bubble, "⚠ " + message, "message-error");
        setStatus(message, "error");
      }
    } finally {
      controller = null;
      setBusy(false);
      updateBadge(lastMeta);
      els.input.focus();
    }
  }

  function stop() {
    if (!busy || !controller) return;
    stopRequested = true;
    els.stopBtn.disabled = true;
    setStatus("正在停止生成…", "warn");
    controller.abort();
  }

  function clearChat() {
    if (busy) return;

    history = [];
    lastMeta = null;
    try {
      sessionStorage.removeItem(CHAT_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* 忽略 */ }
    setStatus("");
    resetToolLog();
    while (els.window.children.length > 1) {
      els.window.removeChild(els.window.lastElementChild);
    }
    updateBadge(null);
    els.input.value = "";
    updateInputHint();
    autoGrow();
    els.input.focus();
  }

  els.sendBtn.addEventListener("click", send);
  els.stopBtn.addEventListener("click", stop);
  els.clearBtn.addEventListener("click", clearChat);

  if (els.toolToggle) {
    els.toolToggle.addEventListener("click", function () {
      var collapsed = els.toolToggle.getAttribute("aria-expanded") === "false";
      setToolPanelCollapsed(!collapsed);
    });
  }

  els.input.addEventListener("input", function () {
    updateInputHint();
    autoGrow();
    saveDraft();
  });
  els.input.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // 中文输入法选词时按 Enter 不应该发送
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  });

  restoreChat();
  updateBadge(lastMeta);
  restoreDraft();
  updateInputHint();
  autoGrow();
  els.input.focus();
})();
