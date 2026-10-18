// Themed dropdowns. The native <select> stays in the page, hidden, as the
// source of truth: app.js keeps reading and setting .value and listening for
// "change". A button and a listbox drawn in the app's own style sit on top,
// because the Windows popup of a native select ignores the app's theme.
//
// The pure helpers at the top are exported for the unit tests (Node); the
// DOM part only runs in the browser.

// Index of the next enabled option from `from` in direction `step` (+1/-1),
// clamped at the ends; -1 when nothing is enabled.
function nextEnabledIndex(options, from, step) {
  const n = options.length;
  if (!n) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i += step;
    if (i < 0 || i >= n) return firstEnabled(options, step > 0 ? n - 1 : 0, -step, from);
    if (!options[i].disabled) return i;
  }
  return from;
}

function firstEnabled(options, start, step, fallback) {
  for (let i = start; i >= 0 && i < options.length; i += step) {
    if (!options[i].disabled) return i;
  }
  return fallback;
}

// Type-ahead: the first enabled option after `from` whose label starts with
// `query` (case-insensitive), wrapping around; -1 when none matches.
function typeaheadIndex(options, from, query) {
  const q = String(query || "").toLowerCase();
  if (!q) return -1;
  const n = options.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const o = options[i];
    if (!o.disabled && o.label.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

if (typeof module !== "undefined") {
  module.exports = { nextEnabledIndex, typeaheadIndex };
}

if (typeof document !== "undefined") {
  (() => {
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    const nativeIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
    let openMenu = null; // the one menu that is open

    function enhance(select) {
      if (select.dataset.enhanced) return;
      select.dataset.enhanced = "1";

      // The button takes over the select's classes, so it keeps the look and
      // size the stylesheets give that field (sort-select, form-control ...).
      const look = select.className || "form-control";
      const wrap = document.createElement("div");
      wrap.className = "select-menu";
      select.parentNode.insertBefore(wrap, select);
      wrap.appendChild(select);
      select.className = "select-native";
      select.tabIndex = -1;
      select.setAttribute("aria-hidden", "true");

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = `${look} select-trigger`;
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      trigger.innerHTML = '<span class="select-value"></span><i class="fas fa-chevron-down select-chevron" aria-hidden="true"></i>';
      wrap.appendChild(trigger);
      const valueEl = trigger.querySelector(".select-value");

      const list = document.createElement("ul");
      list.className = "select-list";
      list.setAttribute("role", "listbox");
      list.tabIndex = -1;
      list.hidden = true;
      document.body.appendChild(list);

      // Accessible name: the select's own aria-label or its <label for>.
      const label = select.id && document.querySelector(`label[for="${select.id}"]`);
      if (select.getAttribute("aria-label")) trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
      else if (label) {
        if (!label.id) label.id = `${select.id}Label`;
        trigger.setAttribute("aria-labelledby", `${label.id} ${select.id}Value`);
        valueEl.id = `${select.id}Value`;
        label.addEventListener("click", (e) => {
          e.preventDefault();
          trigger.focus();
        });
      }
      if (select.id) list.id = `${select.id}List`;
      trigger.setAttribute("aria-controls", list.id || "");

      let active = -1;
      let typed = "";
      let typedTimer = null;

      const opts = () => [...select.options].map((o) => ({ label: o.textContent, value: o.value, disabled: o.disabled }));

      function sync() {
        const o = select.options[nativeIndex.get.call(select)];
        const placeholder = !o || (o.disabled && o.value === "");
        valueEl.textContent = o ? o.textContent : "";
        trigger.classList.toggle("is-placeholder", placeholder);
        trigger.disabled = select.disabled;
        if (!list.hidden) renderList();
      }

      function renderList() {
        const current = nativeIndex.get.call(select);
        list.innerHTML = "";
        opts().forEach((o, i) => {
          // A disabled empty option is the "Select region..." placeholder.
          if (o.disabled && o.value === "") return;
          const li = document.createElement("li");
          li.className = "select-option";
          li.setAttribute("role", "option");
          li.id = `${list.id || "select"}-opt-${i}`;
          li.dataset.index = String(i);
          li.textContent = o.label;
          li.setAttribute("aria-selected", String(i === current));
          if (o.disabled) li.setAttribute("aria-disabled", "true");
          if (i === current) li.classList.add("is-selected");
          if (i === active) li.classList.add("is-active");
          list.appendChild(li);
        });
        const activeEl = list.querySelector(".is-active");
        if (activeEl) {
          list.setAttribute("aria-activedescendant", activeEl.id);
          activeEl.scrollIntoView({ block: "nearest" });
        } else list.removeAttribute("aria-activedescendant");
      }

      function position() {
        const r = trigger.getBoundingClientRect();
        const below = window.innerHeight - r.bottom - 8;
        const above = r.top - 8;
        list.style.minWidth = `${r.width}px`;
        list.style.left = `${Math.min(r.left, window.innerWidth - list.offsetWidth - 8)}px`;
        const up = below < Math.min(list.scrollHeight, 240) && above > below;
        list.style.maxHeight = `${Math.max(120, Math.min(280, up ? above : below))}px`;
        list.style.top = up ? "" : `${r.bottom + 4}px`;
        list.style.bottom = up ? `${window.innerHeight - r.top + 4}px` : "";
        list.classList.toggle("opens-up", up);
      }

      function open() {
        if (select.disabled || !list.hidden) return;
        if (openMenu) openMenu.close(false);
        active = nativeIndex.get.call(select);
        if (active < 0 || select.options[active]?.disabled) active = nextEnabledIndex(opts(), -1, 1);
        renderList();
        list.hidden = false;
        position();
        trigger.setAttribute("aria-expanded", "true");
        wrap.classList.add("is-open");
        openMenu = { close, list, wrap };
        list.focus({ preventScroll: true });
      }

      function close(focusTrigger = true) {
        if (list.hidden) return;
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        wrap.classList.remove("is-open");
        if (openMenu?.list === list) openMenu = null;
        if (focusTrigger) trigger.focus({ preventScroll: true });
      }

      function choose(i) {
        const o = select.options[i];
        if (!o || o.disabled) return;
        const changed = nativeIndex.get.call(select) !== i;
        nativeIndex.set.call(select, i);
        sync();
        close();
        if (changed) {
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }

      function onTypeahead(key) {
        clearTimeout(typedTimer);
        typed += key;
        typedTimer = setTimeout(() => (typed = ""), 600);
        const i = typeaheadIndex(opts(), typed.length > 1 ? active - 1 : active, typed);
        if (i >= 0) {
          active = i;
          renderList();
        }
      }

      trigger.addEventListener("click", () => (list.hidden ? open() : close()));
      trigger.addEventListener("keydown", (e) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
          e.preventDefault();
          open();
        }
      });

      list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the list
      list.addEventListener("click", (e) => {
        const li = e.target.closest(".select-option");
        if (li && li.getAttribute("aria-disabled") !== "true") choose(Number(li.dataset.index));
      });
      list.addEventListener("mousemove", (e) => {
        const li = e.target.closest(".select-option");
        if (li && Number(li.dataset.index) !== active) {
          active = Number(li.dataset.index);
          list.querySelectorAll(".is-active").forEach((el) => el.classList.remove("is-active"));
          li.classList.add("is-active");
        }
      });
      list.addEventListener("keydown", (e) => {
        const o = opts();
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          active = nextEnabledIndex(o, active, e.key === "ArrowDown" ? 1 : -1);
          renderList();
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          active = e.key === "Home" ? nextEnabledIndex(o, -1, 1) : nextEnabledIndex(o, o.length, -1);
          renderList();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          choose(active);
        } else if (e.key === "Escape") {
          // Handled here: the app's Escape (close dialog or form) must not run too.
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "Tab") {
          close(false);
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          onTypeahead(e.key);
        }
      });

      // app.js sets .value / .selectedIndex directly and fills options with
      // innerHTML; keep the button in step with both.
      Object.defineProperty(select, "value", {
        configurable: true,
        get() { return nativeValue.get.call(this); },
        set(v) { nativeValue.set.call(this, v); sync(); },
      });
      Object.defineProperty(select, "selectedIndex", {
        configurable: true,
        get() { return nativeIndex.get.call(this); },
        set(v) { nativeIndex.set.call(this, v); sync(); },
      });
      new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
      select.addEventListener("change", sync);
      sync();
    }

    // Close on a click elsewhere, and when the page scrolls or resizes under it.
    document.addEventListener("mousedown", (e) => {
      if (openMenu && !openMenu.list.contains(e.target) && !openMenu.wrap.contains(e.target)) openMenu.close(false);
    });
    window.addEventListener("resize", () => openMenu?.close(false));
    document.addEventListener("scroll", (e) => {
      if (openMenu && !openMenu.list.contains(e.target)) openMenu.close(false);
    }, true);

    document.querySelectorAll("select").forEach(enhance);
    window.enhanceSelect = enhance;
  })();
}
