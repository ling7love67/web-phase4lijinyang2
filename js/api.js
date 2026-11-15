/* ============================================================
 * 统一的请求封装
 * - 超时控制：后端没启动时不会一直转圈
 * - 错误归一：网络错误 / 超时 / 非 JSON / 业务 code 全都抛同一个 ApiError
 * - 页面只关心「成功的数据」或「一句人话的错误信息」
 * ============================================================ */
(function () {
  "use strict";

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "ApiError";
      this.status = status || 0;
    }
  }

  async function request(path, options) {
    options = options || {};
    const cfg = window.APP_CONFIG;
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, cfg.TIMEOUT);

    try {
      const res = await fetch(cfg.API_BASE + path, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });

      const text = await res.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (e) {
          throw new ApiError("接口返回的不是 JSON（HTTP " + res.status + "）", res.status);
        }
      }

      if (!res.ok || (body && typeof body.code === "number" && body.code !== 200)) {
        throw new ApiError(
          (body && body.msg) || "请求失败（HTTP " + res.status + "）",
          res.status
        );
      }
      return body ? body.data : null;
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new ApiError("请求超时（" + cfg.TIMEOUT / 1000 + " 秒），请确认后端已启动");
      }
      if (err instanceof ApiError) throw err;
      // fetch 直接 reject：断网、DNS 失败、被 CORS 拦截时都走这里
      throw new ApiError(
        "无法连接后端 " + cfg.API_BASE + "（" +
          (err && err.message ? err.message : "网络错误") + "）"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  window.api = {
    request: request,
    get: function (path) {
      return request(path);
    },
    post: function (path, body) {
      return request(path, { method: "POST", body: body });
    },
    del: function (path) {
      return request(path, { method: "DELETE" });
    }
  };

  // 页面里要拼 HTML 时统一走这里，避免把接口里的文字当标签执行
  window.escapeHtml = function (value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
})();
