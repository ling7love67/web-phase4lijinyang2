/* 任务清单：新增 / 勾选完成 / 删除，数据存 localStorage，刷新不丢 */
(function () {
  "use strict";

  var STORAGE_KEY = "node9.tasks.v1";

  var input = document.getElementById("taskInput");
  var addBtn = document.getElementById("addTaskBtn");
  var listEl = document.getElementById("taskList");
  var countEl = document.getElementById("taskCount");
  var clearDoneBtn = document.getElementById("clearDoneBtn");

  var tasks = readStorage();

  function readStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      // 隐私模式或数据被改坏时，退回空列表而不是整页报错
      return [];
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      /* 存不了就算了，页面还能继续用 */
    }
  }

  function emptyHtml() {
    return (
      '<div class="state empty">' +
        '<p class="state-title">还没有任务</p>' +
        '<p class="state-desc">在上面的输入框里写一条，回车或点「添加任务」即可。</p>' +
      "</div>"
    );
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = "";

    if (!tasks.length) {
      listEl.innerHTML = emptyHtml();
    } else {
      tasks.forEach(function (task, index) {
        var row = document.createElement("div");
        row.className = "task-item" + (task.done ? " done" : "");

        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!task.done;
        checkbox.setAttribute("aria-label", "标记任务完成");
        checkbox.addEventListener("change", function () {
          toggle(index);
        });

        var text = document.createElement("span");
        text.className = "task-text";
        text.textContent = task.text;

        var del = document.createElement("button");
        del.type = "button";
        del.className = "task-del";
        del.textContent = "删除";
        del.addEventListener("click", function () {
          remove(index);
        });

        row.appendChild(checkbox);
        row.appendChild(text);
        row.appendChild(del);
        listEl.appendChild(row);
      });
    }

    if (countEl) {
      var done = tasks.filter(function (t) { return t.done; }).length;
      countEl.textContent = "共 " + tasks.length + " 项，已完成 " + done + " 项";
    }
  }

  function addTask() {
    var value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }

    tasks.push({ id: Date.now(), text: value, done: false });
    input.value = "";
    input.focus();
    saveStorage();
    render();
  }

  function toggle(index) {
    if (!tasks[index]) return;
    tasks[index].done = !tasks[index].done;
    saveStorage();
    render();
  }

  function remove(index) {
    tasks.splice(index, 1);
    saveStorage();
    render();
  }

  if (addBtn) addBtn.addEventListener("click", addTask);

  if (input) {
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") addTask();
    });
  }

  if (clearDoneBtn) {
    clearDoneBtn.addEventListener("click", function () {
      tasks = tasks.filter(function (t) { return !t.done; });
      saveStorage();
      render();
    });
  }

  render();
})();
