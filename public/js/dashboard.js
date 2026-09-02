(() => {
  const state = {
    cases: [],
    email: null,
    suggestCaseNumber: null,
    refreshHandle: null,
    sortKey: "priority",
    sortDir: "asc",
    statusFilter: "",
    componentFilter: "",
  };

  const AUTO_REFRESH_MS = 5 * 60 * 1000;

  const LIGHTNING_CASE_BASE = "https://rubrikinc.lightning.force.com/lightning/r/Case";

  const el = (id) => document.getElementById(id);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      ...opts,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("not authenticated");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `request failed: ${res.status}`);
    }
    return res.json();
  }

  function showLogin() {
    el("loginScreen").classList.remove("d-none");
    el("app").classList.add("d-none");
    if (state.refreshHandle) clearInterval(state.refreshHandle);
    el("emailError").classList.add("d-none");
    el("emailInput").value = "";
  }

  function showApp(email) {
    state.email = email;
    el("usernameLabel").textContent = email;
    el("loginScreen").classList.add("d-none");
    el("app").classList.remove("d-none");
    loadAll();
    if (state.refreshHandle) clearInterval(state.refreshHandle);
    state.refreshHandle = setInterval(() => loadAll(true), AUTO_REFRESH_MS);
  }

  async function checkAuth() {
    const me = await api("/api/auth/me");
    if (me.authenticated) {
      showApp(me.email);
    } else {
      showLogin();
    }
  }

  // ---------- Login: email only ----------

  el("emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    el("emailError").classList.add("d-none");
    const email = el("emailInput").value.trim();
    if (!email) return;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("not authorized");
      const data = await res.json();
      showApp(data.email);
    } catch (err) {
      el("emailError").textContent = err.message || "Not authorized";
      el("emailError").classList.remove("d-none");
    }
  });

  el("logoutBtn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    showLogin();
  });

  el("refreshBtn").addEventListener("click", () => loadAll());

  function setRefreshing(on) {
    const icon = el("refreshBtn").querySelector("i");
    el("refreshBtn").disabled = on;
    if (icon) icon.classList.toggle("refresh-spin", on);
  }

  function formatClock(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  async function loadAll(auto = false) {
    setRefreshing(true);
    try {
      const casesRes = await api("/api/cases");
      state.cases = casesRes.cases;
      renderQueues();
      el("lastUpdated").textContent = `Updated ${formatClock(new Date())}${auto ? " (auto)" : ""}`;
    } catch (err) {
      console.error(err);
      el("lastUpdated").textContent = "Refresh failed";
    } finally {
      setRefreshing(false);
    }
  }

  // ---------- Queue rendering ----------

  const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2, P4: 3 };

  function priorityClass(priority) {
    const key = (priority || "").toUpperCase().replace(/\s+/g, "");
    return PRIORITY_ORDER.hasOwnProperty(key) ? key.toLowerCase() : "p4";
  }

  const COLUMNS = [
    { key: "caseNumber", label: "Case #" },
    { key: "priority", label: "Pri" },
    { key: null, label: "Subject" },
    { key: "status", label: "Status" },
    { key: "account", label: "Account" },
    { key: "contactName", label: "Contact" },
    { key: null, label: "Labels" },
    { key: "ncc", label: "NCC" },
    { key: "lastCustomerUpdate", label: "Last Cust. Update" },
    { key: "activeTtrDays", label: "Active TTR" },
    { key: "caseAgeDays", label: "Age" },
    { key: null, label: "Next Action" },
    { key: null, label: "" },
  ];

  function caseAgeDays(c) {
    return (Date.now() - new Date(c.createdDate).getTime()) / 86400000;
  }

  function sortValue(c, key) {
    switch (key) {
      case "priority":
        return PRIORITY_ORDER[priorityClass(c.priority).toUpperCase()] ?? 9;
      case "caseNumber":
        return c.caseNumber || "";
      case "status":
        return (c.status || "").toLowerCase();
      case "account":
        return (c.account || "").toLowerCase();
      case "contactName":
        return (c.contactName || "").toLowerCase();
      case "ncc":
        return c.ncc ? new Date(c.ncc).getTime() : Infinity;
      case "lastCustomerUpdate":
        return c.lastCustomerUpdate ? new Date(c.lastCustomerUpdate).getTime() : -Infinity;
      case "activeTtrDays":
        return c.activeTtrDays ?? -Infinity;
      case "caseAgeDays":
        return caseAgeDays(c);
      default:
        return 0;
    }
  }

  function compareCases(a, b) {
    const va = sortValue(a, state.sortKey);
    const vb = sortValue(b, state.sortKey);
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return state.sortDir === "asc" ? cmp : -cmp;
  }

  function onSortClick(key) {
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = "asc";
    }
    renderQueues();
  }

  function renderTableHeader() {
    const last = COLUMNS.length - 1;
    const ths = COLUMNS.map((c, idx) => {
      // Every column except the last gets a drag grip on its right edge.
      const grip = idx < last ? `<span class="col-resizer" data-col="${idx}"></span>` : "";
      if (!c.key) return `<th>${c.label}${grip}</th>`;
      const active = state.sortKey === c.key;
      const arrow = active ? (state.sortDir === "asc" ? "▲" : "▼") : "";
      return `<th class="sortable${active ? " sort-active" : ""}" data-sort-key="${c.key}">${c.label} <span class="sort-arrow">${arrow}</span>${grip}</th>`;
    }).join("");
    return `<tr>${ths}</tr>`;
  }

  function populateStatusFilter() {
    const select = el("statusFilter");
    const statuses = [...new Set(state.cases.map((c) => c.status).filter(Boolean))].sort();
    const current = state.statusFilter;
    select.innerHTML =
      `<option value="">All statuses</option>` +
      statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    if (statuses.includes(current)) select.value = current;
    else state.statusFilter = select.value = "";
  }

  function componentName(c) {
    return c.component || "Uncategorized";
  }

  function renderComponentChart() {
    const container = el("componentChart");
    const counts = new Map();
    for (const c of state.cases) {
      const name = componentName(c);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!rows.length) {
      container.innerHTML = `<div class="component-empty">No cases</div>`;
      return;
    }
    const max = rows[0][1];
    container.innerHTML = rows
      .map(([name, count]) => {
        const active = state.componentFilter === name;
        const pct = Math.max(6, Math.round((count / max) * 100));
        return `
          <button class="component-col${active ? " active" : ""}" data-component="${escapeHtml(name)}" title="${escapeHtml(name)} — ${count} case${count === 1 ? "" : "s"}">
            <span class="component-col-count">${count}</span>
            <span class="component-col-track"><span class="component-col-fill" style="height:${pct}%"></span></span>
            <span class="component-col-label">${escapeHtml(name)}</span>
          </button>`;
      })
      .join("");
    container.querySelectorAll(".component-col").forEach((col) => {
      col.addEventListener("click", () => {
        const name = col.dataset.component;
        state.componentFilter = state.componentFilter === name ? "" : name;
        renderQueues();
      });
    });
  }

  function renderQueues() {
    populateStatusFilter();
    renderComponentChart();

    if (!state.cases.length) {
      el("emptyQueueState").classList.remove("d-none");
      el("queueTableWrap").classList.add("d-none");
      el("queueCount").textContent = "";
      return;
    }

    const filtered = state.cases.filter(
      (c) =>
        (!state.statusFilter || c.status === state.statusFilter) &&
        (!state.componentFilter || componentName(c) === state.componentFilter)
    );

    if (!filtered.length) {
      el("emptyQueueState").classList.remove("d-none");
      el("emptyQueueState").querySelector("p").textContent = "No cases match this filter.";
      el("queueTableWrap").classList.add("d-none");
      el("queueCount").textContent = "0";
      return;
    }
    el("emptyQueueState").classList.add("d-none");
    el("queueTableWrap").classList.remove("d-none");
    el("queueCount").textContent = String(filtered.length);

    const cases = filtered.slice().sort(compareCases);

    renderColgroup();
    el("caseTableHead").innerHTML = renderTableHeader();
    const tbody = el("caseTableBody");
    tbody.innerHTML = "";
    for (const c of cases) {
      tbody.appendChild(renderCaseRow(c));
    }
    document.querySelectorAll("#caseTableHead .sortable").forEach((th) => {
      th.addEventListener("click", () => onSortClick(th.dataset.sortKey));
    });
    attachColResizers();
  }

  el("statusFilter").addEventListener("change", (e) => {
    state.statusFilter = e.target.value;
    renderQueues();
  });

  function formatDuration(days) {
    if (days === null || days === undefined || Number.isNaN(days)) return "—";
    if (days < 1) return `${Math.max(0, Math.round(days * 24))}h`;
    return `${days.toFixed(1)}d`;
  }

  function formatDaysAgo(days) {
    if (days < 1) return `${Math.max(0, Math.round(days * 24))}h ago`;
    return `${days.toFixed(1)}d ago`;
  }

  function formatNcc(iso) {
    if (!iso) return { text: "—", cls: "" };
    const diffMs = new Date(iso).getTime() - Date.now();
    const overdue = diffMs < 0;
    const abs = Math.abs(diffMs);
    const label = abs >= 86400000 ? `${(abs / 86400000).toFixed(1)}d` : `${Math.round(abs / 3600000)}h`;
    return overdue ? { text: `Overdue ${label}`, cls: "ncc-overdue" } : { text: `in ${label}`, cls: "ncc-upcoming" };
  }

  function renderLabels(raw) {
    if (!raw) return "—";
    const tags = raw.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean);
    if (!tags.length) return "—";
    return tags.map((t) => `<span class="label-pill">${escapeHtml(t)}</span>`).join("");
  }

  function renderCaseRow(c) {
    const pClass = priorityClass(c.priority);
    const tr = document.createElement("tr");
    tr.className = `case-row priority-${pClass}`;
    tr.dataset.caseNumber = c.caseNumber;

    const ncc = formatNcc(c.ncc);
    const age = caseAgeDays(c);
    const lastUpdateDays = c.lastCustomerUpdate ? (Date.now() - new Date(c.lastCustomerUpdate).getTime()) / 86400000 : null;

    const caseUrl = c.id ? `${LIGHTNING_CASE_BASE}/${encodeURIComponent(c.id)}/view` : null;

    tr.innerHTML = `
      <td>
        ${caseUrl
          ? `<a class="case-number-link" href="${caseUrl}" target="_blank" rel="noopener">${escapeHtml(c.caseNumber)}</a>`
          : `<span class="case-number-link">${escapeHtml(c.caseNumber)}</span>`}
        ${c.isEscalated ? '<i class="bi bi-exclamation-triangle-fill escalated-flag" title="Escalated"></i>' : ""}
      </td>
      <td><span class="priority-badge priority-${pClass}">${escapeHtml(c.priority || "P4")}</span></td>
      <td class="col-subject">${caseUrl
        ? `<a class="case-subject-link" href="${caseUrl}" target="_blank" rel="noopener">${escapeHtml(c.subject || "(no subject)")}</a>`
        : escapeHtml(c.subject || "(no subject)")}</td>
      <td>${escapeHtml(c.status)}</td>
      <td>${escapeHtml(c.account || "—")}</td>
      <td>${escapeHtml(c.contactName || "—")}</td>
      <td>${renderLabels(c.labels)}</td>
      <td class="${ncc.cls}">${ncc.text}</td>
      <td>${lastUpdateDays === null ? "—" : formatDaysAgo(lastUpdateDays)}</td>
      <td>${formatDuration(c.activeTtrDays)}</td>
      <td>${formatDuration(age)}</td>
      <td class="next-action-cell">${renderNextAction(c.nextAction)}</td>
      <td>
        <button class="btn btn-sm btn-outline-secondary suggest-reply-btn" title="Suggest Reply">
          <i class="bi bi-magic"></i>
        </button>
      </td>
    `;

    tr.querySelector(".suggest-reply-btn").addEventListener("click", () => openSuggestModal(c.caseNumber));
    return tr;
  }

  function renderNextAction(na) {
    if (!na) return "—";
    return `<span class="next-action next-action-${escapeHtml(na.kind)}">${escapeHtml(na.label)}</span><span class="next-action-reason">${escapeHtml(na.reason)}</span>`;
  }

  function scrollToCase(caseNumber) {
    const rowEl = document.querySelector(`.case-row[data-case-number="${CSS.escape(caseNumber)}"]`);
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
      rowEl.classList.add("row-highlight");
      setTimeout(() => rowEl.classList.remove("row-highlight"), 1500);
    }
  }

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => el(btn.dataset.close).classList.add("d-none"));
  });

  // ---------- Case search ----------

  let searchDebounce = null;
  el("caseSearchInput").addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    if (!q) {
      el("caseSearchResults").classList.add("d-none");
      return;
    }
    searchDebounce = setTimeout(() => runCaseSearch(q), 250);
  });

  async function runCaseSearch(q) {
    try {
      const data = await api(`/api/cases/search?q=${encodeURIComponent(q)}`);
      const results = el("caseSearchResults");
      if (!data.cases.length) {
        results.innerHTML = `<div class="case-search-empty">No matches</div>`;
      } else {
        results.innerHTML = data.cases
          .map(
            (c) => `
          <div class="case-search-result-item" data-case="${escapeHtml(c.caseNumber)}">
            <span class="cnum">${escapeHtml(c.caseNumber)}</span>${escapeHtml(c.subject || "")}
          </div>`
          )
          .join("");
        results.querySelectorAll(".case-search-result-item").forEach((item) => {
          item.addEventListener("click", () => {
            results.classList.add("d-none");
            el("caseSearchInput").value = "";
            scrollToCase(item.dataset.case);
          });
        });
      }
      results.classList.remove("d-none");
    } catch (err) {
      console.error(err);
    }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".case-search-box")) {
      el("caseSearchResults").classList.add("d-none");
    }
  });

  // ---------- Suggest Reply ----------

  const SCAN_STEPS = ["history", "email", "criteria", "draft", "selfcheck"];
  // Snapshot the scan-panel markup once so we can restore it on every open
  // (an error previously replaced it with a message and never put it back).
  const SCAN_PANEL_HTML = el("scanPanel").innerHTML;

  async function openSuggestModal(caseNumber, regenerate = false) {
    state.suggestCaseNumber = caseNumber;
    el("suggestCaseNumber").textContent = caseNumber;
    el("suggestModal").classList.remove("d-none");
    el("draftPanel").classList.add("d-none");
    el("regenerateBtn").classList.add("d-none");
    el("copyDraftBtn").classList.add("d-none");
    el("scanPanel").classList.remove("d-none");
    el("scanPanel").innerHTML = SCAN_PANEL_HTML;
    SCAN_STEPS.forEach((s) => {
      const stepEl = document.querySelector(`.scan-step[data-step="${s}"]`);
      if (stepEl) stepEl.classList.remove("active", "done");
    });

    // Wrap so the animation can await the settled result without throwing.
    const fetchPromise = api("/api/intelligence/suggest-reply", {
      method: "POST",
      body: JSON.stringify({ case_number: caseNumber, regenerate }),
    }).then((data) => ({ ok: true, data })).catch((err) => ({ ok: false, err }));

    const result = await runScanAnimation(fetchPromise);

    if (result.ok) {
      showDraft(result.data);
    } else {
      el("scanPanel").innerHTML = `<div class="text-danger small">${escapeHtml(result.err.message)}</div>`;
    }
  }

  // Steps light up in sequence; the final step keeps spinning until the real
  // response arrives, so the panel never freezes on a blank/all-done state.
  function runScanAnimation(fetchPromise) {
    return new Promise((resolve) => {
      const steps = SCAN_STEPS.map((s) => document.querySelector(`.scan-step[data-step="${s}"]`));
      const stepDelay = 460;
      const lastIdx = steps.length - 1;
      let settled = null;
      let done = false;
      fetchPromise.then((r) => { settled = r; done = true; });

      let i = 0;
      function advance() {
        if (i > 0 && steps[i - 1]) {
          steps[i - 1].classList.remove("active");
          steps[i - 1].classList.add("done");
        }
        if (steps[i]) steps[i].classList.add("active");
        if (i < lastIdx) {
          i++;
          setTimeout(advance, stepDelay);
        } else {
          waitForResponse(); // hold last step spinning
        }
      }
      function waitForResponse() {
        if (done) {
          if (steps[lastIdx]) {
            steps[lastIdx].classList.remove("active");
            steps[lastIdx].classList.add("done");
          }
          resolve(settled);
        } else {
          setTimeout(waitForResponse, 150);
        }
      }
      advance();
    });
  }

  function showDraft(data) {
    el("scanPanel").classList.add("d-none");
    el("draftPanel").classList.remove("d-none");
    el("draftText").value = data.draft;

    const badge = el("draftKeywordBadge");
    if (data.keyword) {
      badge.textContent = data.keyword;
      badge.classList.remove("d-none");
    } else {
      badge.classList.add("d-none");
    }

    const noteBlock = el("internalNoteBlock");
    if (data.internalNote) {
      el("internalNoteText").value = data.internalNote;
      noteBlock.classList.remove("d-none");
    } else {
      noteBlock.classList.add("d-none");
    }

    const checkBlock = el("selfCheckBlock");
    if (data.selfCheck) {
      el("selfCheckText").textContent = data.selfCheck;
      checkBlock.classList.remove("d-none");
    } else {
      checkBlock.classList.add("d-none");
    }

    el("draftMeta").textContent = "Draft only — review and send manually. Never sent automatically.";
    el("regenerateBtn").classList.remove("d-none");
    el("copyDraftBtn").classList.remove("d-none");
  }

  el("regenerateBtn").addEventListener("click", () => {
    if (state.suggestCaseNumber) openSuggestModal(state.suggestCaseNumber, true);
  });

  // Resolve the Salesforce Lightning URL for the case currently in the modal.
  function suggestCaseUrl() {
    const c = state.cases.find((x) => x.caseNumber === state.suggestCaseNumber);
    return c && c.id ? `${LIGHTNING_CASE_BASE}/${encodeURIComponent(c.id)}/view` : null;
  }

  // Copy synchronously via execCommand so it works over plain HTTP, where the
  // async Clipboard API is unavailable (non-secure context). Falls back to the
  // Clipboard API as a best-effort when execCommand is blocked.
  function copyDraftSync() {
    const ta = el("draftText");
    let ok = false;
    try {
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch (e) {
      ok = false;
    }
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(ta.value).catch(() => {});
    }
    return ok;
  }

  el("copyDraftBtn").addEventListener("click", () => {
    // Copy BEFORE opening the tab — window.open shifts focus and would break
    // the synchronous copy.
    const ok = copyDraftSync();
    const url = suggestCaseUrl();
    if (url) window.open(url, "_blank", "noopener");

    const btn = el("copyDraftBtn");
    const original = btn.innerHTML;
    btn.innerHTML = ok
      ? `<i class="bi bi-check2"></i> Copied — paste into case`
      : `<i class="bi bi-clipboard"></i> Select &amp; copy manually`;
    setTimeout(() => (btn.innerHTML = original), 2200);
  });

  // ---------- Utils ----------

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Theme toggle (light / dark) ----------
  // The anti-flash inline script in dashboard.html has already applied the
  // saved theme to <body> before first paint; here we just sync the icon and
  // handle toggling.

  const THEME_KEY = "qview-theme";

  function isDark() {
    return document.body.classList.contains("dark");
  }

  function syncThemeToggle() {
    const btn = el("themeToggle");
    if (!btn) return;
    const icon = btn.querySelector("i");
    const dark = isDark();
    if (icon) icon.className = dark ? "bi bi-sun-fill" : "bi bi-moon-stars";
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", btn.title);
  }

  function toggleTheme() {
    const dark = !isDark();
    document.body.classList.toggle("dark", dark);
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) { /* ignore */ }
    syncThemeToggle();
  }

  (function initTheme() {
    const btn = el("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", toggleTheme);
    syncThemeToggle();
  })();

  // ---------- Component chart resize persistence ----------
  // The chart uses native CSS `resize: both`; we persist the user-chosen size
  // and only write it back on an actual drag (never on window/layout reflow,
  // which would otherwise freeze the auto width).

  const CHART_SIZE_KEY = "qview-chart-size";

  (function initChartResize() {
    const chart = document.querySelector(".component-chart");
    if (!chart) return;

    try {
      const saved = JSON.parse(localStorage.getItem(CHART_SIZE_KEY) || "null");
      if (saved) {
        if (saved.w) chart.style.width = saved.w + "px";
        if (saved.h) chart.style.height = saved.h + "px";
      }
    } catch (e) { /* ignore corrupt value */ }

    let dragging = false;
    chart.addEventListener("pointerdown", (e) => {
      // Native resize grip lives in the bottom-right ~18px corner.
      const r = chart.getBoundingClientRect();
      if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) dragging = true;
    });
    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      const r = chart.getBoundingClientRect();
      try {
        localStorage.setItem(CHART_SIZE_KEY, JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
      } catch (e) { /* ignore */ }
    });
  })();

  // ---------- Case table column resize ----------
  // Widths (px) are keyed by COLUMNS index and applied through the <colgroup>,
  // which is authoritative under `table-layout: fixed`.

  const COL_WIDTH_KEY = "qview-col-widths";
  const DEFAULT_COL_WIDTHS = [110, 62, 300, 130, 180, 150, 150, 110, 140, 100, 84, 220, 56];
  const MIN_COL_WIDTH = 48;

  function loadColWidths() {
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || "null");
      if (Array.isArray(saved) && saved.length === DEFAULT_COL_WIDTHS.length) {
        return saved.map((w, i) => (Number.isFinite(w) && w >= MIN_COL_WIDTH ? w : DEFAULT_COL_WIDTHS[i]));
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_COL_WIDTHS.slice();
  }

  let colWidths = loadColWidths();

  function saveColWidths() {
    try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(colWidths)); } catch (e) { /* ignore */ }
  }

  function renderColgroup() {
    const cg = el("caseTableColgroup");
    if (!cg) return;
    cg.innerHTML = colWidths.map((w) => `<col style="width:${w}px">`).join("");
  }

  let colResize = null;

  function onColResizeMove(e) {
    if (!colResize) return;
    const delta = e.clientX - colResize.startX;
    colWidths[colResize.idx] = Math.round(Math.max(MIN_COL_WIDTH, colResize.startW + delta));
    renderColgroup();
  }

  function onColResizeEnd() {
    if (!colResize) return;
    if (colResize.grip) colResize.grip.classList.remove("resizing");
    document.body.classList.remove("resizing-col");
    window.removeEventListener("mousemove", onColResizeMove);
    window.removeEventListener("mouseup", onColResizeEnd);
    colResize = null;
    saveColWidths();
  }

  function startColResize(e) {
    const grip = e.currentTarget;
    const idx = parseInt(grip.dataset.col, 10);
    if (Number.isNaN(idx)) return;
    e.preventDefault();
    e.stopPropagation(); // don't trigger the column's sort handler
    colResize = { idx, startX: e.clientX, startW: colWidths[idx], grip };
    grip.classList.add("resizing");
    document.body.classList.add("resizing-col");
    window.addEventListener("mousemove", onColResizeMove);
    window.addEventListener("mouseup", onColResizeEnd);
  }

  function attachColResizers() {
    document.querySelectorAll("#caseTableHead .col-resizer").forEach((grip) => {
      grip.addEventListener("mousedown", startColResize);
      // A click that bubbles to the <th> would toggle sorting — swallow it.
      grip.addEventListener("click", (e) => e.stopPropagation());
    });
  }

  checkAuth();
})();
