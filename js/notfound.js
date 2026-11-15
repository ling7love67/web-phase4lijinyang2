/* 404 页面：把用户访问的错误路径回显出来 */
(function () {
  "use strict";
  var el = document.getElementById("missing-path");
  if (el) {
    el.textContent =
      location.pathname + location.search + location.hash;
  }
})();
