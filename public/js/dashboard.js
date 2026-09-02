(() => {
  "use strict";

  const state = {
    cases: [],
    email: null,
    refreshHandle: null,
    sortKey: "priority",
    sortDir: 1, // 1 = ascending, -1 = descending
    search: "",
    componentFilter: "",
    tab: "cases",
    suggestCaseNumber: null,
    draftGen: 0,
  };

  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const LIGHTNING_CASE_BASE = "https://rubrikinc.lightning.force.com/lightning/r/Case";
  const IDLE_THRESHOLD_DAYS = 5;
  const CASE_COLUMN_COUNT = 12;

  const el = (id) => document.getElementById(id);

  // ---------- Theme ----------
  // The <head> script only sets data-preload-theme on <html> (body does not
  // exist that early). body.dark is the single source of truth for the CSS,
  // so mirror the stored value onto <body> as soon as this script runs.

  const THEME_KEY = "qview-theme";

  function readStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function isDark() {
    return document.body.classList.contains("dark");
  }

  function applyTheme(dark) {
    document.body.classList.toggle("dark", dark);
    document.documentElement.toggleAttribute("data-preload-theme", false);
    if (dark) document.documentElement.setAttribute("data-preload-theme", "dark");
    const btn = el("themeToggle");
    if (btn) {
      btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
      btn.setAttribute("aria-label", btn.title);
    }
  }

  applyTheme(readStoredTheme() === "dark");

  el("themeToggle").addEventListener("click", () => {
    const dark = !isDark();
    applyTheme(dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch (e) {
      /* ignore */
    }
  });

  // ---------- API ----------

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

  // ---------- Auth ----------

  function showLogin() {
    el("loginScreen").classList.remove("hidden");
    el("app").classList.add("hidden");
    if (state.refreshHandle) clearInterval(state.refreshHandle);
    state.refreshHandle = null;
    el("emailError").classList.add("hidden");
    el("emailInput").value = "";
  }

  function showApp(email) {
    state.email = email;
    el("usernameLabel").textContent = email;
    el("loginScreen").classList.add("hidden");
    el("app").classList.remove("hidden");
    loadAll();
    if (state.refreshHandle) clearInterval(state.refreshHandle);
    state.refreshHandle = setInterval(() => loadAll(true), AUTO_REFRESH_MS);
  }

  async function checkAuth() {
    try {
      const me = await api("/api/auth/me");
      if (me.authenticated) showApp(me.email);
      else showLogin();
    } catch (e) {
      showLogin();
    }
  }

  el("emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    el("emailError").classList.add("hidden");
    const email = el("emailInput").value.trim();
    if (!email) return;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("Not authorized");
      const data = await res.json();
      showApp(data.email);
    } catch (err) {
      el("emailError").textContent = err.message || "Not authorized";
      el("emailError").classList.remove("hidden");
    }
  });

  el("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch (e) {
      /* the 401 path already sends us to the login screen */
    }
    showLogin();
  });

  // ---------- Refresh ----------

  function formatClock(d) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  let refreshResetTimer = null;

  function setRefreshState(kind) {
    const btn = el("refreshBtn");
    clearTimeout(refreshResetTimer);
    btn.classList.remove("spinning", "success", "error");
    if (kind === "busy") {
      btn.disabled = true;
      btn.classList.add("spinning");
      return;
    }
    btn.classList.add(kind === "ok" ? "success" : "error");
    refreshResetTimer = setTimeout(() => {
      btn.classList.remove("success", "error");
      btn.disabled = false;
    }, 700);
  }

  el("refreshBtn").addEventListener("click", () => loadAll());

  async function loadAll(auto = false) {
    setRefreshState("busy");
    try {
      const res = await api("/api/cases");
      state.cases = res.cases || [];
      render();
      el("syncPill").textContent = `Updated ${formatClock(new Date())}${auto ? " · auto" : ""}`;
      setRefreshState("ok");
    } catch (err) {
      console.error(err);
      el("syncPill").textContent = "Refresh failed";
      setRefreshState("err");
    }
  }

  // ---------- Tabs ----------

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `tab-${tab}`);
    });
  }

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // ---------- Search ----------

  el("searchInput").addEventListener("input", (e) => {
    // A leading "#" is how case numbers get typed in chat; strip it so
    // "#01234567" and "01234567" both match.
    state.search = e.target.value.trim().toLowerCase().replace(/^#/, "");
    render();
  });

  // ---------- Derived values ----------

  const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2, P4: 3 };

  // Salesforce status strings vary in wording; rank them by how much they
  // demand attention rather than alphabetically.
  const STATUS_RANK = [
    [/escalat/i, 0],
    [/pending\s*eng/i, 1],
    [/waiting.*rubrik|pending\s*rubrik/i, 2],
    [/in\s*progress/i, 3],
    [/pending\s*fix/i, 4],
    [/new/i, 5],
    [/open/i, 6],
    [/waiting.*customer|pending\s*customer/i, 7],
    [/resolved/i, 8],
    [/closed/i, 9],
  ];

  function priorityKey(priority) {
    const key = (priority || "").toUpperCase().replace(/\s+/g, "");
    return PRIORITY_RANK.hasOwnProperty(key) ? key : "P4";
  }

  function priorityRank(priority) {
    return PRIORITY_RANK[priorityKey(priority)] ?? 9;
  }

  function statusRank(status) {
    const s = status || "";
    for (const [re, rank] of STATUS_RANK) if (re.test(s)) return rank;
    return 20;
  }

  function statusClass(status) {
    const slug = (status || "unknown")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `status-${slug}`;
  }

  function componentName(c) {
    return c.component || "Uncategorized";
  }

  function daysSince(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return (Date.now() - t) / 86400000;
  }

  function nccOverdue(c) {
    if (!c.ncc) return false;
    const t = new Date(c.ncc).getTime();
    return Number.isFinite(t) && t < Date.now();
  }

  function isClosed(c) {
    return /closed/i.test(c.status || "");
  }

  const NEXT_ACTION_RANK = { work: 0, followup: 1, closure: 2 };

  const SORT_KEYS = {
    caseNumber: (c) => c.caseNumber || "",
    priority: (c) => priorityRank(c.priority),
    status: (c) => statusRank(c.status),
    account: (c) => (c.account || "").toLowerCase(),
    subject: (c) => (c.subject || "").toLowerCase(),
    contactName: (c) => (c.contactName || "").toLowerCase(),
    createdDate: (c) => (c.createdDate ? new Date(c.createdDate).getTime() : Infinity),
    lastCustomerUpdate: (c) =>
      c.lastCustomerUpdate ? new Date(c.lastCustomerUpdate).getTime() : Infinity,
    activeTtrDays: (c) => (typeof c.activeTtrDays === "number" ? -c.activeTtrDays : Infinity),
    component: (c) => componentName(c).toLowerCase(),
    nextAction: (c) => (c.nextAction ? NEXT_ACTION_RANK[c.nextAction.kind] ?? 5 : 9),
  };

  function compareCases(a, b) {
    const accessor = SORT_KEYS[state.sortKey] || SORT_KEYS.priority;
    const va = accessor(a);
    const vb = accessor(b);
    let cmp;
    if (typeof va === "string" || typeof vb === "string") cmp = String(va).localeCompare(String(vb));
    else cmp = va - vb;
    if (cmp === 0) cmp = (a.caseNumber || "").localeCompare(b.caseNumber || "");
    return cmp * state.sortDir;
  }

  document.querySelectorAll(".case-table thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = 1;
      }
      render();
    });
  });

  function syncSortIndicators() {
    document.querySelectorAll(".case-table thead th[data-sort]").forEach((th) => {
      const active = th.dataset.sort === state.sortKey;
      th.classList.toggle("sort-asc", active && state.sortDir === 1);
      th.classList.toggle("sort-desc", active && state.sortDir === -1);
    });
  }

  // ---------- Formatting ----------

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDuration(days) {
    if (days === null || days === undefined || Number.isNaN(days)) return "—";
    if (days < 1) return `${Math.max(0, Math.round(days * 24))}h`;
    return `${days.toFixed(1)}d`;
  }

  function formatDaysAgo(days) {
    if (days === null) return "—";
    if (days < 1) return `${Math.max(0, Math.round(days * 24))}h ago`;
    return `${days.toFixed(1)}d ago`;
  }

  function formatOpened(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
  }

  const TRUNCATE_AT = 46;

  // Case Desk's truncation pattern: the full value rides along in data-full so
  // CSS can surface it as a tooltip on the ellipsis.
  function truncated(value) {
    const full = value || "";
    if (!full) return "—";
    if (full.length <= TRUNCATE_AT) return escapeHtml(full);
    return `<span class="note-wrap" data-full="${escapeHtml(full)}"><span class="note-text">${escapeHtml(
      full.slice(0, TRUNCATE_AT)
    )}</span><span class="note-dots">…</span></span>`;
  }

  function caseUrl(c) {
    return c.id ? `${LIGHTNING_CASE_BASE}/${encodeURIComponent(c.id)}/view` : null;
  }

  // ---------- Filtering ----------

  function visibleCases() {
    return state.cases.filter((c) => {
      if (state.componentFilter && componentName(c) !== state.componentFilter) return false;
      if (!state.search) return true;
      const hay = [c.caseNumber, c.account, c.subject].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(state.search);
    });
  }

  // ---------- Render ----------

  function render() {
    syncSortIndicators();
    const rows = visibleCases().slice().sort(compareCases);
    renderBanners();
    renderStats(rows);
    renderTable(rows);
    renderFilterNote();
    renderComponentTab();
  }

  function renderBanners() {
    const active = state.cases.filter((c) => !isClosed(c));

    const p1 = active.filter((c) => priorityKey(c.priority) === "P1");
    const p1Banner = el("p1Banner");
    if (p1.length) {
      el("p1BannerText").innerHTML =
        `${p1.length} active P1 case${p1.length === 1 ? "" : "s"} in your queue: ` +
        p1
          .map(
            (c) =>
              `<a href="#" data-jump="${escapeHtml(c.caseNumber)}">#${escapeHtml(c.caseNumber)}</a>`
          )
          .join(", ");
      p1Banner.hidden = false;
    } else {
      p1Banner.hidden = true;
    }

    const idle = active.filter((c) => {
      const d = daysSince(c.lastCustomerUpdate);
      return d !== null && d > IDLE_THRESHOLD_DAYS;
    });
    const idleBanner = el("idleBanner");
    if (idle.length) {
      el("idleBannerText").innerHTML =
        `${idle.length} case${idle.length === 1 ? "" : "s"} with no customer update in over ${IDLE_THRESHOLD_DAYS} days: ` +
        idle
          .slice(0, 8)
          .map(
            (c) =>
              `<a href="#" data-jump="${escapeHtml(c.caseNumber)}">#${escapeHtml(c.caseNumber)}</a>`
          )
          .join(", ") +
        (idle.length > 8 ? ` and ${idle.length - 8} more` : "");
      idleBanner.hidden = false;
    } else {
      idleBanner.hidden = true;
    }
  }

  document.querySelectorAll(".banner").forEach((banner) => {
    banner.addEventListener("click", (e) => {
      const link = e.target.closest("[data-jump]");
      if (!link) return;
      e.preventDefault();
      switchTab("cases");
      scrollToCase(link.dataset.jump);
    });
  });

  function mean(values) {
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function setStat(id, text, cls) {
    const node = el(id);
    node.textContent = text;
    node.classList.remove("warning", "critical", "good");
    if (cls) node.classList.add(cls);
  }

  function renderStats(rows) {
    setStat("statTotal", String(rows.length));

    const ttrs = rows.map((c) => c.activeTtrDays).filter((v) => typeof v === "number");
    const avg = mean(ttrs);
    setStat("statAvgTtr", avg === null ? "—" : formatDuration(avg), avg !== null && avg >= 10 ? "warning" : null);

    const overdue = rows.filter(nccOverdue).length;
    setStat("statNccOverdue", String(overdue), overdue ? "critical" : "good");

    const escalated = rows.filter((c) => c.isEscalated).length;
    setStat("statEscalated", String(escalated), escalated ? "critical" : "good");
  }

  function renderNextAction(na) {
    if (!na) return "—";
    return (
      `<span class="next-action-${escapeHtml(na.kind)}">${escapeHtml(na.label)}</span>` +
      `<span class="next-action-reason">${escapeHtml(na.reason || "")}</span>`
    );
  }

  function renderTable(rows) {
    const tbody = el("caseTableBody");
    tbody.innerHTML = "";

    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = `<td colspan="${CASE_COLUMN_COUNT}">${
        state.cases.length ? "No cases match your search." : "No open cases."
      }</td>`;
      tbody.appendChild(tr);
      el("footNote").textContent = "";
      return;
    }

    for (const c of rows) tbody.appendChild(renderCaseRow(c));

    const total = state.cases.length;
    el("footNote").textContent =
      rows.length === total ? `Showing ${total} cases.` : `Showing ${rows.length} of ${total} cases.`;
  }

  function renderCaseRow(c) {
    const tr = document.createElement("tr");
    tr.dataset.caseNumber = c.caseNumber;
    if (c.isEscalated) tr.classList.add("attention");
    if (nccOverdue(c)) tr.classList.add("ncc-overdue-row");

    const url = caseUrl(c);
    const pKey = priorityKey(c.priority);
    const idleDays = daysSince(c.lastCustomerUpdate);
    const ttrCls =
      typeof c.activeTtrDays === "number"
        ? c.activeTtrDays >= 20
          ? " overdue"
          : c.activeTtrDays >= 10
          ? " due-soon"
          : ""
        : "";
    const idleCls = idleDays !== null && idleDays > IDLE_THRESHOLD_DAYS ? " overdue" : "";

    tr.innerHTML = `
      <td class="case-number">${
        url
          ? `<a href="${url}" target="_blank" rel="noopener">${escapeHtml(c.caseNumber)}</a>`
          : escapeHtml(c.caseNumber)
      }${c.isEscalated ? '<span class="escalated-flag" title="Escalated">▲</span>' : ""}</td>
      <td><span class="pri ${pKey.toLowerCase()}">${escapeHtml(c.priority || "P4")}</span></td>
      <td><span class="pill ${statusClass(c.status)}">${escapeHtml(c.status || "—")}</span></td>
      <td class="tip-cell">${truncated(c.account)}</td>
      <td class="tip-cell">${truncated(c.subject || "(no subject)")}</td>
      <td>${escapeHtml(c.contactName || "—")}</td>
      <td>${escapeHtml(formatOpened(c.createdDate))}</td>
      <td class="num${idleCls}">${escapeHtml(formatDaysAgo(idleDays))}</td>
      <td class="num${ttrCls}">${escapeHtml(formatDuration(c.activeTtrDays))}</td>
      <td class="tip-cell">${truncated(componentName(c))}</td>
      <td>${renderNextAction(c.nextAction)}</td>
      <td><button type="button" class="btn draft-btn${
        nccOverdue(c) ? " followup-due" : ""
      }">Draft</button></td>
    `;

    tr.querySelector(".draft-btn").addEventListener("click", () => openSuggestModal(c.caseNumber));
    return tr;
  }

  function scrollToCase(caseNumber) {
    const row = document.querySelector(`tr[data-case-number="${CSS.escape(caseNumber)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("row-highlight");
    setTimeout(() => row.classList.remove("row-highlight"), 1600);
  }

  // ---------- Product Component tab ----------

  function componentGroups() {
    const map = new Map();
    for (const c of state.cases) {
      const name = componentName(c);
      let g = map.get(name);
      if (!g) {
        g = { name, cases: [], count: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
        map.set(name, g);
      }
      g.cases.push(c);
      g.count++;
      g[priorityKey(c.priority)]++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  function renderComponentTab() {
    const groups = componentGroups();
    renderComponentChart(groups);
    renderComponentStats(groups);
    renderComponentTable(groups);
  }

  function renderComponentChart(groups) {
    const container = el("componentChart");
    if (!groups.length) {
      container.innerHTML = `<div class="component-empty">No cases</div>`;
      return;
    }
    const max = groups[0].count;
    container.innerHTML = groups
      .map((g) => {
        const active = state.componentFilter === g.name;
        const pct = Math.max(6, Math.round((g.count / max) * 100));
        return `
          <button type="button" class="component-col${active ? " active" : ""}" data-component="${escapeHtml(
          g.name
        )}" title="${escapeHtml(g.name)} — ${g.count} case${g.count === 1 ? "" : "s"}">
            <span class="component-col-count">${g.count}</span>
            <span class="component-col-track"><span class="component-col-fill" style="height:${pct}%"></span></span>
            <span class="component-col-label">${escapeHtml(g.name)}</span>
          </button>`;
      })
      .join("");

    container.querySelectorAll(".component-col").forEach((col) => {
      col.addEventListener("click", () => {
        const name = col.dataset.component;
        state.componentFilter = state.componentFilter === name ? "" : name;
        if (state.componentFilter) switchTab("cases");
        render();
      });
    });
  }

  function renderComponentStats(groups) {
    setStat("statComponents", String(groups.length));
    setStat("statTopComponentCount", groups.length ? String(groups[0].count) : "—");

    const waiting = state.cases.filter((c) => /waiting.*customer|pending\s*customer/i.test(c.status || "")).length;
    setStat("statWaitingCustomer", String(waiting), waiting ? "warning" : null);

    const eng = state.cases.filter((c) => /pending\s*eng/i.test(c.status || "")).length;
    setStat("statPendingEng", String(eng), eng ? "warning" : null);
  }

  function renderComponentTable(groups) {
    const tbody = el("componentTableBody");
    tbody.innerHTML = "";

    if (!groups.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No open cases.</td></tr>`;
      return;
    }

    for (const g of groups) {
      const ttrs = g.cases.map((c) => c.activeTtrDays).filter((v) => typeof v === "number");
      const tr = document.createElement("tr");
      if (state.componentFilter === g.name) tr.classList.add("row-highlight");
      tr.innerHTML = `
        <td class="tip-cell">${truncated(g.name)}</td>
        <td class="num">${g.count}</td>
        <td class="num${g.P1 ? " overdue" : ""}">${g.P1}</td>
        <td class="num">${g.P2}</td>
        <td class="num">${g.P3}</td>
        <td class="num">${g.P4}</td>
        <td class="num">${escapeHtml(formatDuration(mean(ttrs)))}</td>
      `;
      tr.addEventListener("click", () => {
        state.componentFilter = state.componentFilter === g.name ? "" : g.name;
        if (state.componentFilter) switchTab("cases");
        render();
      });
      tbody.appendChild(tr);
    }
  }

  function renderFilterNote() {
    const note = el("filterNote");
    if (!state.componentFilter) {
      note.hidden = true;
      return;
    }
    el("filterNoteText").textContent = `Product Component: ${state.componentFilter}`;
    note.hidden = false;
  }

  el("clearFilterBtn").addEventListener("click", () => {
    state.componentFilter = "";
    render();
  });

  // ---------- Suggested Reply modal ----------

  const LOADING_STEPS = ["history", "email", "criteria", "draft", "selfcheck"];
  const STEP_DELAY_MS = 900;

  function stepEl(name) {
    return document.querySelector(`.loading-step[data-step="${name}"]`);
  }

  function openModal() {
    el("suggestModal").classList.add("open");
  }

  function closeModal() {
    el("suggestModal").classList.remove("open");
    // Bump the generation so a still-running draft request cannot paint into
    // a modal the user has already dismissed.
    state.draftGen++;
  }

  el("modalCloseBtn").addEventListener("click", closeModal);

  let overlayMousedownOnBackdrop = false;
  el("suggestModal").addEventListener("mousedown", (e) => {
    overlayMousedownOnBackdrop = e.target === el("suggestModal");
  });
  el("suggestModal").addEventListener("click", (e) => {
    // Only close on a click that both started and ended on the backdrop, so a
    // text selection dragged out of the modal does not dismiss it.
    if (e.target === el("suggestModal") && overlayMousedownOnBackdrop) closeModal();
    overlayMousedownOnBackdrop = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el("suggestModal").classList.contains("open")) closeModal();
  });

  async function openSuggestModal(caseNumber, regenerate = false) {
    const gen = ++state.draftGen;
    state.suggestCaseNumber = caseNumber;

    const c = state.cases.find((x) => x.caseNumber === caseNumber);
    el("suggestModalSub").textContent = c
      ? `#${caseNumber} · ${c.account || "—"} · ${c.subject || "(no subject)"}`
      : `#${caseNumber}`;

    el("draftPanel").hidden = true;
    el("draftError").hidden = true;
    el("regenerateBtn").hidden = true;
    el("copyDraftBtn").hidden = true;
    el("copyHint").textContent = "";
    el("draftLoading").hidden = false;
    LOADING_STEPS.forEach((s) => {
      const node = stepEl(s);
      if (node) node.classList.remove("active", "done");
    });

    openModal();

    const started = performance.now();
    const fetchPromise = api("/api/intelligence/suggest-reply", {
      method: "POST",
      body: JSON.stringify({ case_number: caseNumber, regenerate }),
    })
      .then((data) => ({ ok: true, data }))
      .catch((err) => ({ ok: false, err }));

    const result = await runLoadingAnimation(fetchPromise);
    if (gen !== state.draftGen) return; // superseded or dismissed

    el("draftLoading").hidden = true;
    if (result.ok) {
      showDraft(result.data, (performance.now() - started) / 1000);
    } else {
      el("draftError").textContent = result.err.message || "Could not draft a reply.";
      el("draftError").hidden = false;
      el("regenerateBtn").hidden = false;
    }
  }

  // Steps light up in sequence; the last one keeps spinning until the real
  // response lands, so the panel never sits on a finished-looking blank state.
  function runLoadingAnimation(fetchPromise) {
    return new Promise((resolve) => {
      const nodes = LOADING_STEPS.map(stepEl);
      const lastIdx = nodes.length - 1;
      let settled = null;
      let done = false;
      fetchPromise.then((r) => {
        settled = r;
        done = true;
      });

      let i = 0;
      function advance() {
        if (i > 0 && nodes[i - 1]) {
          nodes[i - 1].classList.remove("active");
          nodes[i - 1].classList.add("done");
        }
        if (nodes[i]) nodes[i].classList.add("active");
        if (i < lastIdx) {
          i++;
          setTimeout(advance, STEP_DELAY_MS);
        } else {
          waitForResponse();
        }
      }
      function waitForResponse() {
        if (!done) return void setTimeout(waitForResponse, 150);
        if (nodes[lastIdx]) {
          nodes[lastIdx].classList.remove("active");
          nodes[lastIdx].classList.add("done");
        }
        resolve(settled);
      }
      advance();
    });
  }

  function showDraft(data, seconds) {
    el("draftPanel").hidden = false;
    el("draftText").value = data.draft || "";
    el("draftTiming").textContent = data.cached
      ? "Cached draft"
      : `Drafted in ${seconds.toFixed(1)}s`;

    const badge = el("draftKeywordBadge");
    if (data.keyword) {
      badge.textContent = data.keyword;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }

    if (data.internalNote) {
      el("internalNoteText").value = data.internalNote;
      el("internalNoteBlock").hidden = false;
    } else {
      el("internalNoteBlock").hidden = true;
    }

    if (data.selfCheck) {
      el("selfCheckText").textContent = data.selfCheck;
      el("selfCheckBlock").hidden = false;
    } else {
      el("selfCheckBlock").hidden = true;
    }

    el("copyHint").textContent = "Draft only — review before sending. Nothing is sent automatically.";
    el("regenerateBtn").hidden = false;
    el("copyDraftBtn").hidden = false;
  }

  el("regenerateBtn").addEventListener("click", () => {
    if (state.suggestCaseNumber) openSuggestModal(state.suggestCaseNumber, true);
  });

  function suggestCaseUrl() {
    const c = state.cases.find((x) => x.caseNumber === state.suggestCaseNumber);
    return c ? caseUrl(c) : null;
  }

  // Copy synchronously via execCommand: the app is served over plain HTTP, so
  // the async Clipboard API is unavailable (non-secure context). The Clipboard
  // API stays as a best-effort fallback for when execCommand is blocked.
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
    // Copy BEFORE opening the tab — window.open moves focus and would break
    // the synchronous copy.
    const ok = copyDraftSync();
    const url = suggestCaseUrl();
    if (url) window.open(url, "_blank", "noopener");
    el("copyHint").textContent = ok
      ? "Copied — paste into the case."
      : "Copy blocked — select the draft and copy manually.";
  });

  checkAuth();
})();
