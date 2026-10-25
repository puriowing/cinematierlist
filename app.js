/* =========================================================================
   Pickture
   - localStorage による自動保存
   - Filmarks 検索 / 手動追加
   - ドラッグ&ドロップでティア振り分け
   - ティアの追加/名前変更/色変更/並び替え/削除
   - PNG 書き出し
   ========================================================================= */

(function () {
  "use strict";

  const COLLAPSE_ICON =
    '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  const STORAGE_KEY = "movieTierList.v1";
  const SETTINGS_KEY = "movieTierList.settings.v1";
  const ACHV_KEY = "movieTierList.achievements.v1";
  const BACKUP_KEY = "movieTierList.backups.v1";
  const MAX_BACKUPS = 8;
  const IDB_NAME = "movieTierListDB";
  const IDB_STORE = "kv";

  const TIER_COLORS = [
    "#ff7f7f", "#ffbf7f", "#ffdf7f", "#ffff7f", "#bfff7f",
    "#7fff7f", "#7fffff", "#7fbfff", "#bf7fff", "#ff7fdf",
    "#cfcfcf", "#9aa3b2",
  ];

  const DEFAULT_TIERS = [
    { id: uid(), label: "S", color: "#ff7f7f", items: [] },
    { id: uid(), label: "A", color: "#ffbf7f", items: [] },
    { id: uid(), label: "B", color: "#ffdf7f", items: [] },
    { id: uid(), label: "C", color: "#bfff7f", items: [] },
    { id: uid(), label: "D", color: "#7fbfff", items: [] },
  ];

  /** @type {{title:string, tiers:Array, pool:Array}} */
  let state = loadState();
  let settings = loadSettings();
  let achievements = loadAchievements();

  // テーマフィルター。複数の { type, value } を組み合わせて絞り込む。
  // filterMode が "and" なら全条件を満たす作品、"or" ならいずれかを満たす作品を表示。
  let activeFilters = [];
  let filterMode = "and"; // "and" | "or"
  // 複数テーマの区切り記号（AND=×／OR=／）。ラベル表示に使う。
  function filterJoiner() { return filterMode === "or" ? " / " : " × "; }
  function hasFilter() { return activeFilters.length > 0; }
  function hasFilterVal(type, value) {
    return activeFilters.some((f) => f.type === type && f.value === value);
  }
  // "year:2026" のような raw 値が選択中かどうか
  function isOptionActive(rawValue) {
    const idx = rawValue.indexOf(":");
    if (idx < 0) return false;
    return hasFilterVal(rawValue.slice(0, idx), rawValue.slice(idx + 1));
  }
  // 絞り込み1件の短い表示名（例: 2026年 / 邦画実写 / 泣ける）
  function filterLabel(f) {
    if (f.type === "year") return f.value + "年";
    if (f.type === "kind") return KIND_LABEL[f.value] || f.value;
    if (f.type === "nitaku") return "二択で動いた作品";
    return f.value;
  }
  // 登録作品のタイトル検索クエリ（正規化済み）。テーマ絞り込みと AND で併用する
  let searchQuery = "";

  // 登録本数（起動時の実績演出抑止用に前回値を保持）
  let lastMovieCount = -1;

  // 大量登録対策: 1エリアあたりの描画上限と、エリアごとの現在の上限
  const RENDER_CAP = 80;
  const RENDER_STEP = 160;
  const zoneLimits = new Map();

  // 旧データの移行（折りたたみ状態など）
  state.tiers.forEach((t) => {
    if (typeof t.collapsed !== "boolean") t.collapsed = false;
  });
  if (typeof state.poolCollapsed !== "boolean") state.poolCollapsed = false;
  if (!Array.isArray(state.watchlist)) state.watchlist = [];

  // 「映画を追加」の追加先（"pool" = 観た / "watchlist" = 観たい）
  let addTarget = "pool";

  // ---- DOM refs ----
  const el = {
    tierRows: document.getElementById("tierRows"),
    poolItems: document.getElementById("poolItems"),
    poolEmptyHint: document.getElementById("poolEmptyHint"),
    listFileName: document.getElementById("listFileName"),
    tierExportTitle: document.getElementById("tierExportTitle"),
    tierBoard: document.getElementById("tierBoard"),
    toast: document.getElementById("toast"),
  };

  // =======================================================================
  // Persistence
  // =======================================================================
  function uid() {
    return "id-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.tiers)) return parsed;
      }
    } catch (e) {
      console.warn("state load failed", e);
    }
    return { title: "", tiers: JSON.parse(JSON.stringify(DEFAULT_TIERS)), pool: [] };
  }

  function totalMovies(st) {
    if (!st || !Array.isArray(st.tiers)) return 0;
    return (st.pool ? st.pool.length : 0) +
      st.tiers.reduce((n, t) => n + (t.items ? t.items.length : 0), 0);
  }

  // バックアップ用の軽量コピー（容量の大きいアップロード画像=data URLは除外）
  function stripHeavy(st) {
    const clone = JSON.parse(JSON.stringify(st));
    const light = (arr) =>
      (arr || []).forEach((m) => {
        if (typeof m.poster === "string" && m.poster.startsWith("data:")) m.poster = "";
      });
    light(clone.pool);
    light(clone.watchlist);
    (clone.tiers || []).forEach((t) => light(t.items));
    return clone;
  }

  // 本体データを最優先で保存。容量超過時はバックアップを削って本体を守る。
  function saveMain(serialized) {
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
      return true;
    } catch (e) {
      try { localStorage.removeItem(BACKUP_KEY); } catch (_) {}
      try {
        localStorage.setItem(STORAGE_KEY, serialized);
        return true;
      } catch (e2) {
        console.warn("localStorage full; state kept in IndexedDB only", e2);
        return false;
      }
    }
  }

  function saveState() {
    let serialized = "{}";
    try {
      serialized = JSON.stringify(state);
      saveMain(serialized);
    } catch (e) {
      console.warn("state save failed", e);
    }
    idbSave(serialized);   // 耐久ストア（IndexedDB）へも常に保存
    pushBackup();          // 余裕があれば復元ポイントを積む
    scheduleServerPush();  // ログイン中はサーバーへも同期（デバウンス）
  }

  function loadBackups() {
    try {
      const raw = localStorage.getItem(BACKUP_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) {}
    return [];
  }

  // 復元ポイントを積み上げる（中身が変わったときだけ、映画が1本以上あるときだけ）
  function pushBackup() {
    try {
      if (totalMovies(state) === 0 && !(state.watchlist || []).length) return; // 空データは保存しない（消失時の上書き防止）
      const lean = JSON.stringify(stripHeavy(state));
      if (lean.length > 1500000) return; // 大きすぎる場合はバックアップ対象外
      const backups = loadBackups();
      const last = backups[backups.length - 1];
      if (last && last.data === lean) return; // 変更なしはスキップ
      // 作品の追加・削除・ランク変更がない細かい編集は、5分以内なら直前の記録にまとめる
      const sig = placementSig(state);
      if (!skipBackupMerge && last && last.sig === sig && Date.now() - last.ts < 300000) backups.pop();
      backups.push({
        sig,
        restoredFrom: restoredFromTs || undefined,
        ts: Date.now(),
        title: state.fileName || state.title || "",
        count: totalMovies(state),
        data: lean,
      });
      while (backups.length > MAX_BACKUPS) backups.shift();
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify(backups));
      } catch (e) {
        // 容量超過なら世代を減らして再試行
        while (backups.length > 2) {
          backups.shift();
          try {
            localStorage.setItem(BACKUP_KEY, JSON.stringify(backups));
            return;
          } catch (_) {}
        }
      }
    } catch (e) {
      console.warn("backup failed", e);
    }
  }

  let skipBackupMerge = false; // 戻す操作の直後は、戻す前の状態を消さない
  let restoredFromTs = 0;
  function placementSig(st) {
    return (st.tiers || []).map((t) => t.label + ":" + (t.items || []).map((m) => m.id).sort().join(",")).join("|") +
      "|pool:" + (st.pool || []).map((m) => m.id).sort().join(",");
  }

  // ---- IndexedDB（localStorageより大容量で消えにくい耐久ストア）----
  let idbPromise = null;
  function idb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === "undefined") return resolve(null);
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return idbPromise;
  }

  async function idbSave(serialized) {
    try {
      const db = await idb();
      if (!db) return;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(serialized, "state");
    } catch (e) {}
  }

  async function idbLoad() {
    try {
      const db = await idb();
      if (!db) return null;
      return await new Promise((resolve) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const r = tx.objectStore(IDB_STORE).get("state");
        r.onsuccess = () => {
          try { resolve(r.result ? JSON.parse(r.result) : null); }
          catch (e) { resolve(null); }
        };
        r.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  // localStorageが空でもIndexedDBに残っていれば復旧する
  async function reconcileFromIdb() {
    if (totalMovies(state) > 0) return false;
    const idbState = await idbLoad();
    if (!idbState || !Array.isArray(idbState.tiers) || totalMovies(idbState) === 0) return false;
    state = idbState;
    state.tiers.forEach((t) => { if (typeof t.collapsed !== "boolean") t.collapsed = false; });
    if (typeof state.poolCollapsed !== "boolean") state.poolCollapsed = false;
    if (!Array.isArray(state.watchlist)) state.watchlist = [];
    zoneLimits.clear();
    lastMovieCount = totalMovies(state);
    render();
    toast(`保存済みデータを復元しました（${lastMovieCount} 本）`);
    return true;
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { compact: false, theme: "studio" };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadAchievements() {
    try {
      const raw = localStorage.getItem(ACHV_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.unlocked) return p;
      }
    } catch (e) {}
    return { unlocked: {} };
  }

  function saveAchievements() {
    try {
      localStorage.setItem(ACHV_KEY, JSON.stringify(achievements));
    } catch (e) {}
  }

  // =======================================================================
  // Utility
  // =======================================================================
  function findMovie(movieId) {
    for (const t of state.tiers) {
      const m = t.items.find((x) => x.id === movieId);
      if (m) return { movie: m, from: t.items };
    }
    const pm = state.pool.find((x) => x.id === movieId);
    if (pm) return { movie: pm, from: state.pool };
    const wm = (state.watchlist || []).find((x) => x.id === movieId);
    if (wm) return { movie: wm, from: state.watchlist };
    return null;
  }

  function getZoneArray(zoneId) {
    if (zoneId === "pool") return state.pool;
    if (zoneId === "watchlist") return state.watchlist;
    const tier = state.tiers.find((t) => t.id === zoneId);
    return tier ? tier.items : null;
  }

  // スマホ：下部タブバー、ホーム画面ショートカット、ホーム画面追加の案内
  function setupMobileShell() {
    const bar = document.getElementById("tabbar");
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const tab = e.target.closest(".tbar-btn");
      if (!tab) return;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
      if (tab.dataset.tab === "home") {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const target = document.getElementById(tab.dataset.proxy);
      if (target) target.click();
    });

    const open = new URLSearchParams(location.search).get("open");
    const map = { battle: "battleBtn", stats: "statsBtn" };
    if (map[open]) {
      history.replaceState(null, "", location.pathname);
      setTimeout(() => { const b = document.getElementById(map[open]); if (b) b.click(); }, 300);
    }

    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    document.body.classList.toggle("is-standalone", !!standalone);
    if (standalone || !window.matchMedia("(max-width: 768px)").matches) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem("ctl-install-hint") === "1"; } catch (err) {}
    if (dismissed) return;

    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    let deferred = null;
    const hint = document.createElement("div");
    hint.className = "install-hint hidden";
    hint.innerHTML =
      '<img src="icons/icon-192.png" alt="" class="install-ic">' +
      '<div class="install-tx"><b>アプリとして使えます</b><span></span></div>' +
      '<button type="button" class="btn btn-primary btn-sm install-go">追加</button>' +
      '<button type="button" class="install-x" aria-label="閉じる">✕</button>';
    document.body.appendChild(hint);
    const msg = hint.querySelector(".install-tx span");
    const go = hint.querySelector(".install-go");
    const close = () => {
      hint.classList.add("hidden");
      try { localStorage.setItem("ctl-install-hint", "1"); } catch (err) {}
    };
    hint.querySelector(".install-x").addEventListener("click", close);

    if (isIOS) {
      msg.textContent = "共有ボタン（□↑）→「ホーム画面に追加」";
      go.remove();
      setTimeout(() => hint.classList.remove("hidden"), 2500);
    } else {
      window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        deferred = e;
        msg.textContent = "ホーム画面に追加して全画面で使う";
        hint.classList.remove("hidden");
      });
      go.addEventListener("click", async () => {
        if (!deferred) return;
        deferred.prompt();
        try { await deferred.userChoice; } catch (err) {}
        deferred = null;
        close();
      });
    }
  }

  function toast(msg, action) {
    el.toast.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.className = "toast-action";
      b.textContent = action.label;
      b.addEventListener("click", () => { el.toast.classList.add("hidden"); action.onClick(); });
      el.toast.appendChild(b);
    }
    el.toast.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.add("hidden"), action ? 8000 : 2200);
  }

  // =======================================================================
  // Rendering
  // =======================================================================
  // 表示用の名前 = 開いている(=最後に開いた/保存した)ファイル名（拡張子なし）
  function currentName() {
    return (state.fileName || state.title || "").trim();
  }

  function updateTitleDisplay() {
    const t = currentName();
    el.listFileName.textContent = t || "まだ書き出していません";
    el.listFileName.classList.toggle("is-empty", !t);
  }

  // 「登録順」で並べ替えられるように、各作品へ安定した登録順キー(addedAt)を付与する。
  // 既存データ（キー未設定）は現在の並び順を登録順とみなして採番し、以後の新規追加は
  // 末尾に積まれるため常に最大値が振られる（＝あとから並べ替えても登録順に戻せる）。
  function ensureAddedStamps() {
    if (typeof state._seq !== "number") {
      let mx = 0;
      const scan = (arr) => (arr || []).forEach((m) => {
        if (m && typeof m.addedAt === "number" && m.addedAt > mx) mx = m.addedAt;
      });
      scan(state.pool);
      (state.tiers || []).forEach((t) => scan(t.items));
      scan(state.watchlist);
      state._seq = mx;
    }
    const stamp = (arr) => (arr || []).forEach((m) => {
      if (m && typeof m.addedAt !== "number") { state._seq += 1; m.addedAt = state._seq; }
    });
    stamp(state.pool);
    (state.tiers || []).forEach((t) => stamp(t.items));
  }

  // 並べ替え用のタイトルキー（先頭の記号・空白・引用符などを除いて比較する）
  function titleSortKey(m) {
    return String((m && m.title) || "")
      .replace(/^[\s"'“”『』「」（(【\[]+/, "")
      .trim();
  }

  // ティア内の作品を一括で並べ替える（登録順 / あいうえお順）
  function sortTier(tier, mode) {
    if (!tier || !Array.isArray(tier.items)) return;
    ensureAddedStamps();
    if (mode === "title") {
      tier.items.sort((a, b) => titleSortKey(a).localeCompare(titleSortKey(b), "ja", { numeric: true }));
    } else {
      tier.items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    }
    tier.sortMode = mode;
    render();
  }

  function render() {
    ensureAddedStamps();
    updateTitleDisplay();
    renderTiers();
    renderPool();
    updateThemeButton();
    updateFilterInfo();
    const cnt = allMovies().length;
    updateCounter(cnt);
    updateWatchlistBadge();
    if (lastMovieCount >= 0) { try { evaluateAchievements(); } catch (e) {} }
    lastMovieCount = cnt;
    saveState();
    scheduleAutoFill();
    scheduleGenreFix();
    scheduleKindEnrich();
  }

  function updateCounter(n) {
    const chip = document.getElementById("movieCounter");
    if (chip) chip.textContent = `🎞️ ${n}本`;
  }

  function applyCompact() {
    document.body.classList.toggle("compact", !!settings.compact);
    const chk = document.getElementById("compactCheck");
    if (chk) chk.checked = !!settings.compact;
  }

  function applyTheme() {
    const isStudio = settings.theme !== "classic";
    document.body.classList.toggle("theme-studio", isStudio);
    document.body.classList.toggle("theme-pop", settings.theme === "pop");
    const sel = document.getElementById("themeSelect");
    if (sel) sel.value = settings.theme === "pop" ? "pop" : isStudio ? "studio" : "classic";
  }

  function visibleItems(items) {
    let list = hasFilter() ? items.filter(matchesFilter) : items;
    if (searchQuery) list = list.filter((m) => normTitle(m.title).includes(searchQuery));
    return list;
  }

  // エリアに描画枚数の上限を設けて DOM 数を抑える（数千件でも軽快に保つ）
  function renderZoneInto(zone, items, zoneId) {
    const list = visibleItems(items);
    const limit = zoneLimits.get(zoneId) || RENDER_CAP;
    const slice = list.slice(0, limit);
    slice.forEach((m) => zone.appendChild(buildMovieCard(m)));
    if (slice.length < list.length) {
      const more = document.createElement("button");
      more.className = "show-more";
      more.textContent = `＋ さらに表示（残り ${list.length - slice.length} 件）`;
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        zoneLimits.set(zoneId, slice.length + RENDER_STEP);
        render();
      });
      zone.appendChild(more);
    }
    return { shown: slice.length, total: list.length };
  }

  function renderTiers() {
    el.tierRows.innerHTML = "";
    state.tiers.forEach((tier) => {
      const row = document.createElement("div");
      row.className = "tier-row" + (tier.collapsed ? " collapsed" : "");
      row.dataset.tierId = tier.id;

      const label = document.createElement("div");
      label.className = "tier-label";
      label.style.background = tier.color;
      label.innerHTML =
        `<button class="collapse-toggle${tier.collapsed ? " is-collapsed" : ""}" title="折りたたみ / 展開">${COLLAPSE_ICON}</button>` +
        `<span class="tier-label-text">${escapeHtml(tier.label)}</span>` +
        `<span class="tier-count">${visibleItems(tier.items).length}</span>` +
        `<button class="tier-sort" title="このティアを並び替え（登録順 / あいうえお順）">↕</button>` +
        `<span class="tier-gear" title="ティアを編集">⚙</span>`;
      label.querySelector(".collapse-toggle").addEventListener("click", (e) => {
        e.stopPropagation();
        tier.collapsed = !tier.collapsed;
        render();
      });
      label.querySelector(".tier-sort").addEventListener("click", (e) => {
        e.stopPropagation();
        openTierSortMenu(tier, e.currentTarget);
      });
      label.addEventListener("click", () => openTierEditor(tier, label));
      row.appendChild(label);

      const zone = document.createElement("div");
      zone.dataset.zone = tier.id;
      if (tier.collapsed) {
        zone.className = "tier-dropzone collapsed-zone";
        zone.textContent = `${tier.items.length} 本（折りたたみ中）`;
      } else {
        zone.className = "tier-dropzone";
        renderZoneInto(zone, tier.items, tier.id);
      }
      attachZoneDnD(zone);
      row.appendChild(zone);
      el.tierRows.appendChild(row);
    });

    // ティアの一番下に「観たい（ウォッチリスト）」ゾーンを表示する。
    // ティアへ振り分けるのと同じドラッグ／タップ操作で、ここへも振り分けられる。
    renderWatchlistRow();
    renderTierOverview();
  }

  function renderTierOverview() {
    const nav = document.getElementById("tierOverview");
    if (!nav) return;
    const tiers = state.tiers.map((t) => ({ id: t.id, label: t.label, color: t.color, n: visibleItems(t.items).length }));
    const wlN = visibleItems(state.watchlist || []).length;
    const total = tiers.reduce((a, t) => a + t.n, 0);
    const chip = (t, extra = "") =>
      `<button type="button" class="to-chip${extra}" data-target="${escapeHtml(t.id)}" title="${escapeHtml(t.label)}：${t.n}本">` +
      `<span class="to-sw"${t.color ? ` style="background:${t.color}"` : ""}></span>` +
      `<span class="to-name">${escapeHtml(t.label)}</span><span class="to-n">${t.n}</span></button>`;
    nav.innerHTML =
      `<div class="to-head"><span class="to-sum">${tiers.length}ティア・${total}本${hasFilter() || searchQuery ? "（絞り込み中）" : ""}</span>` +
      `<div class="to-chips">${tiers.map((t) => chip(t)).join("")}${chip({ id: "watchlist", label: "🔖 観たい", n: wlN }, " to-chip-wl")}</div></div>` +
      `<div class="to-bar">${tiers.map((t) =>
        `<span class="to-seg${t.n ? "" : " is-empty"}" data-target="${escapeHtml(t.id)}" style="background:${t.color};flex-grow:${t.n}" title="${escapeHtml(t.label)}：${t.n}本（${total ? Math.round((t.n / total) * 100) : 0}%）"></span>`
      ).join("")}</div>`;
    nav.querySelectorAll("[data-target]").forEach((b) =>
      b.addEventListener("click", () => scrollToTier(b.dataset.target))
    );
    updateTierOverviewActive();
  }

  function tierRowEl(id) {
    if (id === "watchlist") return el.tierRows.querySelector(".tier-row-watchlist");
    return [...el.tierRows.querySelectorAll(".tier-row[data-tier-id]")].find((r) => r.dataset.tierId === id);
  }

  function tierOverviewOffset() {
    const head = document.querySelector(".app-header");
    const nav = document.getElementById("tierOverview");
    return (head ? head.offsetHeight : 0) + (nav ? nav.offsetHeight : 0) + 8;
  }

  function scrollToTier(id) {
    const row = tierRowEl(id);
    if (!row) return;
    tierJumpTarget = id;
    const y = row.getBoundingClientRect().top + window.scrollY - tierOverviewOffset();
    window.scrollTo({ top: y, behavior: "smooth" });
  }

  function updateTierOverviewActive() {
    const nav = document.getElementById("tierOverview");
    if (!nav) return;
    const head = document.querySelector(".app-header");
    nav.style.top = (head ? head.offsetHeight : 0) + "px";
    const line = tierOverviewOffset() + 40;
    let current = null;
    el.tierRows.querySelectorAll(".tier-row").forEach((r) => {
      if (r.getBoundingClientRect().top <= line) current = r.classList.contains("tier-row-watchlist") ? "watchlist" : r.dataset.tierId;
    });
    const first = el.tierRows.querySelector(".tier-row");
    if (first && first.getBoundingClientRect().top > line) current = null;
    if (tierJumpTarget && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = tierJumpTarget;
    nav.querySelectorAll(".to-chip").forEach((c) => {
      const on = c.dataset.target === current;
      c.classList.toggle("is-active", on);
      if (on && c.parentElement.scrollWidth > c.parentElement.clientWidth) {
        const p = c.parentElement;
        const left = c.offsetLeft - p.offsetLeft;
        if (left < p.scrollLeft || left + c.offsetWidth > p.scrollLeft + p.clientWidth) p.scrollTo({ left: left - 24, behavior: "smooth" });
      }
    });
  }

  let tierOverviewRaf = 0;
  let tierJumpTarget = null;
  ["wheel", "touchmove", "keydown"].forEach((ev) => window.addEventListener(ev, () => { tierJumpTarget = null; }, { passive: true }));
  window.addEventListener("scroll", () => {
    if (tierOverviewRaf) return;
    tierOverviewRaf = requestAnimationFrame(() => { tierOverviewRaf = 0; updateTierOverviewActive(); });
  }, { passive: true });
  window.addEventListener("resize", () => updateTierOverviewActive());

  // 観たいゾーン（ティア末尾の特別な行）
  function renderWatchlistRow() {
    if (!Array.isArray(state.watchlist)) state.watchlist = [];
    const wl = state.watchlist;
    const collapsed = !!state.watchlistCollapsed;
    const row = document.createElement("div");
    row.className = "tier-row tier-row-watchlist" + (collapsed ? " collapsed" : "");

    const label = document.createElement("div");
    label.className = "tier-label tier-label-watchlist";
    label.innerHTML =
      `<button class="collapse-toggle${collapsed ? " is-collapsed" : ""}" title="折りたたみ / 展開">${COLLAPSE_ICON}</button>` +
      `<span class="tier-label-text">🔖 観たい</span>` +
      `<span class="tier-count">${visibleItems(wl).length}</span>`;
    label.querySelector(".collapse-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      state.watchlistCollapsed = !state.watchlistCollapsed;
      render();
    });
    row.appendChild(label);

    const zone = document.createElement("div");
    zone.dataset.zone = "watchlist";
    if (collapsed) {
      zone.className = "tier-dropzone collapsed-zone";
      zone.textContent = `${wl.length} 本（折りたたみ中）`;
    } else {
      zone.className = "tier-dropzone";
      if (!wl.length) {
        const hint = document.createElement("p");
        hint.className = "wl-zone-hint";
        hint.textContent = "これから観たい作品をここへ。未分類やティアの作品をドラッグ、またはタップして「🔖 観たい」を選ぶと入ります。";
        zone.appendChild(hint);
      } else {
        renderZoneInto(zone, wl, "watchlist");
      }
    }
    attachZoneDnD(zone);
    row.appendChild(zone);
    el.tierRows.appendChild(row);
  }

  function renderPool() {
    const toggle = document.getElementById("poolCollapse");
    const countEl = document.getElementById("poolCount");
    if (toggle) {
      toggle.innerHTML = COLLAPSE_ICON;
      toggle.classList.toggle("is-collapsed", !!state.poolCollapsed);
    }
    if (countEl) countEl.textContent = visibleItems(state.pool).length;

    el.poolItems.innerHTML = "";
    el.poolItems.style.display = state.poolCollapsed ? "none" : "";
    if (!state.poolCollapsed) {
      renderZoneInto(el.poolItems, state.pool, "pool");
      attachZoneDnD(el.poolItems);
    }
    const total = state.pool.length + state.tiers.reduce((n, t) => n + t.items.length, 0);
    const poolEmpty = state.pool.length === 0 && !hasFilter();
    el.poolEmptyHint.style.display = poolEmpty ? "block" : "none";
    el.poolItems.closest(".pool").classList.toggle("pool-empty", poolEmpty);
    document.body.classList.toggle("is-empty", total === 0);
  }

  function buildMovieCard(movie) {
    const card = document.createElement("div");
    card.className = "movie-card" + (justAddedIds.has(movie.id) ? " just-added" : "");
    card.draggable = true;
    card.dataset.id = movie.id;

    if (movie.poster) {
      const img = document.createElement("img");
      img.className = "movie-poster";
      img.src = movie.poster;
      img.alt = movie.title;
      img.loading = "lazy";
      // PNG書き出しでキャンバスが汚染されないよう crossorigin を付ける。
      // ただし CORS 非対応の直リンク画像は表示に失敗するため、失敗時は
      // CORS対応のプロキシ(/api/img)経由で1度だけ再試行し、それでも駄目なら
      // タイトルのフォールバックにする。
      img.crossOrigin = "anonymous";
      img.addEventListener("error", () => {
        const src = img.getAttribute("src") || "";
        if (!img.dataset.proxied && src && !src.startsWith("data:") && !src.includes("/api/img")) {
          img.dataset.proxied = "1";
          img.src = "/api/img?u=" + encodeURIComponent(src);
          return;
        }
        const fb = buildFallback(movie.title);
        img.replaceWith(fb);
      });
      card.appendChild(img);
    } else {
      card.appendChild(buildFallback(movie.title));
    }

    const title = document.createElement("div");
    title.className = "movie-title";
    title.textContent = movie.title;
    title.title = movie.title;
    card.appendChild(title);

    if (movie.comment && String(movie.comment).trim()) {
      const badge = document.createElement("div");
      badge.className = "movie-comment-badge";
      badge.textContent = "💬";
      badge.title = movie.comment;
      card.appendChild(badge);
    }

    if (movie.unseen) {
      const ub = document.createElement("div");
      ub.className = "movie-nitaku-badge is-unseen";
      ub.textContent = "未鑑賞";
      ub.title = "二択で「まだ観ていない」にした作品（ティアに入れると消えます）";
      card.appendChild(ub);
    }
    if (movie.nitaku) {
      const nb = document.createElement("div");
      nb.className = "movie-nitaku-badge";
      nb.textContent = "二択";
      const d = new Date(movie.nitaku.at);
      nb.title = `${d.getMonth() + 1}/${d.getDate()} 二択で「${movie.nitaku.from}」から移動`;
      card.appendChild(nb);
    }

    const remove = document.createElement("button");
    remove.className = "movie-remove";
    remove.textContent = "✕";
    remove.title = "削除";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeMovie(movie.id);
    });
    card.appendChild(remove);

    const move = document.createElement("button");
    move.className = "movie-move";
    move.textContent = "⇄";
    move.title = "ティアに振り分け";
    move.addEventListener("click", (e) => {
      e.stopPropagation();
      openMoveMenu(movie, card);
    });
    card.appendChild(move);

    // クリック（ドラッグ以外）でもティア選択メニューを開く
    card.addEventListener("click", (e) => {
      openMoveMenu(movie, card);
    });
    card.title = "クリックでティアを選択（ドラッグでも移動できます）";

    attachCardDnD(card);
    return card;
  }

  function buildFallback(title) {
    const fb = document.createElement("div");
    fb.className = "movie-poster-fallback";
    fb.textContent = title;
    return fb;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // =======================================================================
  // Movie operations
  // =======================================================================
  function addMovie(movie) {
    if (addTarget === "watchlist") return addToWatchlist(movie);
    // 外部ID または タイトルで重複を避ける（ソースをまたいで同一作品を二重登録しない）
    if (movieExists(movie)) {
      toast("すでに追加済みです");
      return false;
    }
    removeFromWatchlistByMatch(movie); // 観たいリストにあれば「観た」ので取り除く
    state.pool.push({ id: uid(), ...movie });
    render();
    return true;
  }

  // =======================================================================
  // ウォッチリスト（観たい作品 / あとで観る）
  // =======================================================================
  function watchlistExists({ eigaId, tmdbId, filmarksId, title } = {}) {
    const nt = title ? normTitle(title) : "";
    return (state.watchlist || []).some(
      (m) =>
        (eigaId && m.eigaId === eigaId) ||
        (tmdbId && m.tmdbId === tmdbId) ||
        (filmarksId && m.filmarksId === filmarksId) ||
        (nt && normTitle(m.title) === nt)
    );
  }

  function removeFromWatchlistByMatch({ eigaId, tmdbId, filmarksId, title } = {}) {
    if (!state.watchlist || !state.watchlist.length) return;
    const nt = title ? normTitle(title) : "";
    state.watchlist = state.watchlist.filter(
      (m) =>
        !(
          (eigaId && m.eigaId === eigaId) ||
          (tmdbId && m.tmdbId === tmdbId) ||
          (filmarksId && m.filmarksId === filmarksId) ||
          (nt && normTitle(m.title) === nt)
        )
    );
  }

  function addToWatchlist(movie) {
    if (movieExists(movie)) { toast("すでに登録済みの作品です"); return false; }
    if (watchlistExists(movie)) { toast("すでに観たいリストにあります"); return false; }
    state.watchlist.push({ id: uid(), ...movie });
    render();
    return true;
  }

  function addFilmsToWatchlist(films) {
    let count = 0;
    justAddedIds = new Set();
    films.forEach((f) => {
      if (movieExists(f) || watchlistExists(f)) return;
      const m = { title: f.title, poster: f.poster || "", year: f.year || "" };
      if (f.eigaId) m.eigaId = f.eigaId;
      if (f.tmdbId) m.tmdbId = f.tmdbId;
      if (f.filmarksId) m.filmarksId = f.filmarksId;
      if (f.collection) m.collection = f.collection;
      const id = uid();
      justAddedIds.add(id);
      state.watchlist.push({ id, ...m });
      count++;
    });
    if (count) render();
    return count;
  }

  // 観たいリストの作品を「観た」= 未分類（pool）へ移す
  function markWatched(id) {
    const idx = (state.watchlist || []).findIndex((m) => m.id === id);
    if (idx < 0) return;
    const m = state.watchlist[idx];
    state.watchlist.splice(idx, 1);
    if (movieExists(m)) {
      toast("すでに登録済みでした");
    } else {
      state.pool.push(m);
      toast(`「${m.title}」を未分類に登録しました`);
    }
    render();
    renderWatchlist();
  }

  function removeFromWatchlist(id) {
    const idx = (state.watchlist || []).findIndex((m) => m.id === id);
    if (idx < 0) return;
    state.watchlist.splice(idx, 1);
    render();
    renderWatchlist();
  }

  function updateWatchlistBadge() {
    const btn = document.getElementById("watchlistBtn");
    if (!btn) return;
    const n = (state.watchlist || []).length;
    btn.textContent = n ? `🔖 観たい (${n})` : "🔖 観たい";
  }

  function buildWatchlistCard(movie) {
    const card = document.createElement("div");
    card.className = "wl-card";
    if (movie.poster) {
      const img = document.createElement("img");
      img.className = "wl-poster";
      img.src = movie.poster;
      img.alt = movie.title;
      img.loading = "lazy";
      img.crossOrigin = "anonymous";
      img.addEventListener("error", () => {
        const src = img.getAttribute("src") || "";
        if (!img.dataset.proxied && src && !src.startsWith("data:") && !src.includes("/api/img")) {
          img.dataset.proxied = "1";
          img.src = "/api/img?u=" + encodeURIComponent(src);
          return;
        }
        const fb = buildFallback(movie.title);
        fb.classList.add("wl-poster");
        img.replaceWith(fb);
      });
      card.appendChild(img);
    } else {
      const fb = buildFallback(movie.title);
      fb.classList.add("wl-poster");
      card.appendChild(fb);
    }
    const t = document.createElement("div");
    t.className = "wl-title";
    t.textContent = movie.title + (movie.year ? `（${movie.year}）` : "");
    t.title = movie.title;
    card.appendChild(t);

    const actions = document.createElement("div");
    actions.className = "wl-actions";
    const watched = document.createElement("button");
    watched.className = "btn btn-primary btn-sm";
    watched.textContent = "✅ 観た";
    watched.title = "観たリスト（未分類）へ移動します";
    watched.addEventListener("click", () => markWatched(movie.id));
    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm";
    del.textContent = "✕";
    del.title = "観たいリストから削除";
    del.addEventListener("click", () => removeFromWatchlist(movie.id));
    actions.appendChild(watched);
    actions.appendChild(del);
    card.appendChild(actions);
    return card;
  }

  function renderWatchlist() {
    const body = document.getElementById("watchlistBody");
    if (!body) return;
    const wl = state.watchlist || [];
    if (!wl.length) {
      body.innerHTML =
        `<p class="wl-empty">観たいリストは空です。<br>上の <b>「＋ 観たい映画を追加」</b> から登録すると、あとで観たい作品がここに貯まります。観たら <b>✅ 観た</b> でティア付けへ移せます。</p>`;
      return;
    }
    body.innerHTML =
      `<p class="wl-count">🔖 <b>${wl.length}</b> 本の観たい作品 ・ 観たら「✅ 観た」で未分類へ移動できます</p>` +
      `<div class="wl-grid" id="wlGrid"></div>`;
    const grid = document.getElementById("wlGrid");
    wl.forEach((m) => grid.appendChild(buildWatchlistCard(m)));
  }

  // 「映画を追加」ウィンドウを開く（追加した作品は未分類へ。あとでティアや観たいへ振り分ける）
  function openAddModal() {
    addTarget = "pool";
    openModal("addMovieModal");
    const s = document.getElementById("movieSearchInput");
    if (s) s.focus();
    // 「おすすめ」は時間がかかるので、ウィンドウを開いた時点で裏で準備しておく
    if (!recommendFilms.length && !recBuilding) setTimeout(() => buildRecommendations(), 300);
  }

  // =======================================================================
  // アカウント（ログイン）とサーバー同期
  //   ログイン中は Tier List をサーバー(server.py)へ保存し、別端末でも同じ内容を
  //   編集できる。未ログイン時は従来どおり端末内(localStorage/IndexedDB)のみ。
  //   競合は updatedAt による last-write-wins（新しい方を採用）で解決する。
  // =======================================================================
  let currentUser = null;
  let applyingRemote = false; // リモート反映中はサーバーへ即プッシュしない
  let pushTimer = null;

  async function apiJSON(path, opts) {
    const res = await fetch(path, Object.assign(
      { credentials: "same-origin", headers: { "Content-Type": "application/json" } },
      opts || {}
    ));
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data };
  }

  function updateAuthButton() {
    const b = document.getElementById("authBtn");
    if (!b) return;
    b.textContent = "👤 マイページ";
    b.title = currentUser ? `${currentUser.username} でログイン中（クラウド同期）・マイページ` : "マイページ（アカウント・保存・設定）";
  }

  async function checkAuth() {
    try {
      const { ok, data } = await apiJSON("/api/auth/me");
      currentUser = ok && data && data.user ? data.user : null;
    } catch (e) {
      currentUser = null; // サーバー無し（ファイル直開き等）は未ログイン扱い
    }
    updateAuthButton();
    if (currentUser) { try { await pullFromServer(); } catch (e) {} }
  }

  // サーバーの保存内容とローカルを比較し、新しい方を採用する
  async function pullFromServer() {
    const { ok, data } = await apiJSON("/api/list");
    if (!ok) return false;
    const remote = data.list;
    const localUpdated = Number(state.updatedAt || 0);
    const remoteUpdated = Number((remote && remote.updatedAt) || 0);
    const remoteValid = remote && Array.isArray(remote.tiers);
    if (remoteValid && (remoteUpdated >= localUpdated || totalMovies(state) === 0)) {
      applyRemoteState(remote);
      return true;
    }
    // サーバーが空、またはローカルの方が新しい → ローカルをアップロード
    await pushToServer();
    return false;
  }

  function applyRemoteState(obj) {
    applyingRemote = true;
    state = obj;
    if (!Array.isArray(state.tiers)) state.tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
    if (!Array.isArray(state.pool)) state.pool = [];
    if (!Array.isArray(state.watchlist)) state.watchlist = [];
    state.tiers.forEach((t) => { if (typeof t.collapsed !== "boolean") t.collapsed = false; });
    if (typeof state.poolCollapsed !== "boolean") state.poolCollapsed = false;
    zoneLimits.clear();
    lastMovieCount = allMovies().length;
    try {
      const s = JSON.stringify(state);
      saveMain(s);
      idbSave(s);
    } catch (e) {}
    updateThemeButton();
    updateFilterInfo();
    renderTiers();
    renderPool();
    updateTitleDisplay();
    updateCounter(allMovies().length);
    updateWatchlistBadge();
    applyingRemote = false;
  }

  function scheduleServerPush() {
    if (!currentUser || applyingRemote) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushToServer(); }, 1500);
  }

  async function pushToServer() {
    if (!currentUser) return;
    state.updatedAt = Date.now();
    try {
      const res = await fetch("/api/list", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      setAuthSyncStatus(res.ok ? "synced" : "error");
    } catch (e) {
      setAuthSyncStatus("offline");
    }
  }

  function setAuthSyncStatus(kind) {
    const el = document.getElementById("authSyncStatus");
    if (!el) return;
    const map = {
      synced: "✅ 同期済み",
      error: "⚠️ 保存に失敗しました",
      offline: "📴 オフライン（接続時に同期します）",
      saving: "… 同期中",
    };
    el.textContent = map[kind] || "";
  }

  function renderAuth() {
    const body = document.getElementById("authBody");
    if (!body) return;
    if (currentUser) {
      body.innerHTML =
        `<p class="auth-me">👤 <b>${escapeHtml(currentUser.username)}</b> でログイン中</p>` +
        `<p class="hint">変更は自動でアカウントにも保存されます。別の端末で同じアカウントにログインすると、同じリストを編集できます。</p>` +
        `<p id="authSyncStatus" class="auth-sync"></p>` +
        `<div class="settings-actions">` +
        `<button id="authSyncBtn" class="btn btn-ghost">↻ 今すぐ最新を取得</button>` +
        `<button id="authLogoutBtn" class="btn btn-danger">ログアウト</button>` +
        `</div>`;
      document.getElementById("authSyncBtn").addEventListener("click", async () => {
        setAuthSyncStatus("saving");
        const ok = await pullFromServer();
        setAuthSyncStatus("synced");
        toast(ok ? "最新のTier Listを取得しました" : "この端末の内容を同期しました");
      });
      document.getElementById("authLogoutBtn").addEventListener("click", doLogout);
    } else {
      body.innerHTML =
        `<p class="hint" style="margin-top:0">ログインすると、スマホなど別の端末でも同じリストを編集できます。ログインしなくても、この端末には自動で保存されます。</p>` +
        `<label class="field"><span>ユーザー名 または メールアドレス</span>` +
        `<input id="authUser" type="text" autocomplete="username" maxlength="254" /></label>` +
        `<label class="field"><span>パスワード（6文字以上）</span>` +
        `<input id="authPass" type="password" autocomplete="current-password" /></label>` +
        `<p id="authError" class="auth-error"></p>` +
        `<div class="settings-actions">` +
        `<button id="authLoginBtn" class="btn btn-primary">ログイン</button>` +
        `<button id="authRegisterBtn" class="btn btn-ghost">新規登録</button>` +
        `</div>`;
      document.getElementById("authLoginBtn").addEventListener("click", () => doAuth("login"));
      document.getElementById("authRegisterBtn").addEventListener("click", () => doAuth("register"));
      const pass = document.getElementById("authPass");
      if (pass) pass.addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth("login"); });
    }
    renderMyStatus();
  }

  function showAuthError(msg) {
    const el = document.getElementById("authError");
    if (el) el.textContent = msg;
  }

  async function doAuth(mode) {
    const username = (document.getElementById("authUser").value || "").trim();
    const password = document.getElementById("authPass").value || "";
    showAuthError("");
    if (!username || !password) { showAuthError("ユーザー名とパスワードを入力してください"); return; }
    const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    let resp;
    try {
      resp = await apiJSON(path, { method: "POST", body: JSON.stringify({ username, password }) });
    } catch (e) {
      showAuthError("サーバーに接続できません（python3 server.py を起動してください）");
      return;
    }
    if (!resp.ok) {
      const errs = {
        bad_username: "ユーザー名は半角英数・記号(_.-)の2〜32文字、またはメールアドレス形式にしてください",
        weak_password: "パスワードは6文字以上にしてください",
        exists: "そのユーザー名は既に使われています",
        registration_closed: "新規登録は現在受け付けていません",
        invalid_credentials: "ユーザー名またはパスワードが違います",
      };
      showAuthError(errs[resp.data && resp.data.error] || "処理に失敗しました");
      return;
    }
    currentUser = resp.data.user;
    updateAuthButton();
    await pullFromServer();
    renderAuth();
    setAuthSyncStatus("synced");
    toast(`${currentUser.username} でログインしました`);
  }

  async function doLogout() {
    try { await apiJSON("/api/auth/logout", { method: "POST" }); } catch (e) {}
    currentUser = null;
    updateAuthButton();
    renderAuth();
    toast("ログアウトしました（この端末のデータは残ります）");
  }

  // マイページ（アカウント＋保存・共有＋設定＋復元ポイントを統合）
  function openMyPage() {
    renderAuth();
    renderBackupList();
    openModal("settingsModal");
  }

  function removeMovie(movieId) {
    const found = findMovie(movieId);
    if (!found) return;
    const idx = found.from.indexOf(found.movie);
    if (idx > -1) found.from.splice(idx, 1);
    render();
  }

  function moveMovie(movieId, targetZoneId, beforeId) {
    const found = findMovie(movieId);
    if (!found) return;
    const target = getZoneArray(targetZoneId);
    if (!target) return;

    const idx = found.from.indexOf(found.movie);
    if (idx > -1) found.from.splice(idx, 1);
    if (found.from !== target) { delete found.movie.nitaku; delete found.movie.unseen; }

    if (beforeId) {
      const beforeIdx = target.findIndex((m) => m.id === beforeId);
      if (beforeIdx > -1) {
        target.splice(beforeIdx, 0, found.movie);
      } else {
        target.push(found.movie);
      }
    } else {
      target.push(found.movie);
    }
    render();
  }

  // =======================================================================
  // Drag & Drop (HTML5 native)
  // =======================================================================
  let dragId = null;

  function attachCardDnD(card) {
    card.addEventListener("dragstart", (e) => {
      dragId = card.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      dragId = null;
      document.querySelectorAll(".drag-over").forEach((z) => z.classList.remove("drag-over"));
    });
  }

  function attachZoneDnD(zone) {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", (e) => {
      if (e.target === zone) zone.classList.remove("drag-over");
    });
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      const id = dragId || e.dataTransfer.getData("text/plain");
      if (!id) return;
      const beforeEl = getDropTarget(zone, e.clientX, e.clientY);
      const beforeId = beforeEl ? beforeEl.dataset.id : null;
      moveMovie(id, zone.dataset.zone, beforeId);
    });
  }

  function getDropTarget(zone, x, y) {
    const cards = [...zone.querySelectorAll(".movie-card:not(.dragging)")];
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (y < r.top + r.height && x < r.left + r.width / 2 + 4 && y >= r.top) {
        return card;
      }
    }
    // fallback: find first card whose center is beyond the cursor (row-based)
    return cards.find((card) => {
      const r = card.getBoundingClientRect();
      return y < r.top + r.height / 2;
    }) || null;
  }

  // =======================================================================
  // Move menu (click a card to pick a tier — no dragging required)
  // =======================================================================
  let currentMenu = null;

  function closeMoveMenu() {
    if (currentMenu) {
      currentMenu.remove();
      currentMenu = null;
      document.removeEventListener("mousedown", onDocClickForMenu, true);
    }
  }

  function onDocClickForMenu(e) {
    if (currentMenu && !currentMenu.contains(e.target)) closeMoveMenu();
  }

  // ティア単位の並び替えメニュー（登録順 / あいうえお順）
  function openTierSortMenu(tier, anchorEl) {
    closeMoveMenu();
    const pop = document.createElement("div");
    pop.className = "move-menu tier-sort-menu";

    const titleEl = document.createElement("div");
    titleEl.className = "move-menu-title";
    titleEl.textContent = `「${tier.label}」を並び替え`;
    pop.appendChild(titleEl);

    const mk = (labelText, mode) => {
      const b = document.createElement("button");
      b.className = "btn btn-ghost btn-sm tier-sort-opt" + (tier.sortMode === mode ? " current" : "");
      b.textContent = labelText;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMoveMenu();
        sortTier(tier, mode);
        toast(`「${tier.label}」を${mode === "title" ? "あいうえお順" : "登録順"}に並び替えました`);
      });
      pop.appendChild(b);
    };
    mk("登録順（古い → 新しい）", "added");
    mk("あいうえお順（タイトル）", "title");

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
    }
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - pop.offsetHeight - 6);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    currentMenu = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocClickForMenu, true), 0);
  }

  function currentZoneOf(movieId) {
    const found = findMovie(movieId);
    if (!found) return null;
    if (found.from === state.pool) return "pool";
    if (found.from === state.watchlist) return "watchlist";
    const tier = state.tiers.find((t) => t.items === found.from);
    return tier ? tier.id : null;
  }

  function openMoveMenu(movie, anchorEl) {
    closeMoveMenu();
    const zone = currentZoneOf(movie.id);

    const pop = document.createElement("div");
    pop.className = "move-menu";

    const titleEl = document.createElement("div");
    titleEl.className = "move-menu-title";
    titleEl.textContent = "どこに入れる？";
    pop.appendChild(titleEl);

    const list = document.createElement("div");
    list.className = "move-tier-list";
    state.tiers.forEach((t) => {
      const b = document.createElement("button");
      b.className = "move-tier" + (t.id === zone ? " current" : "");
      b.style.background = t.color;
      b.innerHTML = `<span>${escapeHtml(t.label)}</span>`;
      b.title = t.label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMoveMenu();
        if (t.id !== zone) {
          moveMovie(movie.id, t.id);
          toast(`「${movie.title}」を ${t.label} に移動しました`);
        }
      });
      list.appendChild(b);
    });
    // 「観たい」ゾーンもティアと同じ選択肢として並べる
    const wlBtn = document.createElement("button");
    wlBtn.className = "move-tier move-tier-watchlist" + (zone === "watchlist" ? " current" : "");
    wlBtn.innerHTML = `<span>🔖 観たい</span>`;
    wlBtn.title = "観たい（あとで観る）へ";
    wlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMoveMenu();
      if (zone !== "watchlist") {
        moveMovie(movie.id, "watchlist");
        toast(`「${movie.title}」を 🔖 観たい に移動しました`);
      }
    });
    list.appendChild(wlBtn);
    pop.appendChild(list);

    const menuActions = document.createElement("div");
    menuActions.className = "move-menu-actions";
    const infoBtn = document.createElement("button");
    infoBtn.className = "btn btn-ghost btn-sm move-info-btn";
    infoBtn.textContent = "🎬 作品情報";
    infoBtn.title = "公開年・ジャンル・種別・監督・出演者・ポスターを表示／修正します";
    infoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMoveMenu();
      openMovieInfo(movie);
    });
    menuActions.appendChild(infoBtn);
    if (zone !== "pool") {
      const poolBtn = document.createElement("button");
      poolBtn.className = "btn btn-ghost btn-sm move-pool-btn";
      poolBtn.textContent = "未分類に戻す";
      poolBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMoveMenu();
        moveMovie(movie.id, "pool");
        toast(`「${movie.title}」を未分類に戻しました`);
      });
      menuActions.appendChild(poolBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm move-del-btn";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMoveMenu();
      removeMovie(movie.id);
      toast(`「${movie.title}」を削除しました`);
    });
    menuActions.appendChild(delBtn);
    pop.appendChild(menuActions);

    document.body.appendChild(pop);

    // position near the card, kept within viewport
    const r = anchorEl.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
    }
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - pop.offsetHeight - 6);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    currentMenu = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocClickForMenu, true), 0);
  }

  // =======================================================================
  // みんなのティア・友だちと比べる
  //   ティアの段数は人それぞれなので、作品を 0〜1 の点（一番上=1）にそろえて扱う。
  //   作品の同一判定（movieKey）は server.py の _movie_key と同じ規則にすること。
  // =======================================================================
  const KEY_STRIP = /[\s・:：\-－—―~〜!！?？'"“”‘’「」『』()（）\[\]【】.,、。]/g;
  const HIST_COLORS = ["#ff7f7f", "#ffbf7f", "#ffdf7f", "#bfff7f", "#7fbfff"];

  function movieKey(m) {
    const fid = String(m.filmarksId || "").trim();
    if (fid) return "f:" + fid;
    const t = String(m.title || "").normalize("NFKC").toLowerCase().replace(KEY_STRIP, "");
    return t ? "t:" + t + "|" + String(m.year || "").trim() : null;
  }

  function myRatings() {
    const out = {};
    const n = state.tiers.length;
    state.tiers.forEach((t, i) => {
      const s = n <= 1 ? 1 : (n - 1 - i) / (n - 1);
      (t.items || []).forEach((m) => {
        const k = movieKey(m);
        if (k && !(k in out)) out[k] = Math.round(s * 1e4) / 1e4;
      });
    });
    return out;
  }

  function scoreTier(s) {
    const n = state.tiers.length;
    if (!n) return null;
    return state.tiers[Math.min(n - 1, Math.max(0, Math.round((1 - s) * (n - 1))))];
  }
  function tierChip(s) {
    const t = scoreTier(s);
    return t ? `<span class="soc-tier" style="background:${escapeHtml(t.color || "#cfcfcf")}">${escapeHtml(t.label)}</span>` : "";
  }
  function score10(s) { return (s * 10).toFixed(1); }

  function histHtml(hist) {
    const total = hist.reduce((a, b) => a + b, 0) || 1;
    return `<div class="soc-hist" title="左ほど上のティア">` +
      hist.map((c, i) => (c ? `<span style="width:${(c / total) * 100}%;background:${HIST_COLORS[i]}"></span>` : "")).join("") +
      `</div>`;
  }

  function communitySummaryHtml(c, mine) {
    return `<div class="soc-sum">` +
      `<span class="soc-score"><b>${score10(c.avg)}</b><small>/10</small></span>` +
      `<span class="soc-sum-txt">あなたのティアでいうと ${tierChip(c.avg)}` +
      `<small>${c.count}人の平均${mine != null ? " ・ あなた " + tierChip(mine) : ""}</small></span>` +
      `</div>` + histHtml(c.hist);
  }

  async function loadCommunityInfo(movie) {
    const box = document.getElementById("infoCommunity");
    if (!box) return;
    const key = movieKey(movie);
    const reqId = movie.id;
    box.innerHTML = `<span class="soc-note">読み込み中…</span>`;
    let res = null;
    try {
      res = await apiJSON("/api/community/lookup", { method: "POST", body: JSON.stringify({ keys: key ? [key] : [] }) });
    } catch (e) {}
    if (infoMovieId !== reqId) return;
    if (!res || !res.ok) {
      box.innerHTML = `<span class="soc-note">サーバーに接続すると表示されます。</span>`;
      return;
    }
    const c = res.data.map && res.data.map[key];
    box.innerHTML = c
      ? communitySummaryHtml(c, myRatings()[key])
      : `<span class="soc-note">まだ評価した人が少ないため表示できません（あなた以外に${res.data.min}人以上が評価すると表示されます）。</span>`;
  }

  function socPoster(m) {
    return m.poster
      ? `<img class="soc-poster" src="${escapeHtml(m.poster)}" alt="" loading="lazy" />`
      : `<div class="soc-poster soc-poster-fallback">🎬</div>`;
  }

  function socWatchBtn(m) {
    const ref = { title: m.title, filmarksId: m.filmarksId || undefined };
    if (movieExists(ref)) return `<span class="soc-note">登録済み</span>`;
    if (watchlistExists(ref)) return `<span class="soc-note">✓ 観たいリストにあり</span>`;
    return `<button type="button" class="btn btn-ghost btn-sm soc-watch" data-key="${escapeHtml(m.key)}">🔖 観たい</button>`;
  }

  function bindWatchButtons(root, items) {
    const byKey = {};
    items.forEach((m) => { byKey[m.key] = m; });
    root.querySelectorAll(".soc-watch").forEach((b) => {
      b.addEventListener("click", () => {
        const m = byKey[b.dataset.key];
        if (!m) return;
        const mv = { title: m.title, poster: m.poster || "", year: m.year || "" };
        if (m.filmarksId) mv.filmarksId = m.filmarksId;
        if (addToWatchlist(mv)) {
          b.outerHTML = `<span class="soc-note">✓ 観たいリストに追加しました</span>`;
        }
      });
    });
  }

  function socRow(m, bodyHtml, rank) {
    return `<div class="soc-row">` +
      (rank ? `<span class="soc-rank">${rank}</span>` : "") +
      socPoster(m) +
      `<div class="soc-row-info">` +
      `<div class="soc-title">${escapeHtml(m.title || "（タイトル不明）")}${m.year ? ` <small>${escapeHtml(m.year)}</small>` : ""}</div>` +
      bodyHtml +
      `</div></div>`;
  }

  let socTab = "community";

  function openSocial(tab) {
    switchSocTab(tab || socTab);
    openModal("socialModal");
  }

  function switchSocTab(name) {
    socTab = name;
    document.querySelectorAll(".soc-tab").forEach((b) => b.classList.toggle("active", b.dataset.socTab === name));
    document.getElementById("socCommunity").classList.toggle("hidden", name !== "community");
    document.getElementById("socFriends").classList.toggle("hidden", name !== "friends");
    document.getElementById("socChallenges").classList.toggle("hidden", name !== "challenges");
    if (name === "community") renderCommunity();
    else if (name === "challenges") renderChallengeList();
    else renderFriends();
  }

  async function renderCommunity() {
    const box = document.getElementById("socCommunity");
    box.innerHTML = `<p class="soc-note">読み込み中…</p>`;
    const mine = myRatings();
    let top, look, social = null;
    try {
      [top, look] = await Promise.all([
        apiJSON("/api/community/top?limit=50"),
        apiJSON("/api/community/lookup", { method: "POST", body: JSON.stringify({ keys: Object.keys(mine) }) }),
      ]);
      if (currentUser) social = await apiJSON("/api/social");
    } catch (e) {}
    if (!top || !top.ok || !look || !look.ok) {
      box.innerHTML = `<p class="soc-note">サーバーに接続できません（python3 server.py を起動してください）。</p>`;
      return;
    }
    const min = top.data.min;
    const items = top.data.items || [];
    const lookMap = look.data.map || {};

    const gaps = Object.keys(lookMap).map((k) => {
      const m = movieByKey(k);
      return m ? { key: k, title: m.title, poster: m.poster, year: m.year, filmarksId: m.filmarksId,
        mine: mine[k], c: lookMap[k], diff: mine[k] - lookMap[k].avg } : null;
    }).filter((g) => g && Math.abs(g.diff) >= 0.25);
    const mineHigh = gaps.filter((g) => g.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 8);
    const mineLow = gaps.filter((g) => g.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 8);

    let html = `<p class="hint soc-lead">ログインしているユーザー全員のティアリストを、作品ごとに平均した「みんなのティア」です。` +
      `ティアの段数が違っても比べられるよう、一番上のティア＝10点、一番下＝0点に換算しています。` +
      `個人の評価が分からないよう、あなた以外の${min}人以上が評価した作品だけを表示します。</p>`;

    if (currentUser && social && social.ok) {
      html += `<label class="field field-check soc-optin"><input id="socOptIn" type="checkbox" ${social.data.community ? "checked" : ""}/>` +
        `<span>自分の評価をみんなのティアに含める（名前は出ません）</span></label>`;
    } else if (!currentUser) {
      html += `<p class="soc-note">ログインすると、あなたの評価もみんなのティアに加わります。</p>`;
    }

    html += `<h4 class="soc-h">🏆 みんなの高評価ランキング</h4>`;
    if (!items.length) {
      html += `<p class="soc-empty">まだ表示できる作品がありません。同じ作品を${min}人以上が評価すると、ここにランキングが出ます（現在の参加者：${top.data.raters}人）。</p>`;
    } else {
      html += `<div class="soc-list">` + items.map((m, i) => socRow(m,
        `<div class="soc-line"><span class="soc-score soc-score-sm"><b>${score10(m.avg)}</b><small>/10</small></span>` +
        `<small class="soc-dim">${m.count}人</small>${histHtml(m.hist)}</div>` +
        `<div class="soc-line">${mine[m.key] != null ? `<small class="soc-dim">あなた</small> ${tierChip(mine[m.key])}` : socWatchBtn(m)}</div>`,
        i + 1)).join("") + `</div>`;
    }

    if (mineHigh.length || mineLow.length) {
      const gapRow = (g) => socRow(g,
        `<div class="soc-line"><small class="soc-dim">あなた</small> ${tierChip(g.mine)}` +
        `<small class="soc-dim">みんな</small> ${tierChip(g.c.avg)}<small class="soc-dim">${score10(g.c.avg)}点・${g.c.count}人</small></div>`);
      html += `<h4 class="soc-h">🔀 あなたとみんなで評価が分かれた作品</h4><div class="soc-cols">` +
        `<div><p class="soc-sub">あなたは高評価・みんなは低め</p>${mineHigh.map(gapRow).join("") || `<p class="soc-empty">なし</p>`}</div>` +
        `<div><p class="soc-sub">みんなは高評価・あなたは低め</p>${mineLow.map(gapRow).join("") || `<p class="soc-empty">なし</p>`}</div>` +
        `</div>`;
    }
    box.innerHTML = html;
    bindWatchButtons(box, items);
    const opt = document.getElementById("socOptIn");
    if (opt) opt.addEventListener("change", async () => {
      const r = await apiJSON("/api/social", { method: "POST", body: JSON.stringify({ community: opt.checked }) });
      toast(r.ok ? (opt.checked ? "みんなのティアに参加しました" : "みんなのティアへの参加を止めました") : "変更に失敗しました");
      if (r.ok) renderCommunity();
    });
  }

  function movieByKey(k) {
    for (const t of state.tiers) {
      for (const m of t.items || []) if (movieKey(m) === k) return m;
    }
    return null;
  }

  function shareUrl(token) {
    return location.origin + location.pathname + "?compare=" + encodeURIComponent(token);
  }

  function parseShareToken(text) {
    const s = String(text || "").trim();
    const m = s.match(/[?&]compare=([A-Za-z0-9_\-]+)/);
    if (m) return m[1];
    return /^[A-Za-z0-9_\-]{6,40}$/.test(s) ? s : "";
  }

  function matchLabel(pct) {
    if (pct >= 80) return { cls: "up-match-high", label: "好みがそっくり" };
    if (pct >= 60) return { cls: "up-match-high", label: "かなり近い" };
    if (pct >= 40) return { cls: "up-match-mid", label: "まあまあ近い" };
    if (pct >= 20) return { cls: "up-match-low", label: "けっこう違う" };
    return { cls: "up-match-none", label: "正反対" };
  }

  async function renderFriends() {
    const box = document.getElementById("socFriends");
    box.innerHTML =
      `<p class="hint soc-lead">友だちの比較用リンクを開くと、好みの一致度・2人とも高評価の作品・評価が分かれた作品・友だちのおすすめが分かります。</p>` +
      `<h4 class="soc-h">🔗 あなたの比較用リンク</h4><div id="socMyLink"><p class="soc-note">読み込み中…</p></div>` +
      `<h4 class="soc-h">📩 友だちのリンクで比べる</h4>` +
      `<div class="soc-paste"><input id="socPasteInput" type="text" placeholder="友だちから届いたリンクを貼り付け" />` +
      `<button id="socPasteBtn" class="btn btn-primary btn-sm">比べる</button></div>` +
      `<div id="socFriendList"></div>` +
      `<div id="socCompareBox"></div>`;
    document.getElementById("socPasteBtn").addEventListener("click", () => {
      const token = parseShareToken(document.getElementById("socPasteInput").value);
      if (!token) { toast("リンクの形式が正しくありません"); return; }
      runCompare(token);
    });
    renderFriendList();
    renderMyLink();
  }

  function renderFriendList() {
    const wrap = document.getElementById("socFriendList");
    if (!wrap) return;
    const friends = state.friends || [];
    if (!friends.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = `<h4 class="soc-h">👥 比べた友だち</h4><div class="soc-friends">` +
      friends.map((f, i) =>
        `<div class="soc-friend"><button type="button" class="soc-friend-open" data-i="${i}">` +
        `<b>${escapeHtml(f.name)}</b><small>${f.match != null ? `一致度 ${f.match}%` : "一致度 —"}</small></button>` +
        `<button type="button" class="soc-friend-del" data-i="${i}" title="一覧から外す">✕</button></div>`).join("") +
      `</div>`;
    wrap.querySelectorAll(".soc-friend-open").forEach((b) =>
      b.addEventListener("click", () => runCompare(friends[Number(b.dataset.i)].token)));
    wrap.querySelectorAll(".soc-friend-del").forEach((b) =>
      b.addEventListener("click", () => {
        state.friends.splice(Number(b.dataset.i), 1);
        saveState();
        renderFriendList();
      }));
  }

  async function renderMyLink() {
    const wrap = document.getElementById("socMyLink");
    if (!wrap) return;
    if (!currentUser) {
      wrap.innerHTML = `<p class="soc-note">自分のリンクを作るにはログインが必要です。</p>` +
        `<button type="button" id="socLoginBtn" class="btn btn-ghost btn-sm">👤 マイページでログイン</button>`;
      document.getElementById("socLoginBtn").addEventListener("click", () => { closeModal("socialModal"); openMyPage(); });
      return;
    }
    let r = null;
    try { r = await apiJSON("/api/social"); } catch (e) {}
    if (!r || !r.ok) { wrap.innerHTML = `<p class="soc-note">読み込みに失敗しました。</p>`; return; }
    const d = r.data;
    wrap.innerHTML =
      `<label class="field"><span>友だちに表示される名前</span>` +
      `<div class="soc-paste"><input id="socDisplay" type="text" maxlength="24" value="${escapeHtml(d.display)}" />` +
      `<button id="socDisplaySave" class="btn btn-ghost btn-sm">変更</button></div></label>` +
      (d.share
        ? `<div class="soc-paste"><input id="socShareUrl" type="text" readonly value="${escapeHtml(shareUrl(d.share))}" />` +
          `<button id="socCopyBtn" class="btn btn-primary btn-sm">コピー</button></div>` +
          `<p class="hint">このリンクを知っている人は、あなたとの一致度、共通の作品へのあなたの評価、あなたの高評価作品の一部を見られます（リスト全体は見られません）。` +
          `<button type="button" id="socRevokeBtn" class="mp-link">リンクを止める</button></p>`
        : `<button id="socCreateBtn" class="btn btn-primary btn-sm">比較用リンクを作る</button>`);
    const post = async (body) => {
      const res = await apiJSON("/api/social", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) toast("変更に失敗しました");
      return res.ok;
    };
    document.getElementById("socDisplaySave").addEventListener("click", async () => {
      if (await post({ display: document.getElementById("socDisplay").value })) { toast("名前を変更しました"); renderMyLink(); }
    });
    const create = document.getElementById("socCreateBtn");
    if (create) create.addEventListener("click", async () => { if (await post({ share: "create" })) renderMyLink(); });
    const revoke = document.getElementById("socRevokeBtn");
    if (revoke) revoke.addEventListener("click", async () => {
      if (!confirm("比較用リンクを止めますか？これまでに渡したリンクは使えなくなります。")) return;
      if (await post({ share: "revoke" })) { toast("リンクを止めました"); renderMyLink(); }
    });
    const copy = document.getElementById("socCopyBtn");
    if (copy) copy.addEventListener("click", async () => {
      const input = document.getElementById("socShareUrl");
      try { await navigator.clipboard.writeText(input.value); } catch (e) { input.select(); document.execCommand("copy"); }
      toast("リンクをコピーしました");
    });
  }

  async function runCompare(token) {
    const box = document.getElementById("socCompareBox");
    if (!box) return;
    box.innerHTML = `<p class="soc-note">比べています…</p>`;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    let res = null;
    try {
      res = await apiJSON("/api/compare/" + encodeURIComponent(token), { method: "POST", body: JSON.stringify({ ratings: myRatings() }) });
    } catch (e) {}
    if (!res || !res.ok) {
      box.innerHTML = `<p class="soc-empty">${res && res.status === 404 ? "このリンクは使えません（止められた可能性があります）。" : "サーバーに接続できません。"}</p>`;
      return;
    }
    const d = res.data;
    if (!d.self) {
      state.friends = (state.friends || []).filter((f) => f.token !== token);
      state.friends.unshift({ token, name: d.name, match: d.match, at: Date.now() });
      saveState();
      renderFriendList();
    }
    const name = escapeHtml(d.name);
    let html = `<div class="soc-compare">`;
    if (d.self) html += `<p class="soc-note">これはあなた自身のリンクです。友だちに送って比べてもらいましょう。</p>`;
    if (d.match != null) {
      const t = matchLabel(d.match);
      html += `<div class="up-match soc-meter ${t.cls}"><div class="up-match-head">` +
        `<span class="up-match-label">🤝 ${name} さんとの一致度 <b>${d.match}%</b></span>` +
        `<span class="up-match-tag">${t.label}</span></div>` +
        `<div class="up-match-bar"><span style="width:${d.match}%"></span></div></div>`;
    } else {
      html += `<p class="soc-note">🤝 ${name} さん：共通の作品が5本以上になると一致度を出せます。</p>`;
    }
    html += `<p class="soc-dim soc-common">共通して観た作品 <b>${d.common}</b> 本 ／ ${name} さんの登録 ${d.friendTotal} 本</p>`;
    const pair = (m) => socRow(m,
      `<div class="soc-line"><small class="soc-dim">あなた</small> ${tierChip(m.mine)}<small class="soc-dim">${name}</small> ${tierChip(m.friend)}</div>`);
    if (d.both.length) html += `<h4 class="soc-h">💞 2人とも高評価</h4><div class="soc-list">${d.both.map(pair).join("")}</div>`;
    if (d.split.length) html += `<h4 class="soc-h">⚡ 評価が分かれた作品</h4><div class="soc-list">${d.split.map(pair).join("")}</div>`;
    if (d.recs.length) {
      html += `<h4 class="soc-h">🎁 ${name} さんのおすすめ（あなたは未登録）</h4><div class="soc-list">` +
        d.recs.map((m) => socRow(m,
          `<div class="soc-line"><small class="soc-dim">${name}</small> ${tierChip(m.friend)}</div><div class="soc-line">${socWatchBtn(m)}</div>`)).join("") +
        `</div>`;
    }
    html += `<p class="hint">ティアの名前は、相手の評価をあなたのティアの段階に置きかえて表示しています。</p></div>`;
    box.innerHTML = html;
    bindWatchButtons(box, d.recs);
  }

  function handleCompareLink() {
    const params = new URLSearchParams(location.search);
    const token = parseShareToken(params.get("compare") ? "?compare=" + params.get("compare") : "");
    if (!token) return;
    params.delete("compare");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    openSocial("friends");
    runCompare(token);
  }

  // =======================================================================
  // お題（テーマを共有し、同じ作品セットでティアリストを作ってもらう）
  // =======================================================================
  const CHALLENGE_TAG = "📣";

  function challengePid() {
    if (!state.challengePid) {
      state.challengePid = uid().replace(/[^A-Za-z0-9_-]/g, "");
      saveState();
    }
    return state.challengePid;
  }

  function challengeUrl(id) {
    return location.origin + location.pathname + "?challenge=" + encodeURIComponent(id);
  }

  function myChallenges() {
    if (!Array.isArray(state.challenges)) state.challenges = [];
    return state.challenges;
  }

  function rememberChallenge(entry) {
    const list = myChallenges().filter((c) => c.id !== entry.id);
    list.unshift({ ...entry, at: Date.now() });
    state.challenges = list.slice(0, 50);
    saveState();
  }

  function sameFilters(a, b) {
    if (!a || a.length !== b.length) return false;
    return a.every((f) => b.some((g) => g.type === f.type && g.value === f.value));
  }

  // いま表示中の絞り込みが、参加中・作成したお題と一致すればそれを返す
  function activeChallenge() {
    if (!hasFilter()) return null;
    return myChallenges().find((c) =>
      c.tag
        ? activeFilters.length === 1 && activeFilters[0].type === "userTheme" && activeFilters[0].value === c.tag
        : sameFilters(c.filters, activeFilters) && (c.mode || "and") === filterMode) || null;
  }

  function findOwnMovie(mv) {
    const nt = normTitle(mv.title);
    return allMovies().find((m) =>
      (mv.filmarksId && m.filmarksId === mv.filmarksId) || (nt && normTitle(m.title) === nt)) || null;
  }

  // お題の作品ごとに、自分のティアでの点（一番上=1、一番下=0）を集める
  function challengeRatings(movies) {
    const n = state.tiers.length;
    const byId = new Map();
    state.tiers.forEach((t, i) => {
      const s = n <= 1 ? 1 : (n - 1 - i) / (n - 1);
      (t.items || []).forEach((m) => byId.set(m.id, Math.round(s * 1e4) / 1e4));
    });
    const out = {};
    movies.forEach((mv) => {
      const own = findOwnMovie(mv);
      if (own && byId.has(own.id)) out[mv.key] = byId.get(own.id);
    });
    return out;
  }

  function challengeMovieOut(m) {
    const o = { title: m.title, year: m.year || "", poster: /^(https?:|\/api\/img\?u=)/.test(m.poster || "") ? m.poster : "" };
    if (m.filmarksId) o.filmarksId = m.filmarksId;
    return o;
  }

  function challengeName() {
    return state.challengeName || (currentUser && currentUser.display) || "";
  }

  function challengePosterGrid(movies, opts = {}) {
    return `<div class="ch-grid">` + movies.map((m, i) => {
      const own = opts.pick ? findOwnMovie(m) : null;
      const img = m.poster
        ? `<img src="${escapeHtml(m.poster)}" alt="" loading="lazy" />`
        : `<div class="ch-fallback">${escapeHtml(m.title)}</div>`;
      const inner = `${img}<span class="ch-cap">${escapeHtml(m.title)}</span>`;
      if (!opts.pick) return `<div class="ch-cell">${inner}</div>`;
      return `<label class="ch-cell ch-pick"><input type="checkbox" data-i="${i}" checked />` +
        `${inner}${own ? `<span class="ch-own">登録済み</span>` : ""}<span class="ch-check">✓</span></label>`;
    }).join("") + `</div>`;
  }

  function challengeShareHtml(ch) {
    const url = challengeUrl(ch.id);
    return `<div class="ch-share">` +
      `<div class="soc-paste"><input id="chUrl" type="text" readonly value="${escapeHtml(url)}" />` +
      `<button type="button" id="chCopy" class="btn btn-primary btn-sm">コピー</button></div>` +
      `<div class="ch-share-btns">` +
      (navigator.share ? `<button type="button" id="chNative" class="btn btn-primary btn-sm">📤 アプリで送る</button>` : "") +
      `<button type="button" id="chX" class="btn btn-x btn-sm">𝕏 で呼びかける</button>` +
      `<button type="button" id="chLine" class="btn btn-ghost btn-sm">LINEで送る</button>` +
      `</div></div>`;
  }

  function challengeInviteText(ch) {
    return `「${ch.title}」のティアリストを作ってみて！全${ch.movies.length}本、あなたならどう並べる？ #Pickture`;
  }

  function bindChallengeShare(ch) {
    const url = challengeUrl(ch.id);
    const text = challengeInviteText(ch);
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
    on("chCopy", async () => {
      try { await navigator.clipboard.writeText(url); } catch (e) {
        const i = document.getElementById("chUrl"); i.select(); document.execCommand("copy");
      }
      toast("リンクをコピーしました");
    });
    on("chNative", () => navigator.share({ title: ch.title, text, url }).catch(() => {}));
    on("chX", () => window.open("https://x.com/intent/post?text=" + encodeURIComponent(text) +
      "&url=" + encodeURIComponent(url), "_blank", "noopener"));
    on("chLine", () => window.open("https://social-plugins.line.me/lineit/share?url=" + encodeURIComponent(url) +
      "&text=" + encodeURIComponent(text), "_blank", "noopener"));
  }

  // ---- 作成（呼びかける側） ----
  const CHALLENGE_MAX = 150;
  const CHALLENGE_YEAR_TOP = 60;

  // テーマの「全作品」を Filmarks から取得できる場合はその一覧、できなければ null
  function challengeUniverseLabel(f) {
    if (f.type === "director") return `Filmarks の「${f.value}」監督作品`;
    if (f.type === "actor") return `Filmarks の「${f.value}」出演作品`;
    if (f.type === "collection" && COLLECTIONS.some((c) => c.label === f.value)) return `「${f.value}」の全作品`;
    if (f.type === "year") return `${f.value}年公開の話題作 上位${CHALLENGE_YEAR_TOP}本`;
    return null;
  }

  async function fetchChallengeUniverse(f) {
    if (f.type === "director" || f.type === "actor") {
      const p = await filmarksPersonFirst(f.value);
      if (!p) return [];
      return (await filmarksPersonFilms(p.id)).map((r) =>
        ({ title: r.title, year: r.year || "", poster: r.poster || "", filmarksId: r.id }));
    }
    if (f.type === "year") {
      const { results } = await fetchFilmarksRange(f.value, 1, 2);
      return results.slice(0, CHALLENGE_YEAR_TOP).map((r) =>
        ({ title: r.title, year: r.year || "", poster: r.poster || "", filmarksId: r.id }));
    }
    if (f.type === "collection") {
      const col = COLLECTIONS.find((c) => c.label === f.value);
      const titles = (col ? col.titles : []).map((t) => (typeof t === "string" ? { title: t, year: "" } : t));
      const out = new Array(titles.length);
      let next = 0;
      const worker = async () => {
        while (next < titles.length) {
          const i = next++;
          const t = titles[i];
          let results = [];
          try { results = await searchFilmarks(t.title); } catch (e) {}
          const m = pickPosterMatch(results, t.title, t.year) || results[0];
          out[i] = m
            ? { title: m.title || t.title, year: t.year || m.year || "", poster: m.poster || "", filmarksId: m.filmarksId }
            : { title: t.title, year: t.year || "", poster: "" };
        }
      };
      await Promise.all([1, 2, 3, 4].map(worker));
      return out.filter(Boolean);
    }
    return [];
  }

  // 取得した全作品に、自分の登録作（取得漏れ分も含む）を合わせる
  function mergeUniverse(universe, own) {
    const out = [];
    const seen = new Set();
    const keyOf = (m) => (m.filmarksId ? "f:" + m.filmarksId : "") + "|" + normTitle(m.title);
    const has = (m) => [...seen].some((k) => {
      const [fid, t] = k.split("|");
      return (m.filmarksId && fid === "f:" + m.filmarksId) || (t && t === normTitle(m.title));
    });
    const push = (m) => { if (!has(m)) { seen.add(keyOf(m)); out.push(m); } };
    universe.forEach((u) => push(findOwnMovie(u) || u));
    own.forEach(push);
    return out;
  }

  const chCreate = { mode: "all", own: [], universe: null, filter: null };

  async function openChallengeCreate() {
    if (!hasFilter()) { toast("先に「テーマで絞り込み」でテーマを選んでください"); return; }
    const own = allMovies().filter(matchesFilter);
    const f = activeFilters.length === 1 ? activeFilters[0] : null;
    const label = f ? challengeUniverseLabel(f) : null;
    if (!label && own.length < 2) { toast("お題にするには2本以上の作品が必要です"); return; }
    Object.assign(chCreate, { mode: label ? "all" : "own", own, universe: null, filter: f, label });
    const ranked = Object.keys(challengeRatings(own.map((m) => ({ ...m, key: m.id })))).length;
    const body = document.getElementById("challengeBody");
    body.innerHTML =
      `<p class="hint soc-lead">このテーマの作品セットをリンクで共有し、みんなに同じ作品でティアリストを作ってもらいます。` +
      `集まった結果は「みんなのランキング」として見られます。</p>` +
      `<label class="field"><span>お題のタイトル</span><input id="chTitle" type="text" maxlength="60" value="${escapeHtml(themeFilterName())}" /></label>` +
      `<label class="field"><span>ひとこと（任意）</span><input id="chNote" type="text" maxlength="200" placeholder="例：観た作品だけでOK！あなたのSは？" /></label>` +
      `<label class="field"><span>あなたの表示名</span><input id="chName" type="text" maxlength="24" value="${escapeHtml(challengeName())}" placeholder="名無しさん" /></label>` +
      `<label class="ch-opt"><input id="chWithMine" type="checkbox" ${ranked ? "checked" : "disabled"} /> ` +
      `自分のティアも見せる<small>${ranked ? `（ランク済み ${ranked} 本。参加者が自分の結果と比べられます）` : "（まだティアに振り分けた作品がありません）"}</small></label>` +
      `<div class="field"><span>対象の作品</span>` +
      (label
        ? `<div class="share-seg ch-scope"><button type="button" data-scope="all">🎬 テーマの全作品</button>` +
          `<button type="button" data-scope="own">📋 自分の登録作だけ（${own.length}本）</button></div>`
        : `<p class="soc-dim ch-scope-note">このテーマは全作品を特定できないため、あなたの登録作（${own.length}本）が対象です。</p>`) +
      `</div><div id="chScopeBody"></div>` +
      `<div class="ch-actions"><button type="button" id="chCreate" class="btn btn-primary">📣 呼びかけリンクを作る</button></div>`;
    body.querySelectorAll(".ch-scope button").forEach((b) =>
      b.addEventListener("click", () => { chCreate.mode = b.dataset.scope; renderChallengeScope(); }));
    document.getElementById("chCreate").addEventListener("click", () => {
      const boxes = [...document.querySelectorAll("#chScopeBody .ch-pick input")];
      const picked = boxes.filter((b) => b.checked).map((b) => chCreate.list[Number(b.dataset.i)]);
      if (picked.length < 2) { toast("2本以上選んでください"); return; }
      createChallenge(picked);
    });
    openModal("challengeModal");
    renderChallengeScope();
  }

  async function renderChallengeScope() {
    const wrap = document.getElementById("chScopeBody");
    if (!wrap) return;
    document.querySelectorAll(".ch-scope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === chCreate.mode));
    const btn = document.getElementById("chCreate");
    if (chCreate.mode === "all" && !chCreate.universe) {
      wrap.innerHTML = `<p class="soc-note">${escapeHtml(chCreate.label)}を取得中…</p>`;
      btn.disabled = true;
      const f = chCreate.filter;
      let films = [];
      try { films = await fetchChallengeUniverse(f); } catch (e) {}
      if (chCreate.filter !== f) return;
      chCreate.universe = films;
      if (!films.length) {
        chCreate.mode = "own";
        toast("全作品を取得できなかったため、自分の登録作を対象にします");
      }
      if (!document.getElementById("chScopeBody")) return;
      renderChallengeScope();
      return;
    }
    btn.disabled = false;
    let list = chCreate.mode === "all" ? mergeUniverse(chCreate.universe, chCreate.own) : chCreate.own.slice();
    const total = list.length;
    list = list.slice(0, CHALLENGE_MAX);
    chCreate.list = list;
    wrap.innerHTML =
      `<div class="ch-pickbar"><span id="chPickCount"></span>` +
      `<button type="button" id="chAll" class="mp-link">すべて選択</button><button type="button" id="chNone" class="mp-link">すべて外す</button></div>` +
      (chCreate.mode === "all" ? `<p class="soc-dim">${escapeHtml(chCreate.label)}（短編・ドキュメンタリーなど、お題に合わない作品はチェックを外せます）</p>` : "") +
      (total > list.length ? `<p class="soc-dim">多すぎるため先頭${list.length}本までが対象です。</p>` : "") +
      challengePosterGrid(list, { pick: true });
    const boxes = [...wrap.querySelectorAll(".ch-pick input")];
    const count = () => {
      document.getElementById("chPickCount").textContent = `${boxes.filter((b) => b.checked).length} / ${boxes.length} 本を対象にする`;
    };
    boxes.forEach((b) => b.addEventListener("change", count));
    document.getElementById("chAll").addEventListener("click", () => { boxes.forEach((b) => (b.checked = true)); count(); });
    document.getElementById("chNone").addEventListener("click", () => { boxes.forEach((b) => (b.checked = false)); count(); });
    count();
  }

  async function createChallenge(movies) {
    const $ = (id) => document.getElementById(id);
    const title = $("chTitle").value.trim();
    if (!title) { toast("タイトルを入れてください"); return; }
    const name = $("chName").value.trim();
    state.challengeName = name;
    const payload = movies.map(challengeMovieOut);
    let ratings = {};
    if ($("chWithMine").checked) {
      const keyed = payload.map((m) => ({ ...m, key: movieKey(m) }));
      ratings = challengeRatings(keyed);
    }
    const btn = $("chCreate");
    btn.disabled = true;
    btn.textContent = "作成中…";
    let res = null;
    try {
      res = await apiJSON("/api/challenge", { method: "POST", body: JSON.stringify({
        title, note: $("chNote").value.trim(), name, pid: challengePid(), movies: payload, ratings }) });
    } catch (e) {}
    if (!res || !res.ok) {
      btn.disabled = false;
      btn.textContent = "📣 呼びかけリンクを作る";
      toast("作成できませんでした（サーバーに接続できるか確認してください）");
      return;
    }
    const ch = res.data;
    rememberChallenge({ id: ch.id, title: ch.title, owner: true,
      filters: activeFilters.map((f) => ({ ...f })), mode: filterMode });
    document.getElementById("challengeBody").innerHTML =
      `<div class="ch-done"><div class="ch-done-icon">📣</div>` +
      `<h4>「${escapeHtml(ch.title)}」のお題を作りました</h4>` +
      `<p class="hint">リンクを送ると、相手は同じ ${ch.movies.length} 本でティアリストを作れます。結果が届くと「みんなのランキング」に反映されます。</p></div>` +
      challengeShareHtml(ch) +
      `<div class="ch-actions"><button type="button" id="chSeeResults" class="btn btn-ghost">📊 結果を見る</button></div>`;
    bindChallengeShare(ch);
    document.getElementById("chSeeResults").addEventListener("click", () => openChallengeResults(ch.id));
    render();
  }

  // ---- 参加（リンクを受け取った側） ----
  async function fetchChallenge(id) {
    try {
      return await apiJSON("/api/challenge/" + encodeURIComponent(id) + "?pid=" + encodeURIComponent(challengePid()));
    } catch (e) { return null; }
  }

  async function openChallengeLanding(id) {
    const body = document.getElementById("challengeBody");
    body.innerHTML = `<p class="soc-note">お題を読み込み中…</p>`;
    openModal("challengeModal");
    const res = await fetchChallenge(id);
    if (!res || !res.ok) {
      body.innerHTML = `<p class="soc-empty">${res && res.status === 404 ? "このお題は見つかりませんでした。" : "サーバーに接続できません。"}</p>`;
      return;
    }
    const ch = res.data;
    if (ch.isOwner || myChallenges().some((c) => c.id === ch.id)) { renderChallengeResults(ch); return; }
    body.innerHTML =
      `<div class="ch-hero"><span class="ch-from">${escapeHtml(ch.creator)} さんからのお題</span>` +
      `<h4 class="ch-title">${escapeHtml(ch.title)}</h4>` +
      (ch.note ? `<p class="ch-note">“${escapeHtml(ch.note)}”</p>` : "") +
      `<p class="soc-dim">全 <b>${ch.movies.length}</b> 本 ・ 参加 <b>${ch.participants}</b> 人</p></div>` +
      `<p class="hint">観た作品にチェックを入れたまま「このお題で作る」を押すと、あなたのティアリストに追加され、このお題の作品だけが表示されます。</p>` +
      `<div class="ch-pickbar"><span id="chPickCount"></span>` +
      `<button type="button" id="chAll" class="mp-link">すべて選択</button><button type="button" id="chNone" class="mp-link">すべて外す</button></div>` +
      challengePosterGrid(ch.movies, { pick: true }) +
      `<label class="ch-opt"><input id="chToWish" type="checkbox" checked /> チェックを外した作品は「観たい」リストに入れる</label>` +
      `<label class="field"><span>あなたの表示名（結果に表示されます）</span><input id="chJoinName" type="text" maxlength="24" value="${escapeHtml(challengeName())}" placeholder="名無しさん" /></label>` +
      `<div class="ch-actions"><button type="button" id="chJoin" class="btn btn-primary">🎬 このお題で作る</button></div>`;
    const boxes = [...body.querySelectorAll(".ch-pick input")];
    const count = () => {
      document.getElementById("chPickCount").textContent = `${boxes.filter((b) => b.checked).length} / ${boxes.length} 本を選択中`;
    };
    boxes.forEach((b) => b.addEventListener("change", count));
    document.getElementById("chAll").addEventListener("click", () => { boxes.forEach((b) => (b.checked = true)); count(); });
    document.getElementById("chNone").addEventListener("click", () => { boxes.forEach((b) => (b.checked = false)); count(); });
    count();
    document.getElementById("chJoin").addEventListener("click", () => {
      const picked = boxes.filter((b) => b.checked).map((b) => ch.movies[Number(b.dataset.i)]);
      const skipped = boxes.filter((b) => !b.checked).map((b) => ch.movies[Number(b.dataset.i)]);
      if (!picked.length) { toast("観た作品を1本以上選んでください"); return; }
      state.challengeName = document.getElementById("chJoinName").value.trim();
      joinChallenge(ch, picked, document.getElementById("chToWish").checked ? skipped : []);
    });
  }

  function joinChallenge(ch, picked, toWish) {
    const tag = CHALLENGE_TAG + ch.title;
    let added = 0;
    picked.forEach((mv) => {
      let own = findOwnMovie(mv);
      if (!own) {
        removeFromWatchlistByMatch(mv);
        own = { id: uid(), ...challengeMovieOut(mv) };
        state.pool.push(own);
        added++;
      }
      own.userThemes = [...new Set([...(own.userThemes || []), tag])];
    });
    if (toWish.length) addFilmsToWatchlist(toWish.map(challengeMovieOut));
    rememberChallenge({ id: ch.id, title: ch.title, tag, owner: false });
    activeFilters = [{ type: "userTheme", value: tag }];
    filterMode = "and";
    zoneLimits.clear();
    render();
    closeModal("challengeModal");
    toast(added ? `${added} 本を未分類に追加しました。ティアに振り分けて「結果を送る」を押してください`
      : "ティアに振り分けて「結果を送る」を押してください");
  }

  // ---- 結果 ----
  async function openChallengeResults(id, submit) {
    const body = document.getElementById("challengeBody");
    body.innerHTML = `<p class="soc-note">${submit ? "結果を送っています…" : "読み込み中…"}</p>`;
    openModal("challengeModal");
    let res = await fetchChallenge(id);
    if (res && res.ok && submit) {
      const ratings = challengeRatings(res.data.movies);
      if (!Object.keys(ratings).length) {
        toast("まだティアに振り分けた作品がありません");
      } else {
        try {
          res = await apiJSON("/api/challenge/" + encodeURIComponent(id) + "/entry", { method: "POST",
            body: JSON.stringify({ pid: challengePid(), name: challengeName(), ratings }) });
          if (res && res.ok) toast(`${Object.keys(ratings).length} 本の結果を送りました`);
        } catch (e) { res = null; }
      }
    }
    if (!res || !res.ok) {
      body.innerHTML = `<p class="soc-empty">${res && res.status === 404 ? "このお題は見つかりませんでした。" : "サーバーに接続できません。"}</p>`;
      return;
    }
    renderChallengeResults(res.data);
  }

  function renderChallengeResults(ch) {
    const body = document.getElementById("challengeBody");
    const creator = escapeHtml(ch.creator);
    const mine = ch.mine || challengeRatings(ch.movies);
    const sent = !!ch.mine;
    const rated = ch.movies.filter((m) => ch.stats[m.key])
      .sort((a, b) => ch.stats[b.key].avg - ch.stats[a.key].avg || ch.stats[b.key].count - ch.stats[a.key].count);
    const unrated = ch.movies.filter((m) => !ch.stats[m.key]);
    let html =
      `<div class="ch-hero"><span class="ch-from">${ch.isOwner ? "あなたのお題" : `${creator} さんからのお題`}</span>` +
      `<h4 class="ch-title">${escapeHtml(ch.title)}</h4>` +
      `<p class="soc-dim">全 <b>${ch.movies.length}</b> 本 ・ 参加 <b>${ch.participants}</b> 人` +
      (ch.names.length ? `<br><small>${ch.names.map(escapeHtml).join("、")}</small>` : "") + `</p></div>`;
    if (!ch.isOwner) {
      html += `<div class="ch-actions">` +
        `<button type="button" id="chOpenBoard" class="btn btn-ghost">🎬 ティアリストで並べる</button>` +
        `<button type="button" id="chSubmit" class="btn btn-primary">${sent ? "↻ 結果を送り直す" : "📨 結果を送る"}</button></div>`;
    } else {
      html += `<div class="ch-actions"><button type="button" id="chSubmit" class="btn btn-ghost">↻ 自分のティアを反映し直す</button></div>`;
    }
    if (ch.match != null) {
      const t = matchLabel(ch.match);
      html += `<div class="up-match soc-meter ${t.cls}"><div class="up-match-head">` +
        `<span class="up-match-label">🤝 ${creator} さんとの一致度 <b>${ch.match}%</b></span>` +
        `<span class="up-match-tag">${t.label}</span></div>` +
        `<div class="up-match-bar"><span style="width:${ch.match}%"></span></div></div>`;
    }
    const hasOwner = Object.keys(ch.ownerRatings).length > 0;
    html += `<h4 class="soc-h">🏆 みんなのランキング</h4>`;
    if (!rated.length) {
      html += `<p class="soc-empty">まだ結果が届いていません。リンクを送って呼びかけましょう。</p>`;
    } else {
      html += `<div class="soc-list">` + rated.map((m, i) => {
        const st = ch.stats[m.key];
        const chips = `<div class="soc-line"><small class="soc-dim">みんな</small> ${tierChip(st.avg)}<small class="soc-dim">${st.count}人</small>` +
          (mine[m.key] != null ? ` <small class="soc-dim">あなた</small> ${tierChip(mine[m.key])}` : "") +
          (hasOwner && !ch.isOwner && ch.ownerRatings[m.key] != null ? ` <small class="soc-dim">${creator}</small> ${tierChip(ch.ownerRatings[m.key])}` : "") +
          `</div>`;
        return socRow(m, chips + histHtml(st.hist), i + 1);
      }).join("") + `</div>`;
    }
    if (unrated.length) {
      html += `<h4 class="soc-h">まだ誰も評価していない作品（${unrated.length}本）</h4>` + challengePosterGrid(unrated);
    }
    html += `<h4 class="soc-h">📣 もっと呼びかける</h4>` + challengeShareHtml(ch) +
      `<p class="hint">ティアの名前は、みんなの平均点をあなたのティアの段階に置きかえて表示しています。</p>`;
    body.innerHTML = html;
    bindChallengeShare(ch);
    const submit = document.getElementById("chSubmit");
    if (submit) submit.addEventListener("click", () => openChallengeResults(ch.id, true));
    const board = document.getElementById("chOpenBoard");
    if (board) board.addEventListener("click", () => {
      const c = myChallenges().find((x) => x.id === ch.id);
      if (!c) { openChallengeLanding(ch.id); return; }
      applyChallengeFilter(c);
      closeModal("challengeModal");
    });
  }

  function applyChallengeFilter(c) {
    if (c.tag) { activeFilters = [{ type: "userTheme", value: c.tag }]; filterMode = "and"; }
    else { activeFilters = (c.filters || []).map((f) => ({ ...f })); filterMode = c.mode || "and"; }
    zoneLimits.clear();
    render();
  }

  // 絞り込みがお題と一致しているときに、進み具合と「結果を送る」を出す
  function renderChallengeBar() {
    const bar = document.getElementById("challengeBar");
    if (!bar) return;
    const c = activeChallenge();
    if (!c) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
    const items = allMovies().filter(matchesFilter);
    const inTier = new Set(state.tiers.flatMap((t) => (t.items || []).map((m) => m.id)));
    const done = items.filter((m) => inTier.has(m.id)).length;
    bar.classList.remove("hidden");
    bar.innerHTML =
      `<span class="ch-bar-label">📣 ${c.owner ? "あなたのお題" : "お題に参加中"}：<b>${escapeHtml(c.title)}</b></span>` +
      `<span class="ch-bar-progress">ティアに振り分け済み ${done} / ${items.length} 本</span>` +
      `<span class="ch-bar-btns">` +
      (c.owner ? "" : `<button type="button" class="btn btn-primary btn-sm" data-ch="send">📨 結果を送る</button>`) +
      `<button type="button" class="btn btn-ghost btn-sm" data-ch="view">📊 みんなの結果</button></span>`;
    bar.querySelectorAll("[data-ch]").forEach((b) =>
      b.addEventListener("click", () => openChallengeResults(c.id, b.dataset.ch === "send")));
  }

  function renderChallengeList() {
    const box = document.getElementById("socChallenges");
    const list = myChallenges();
    box.innerHTML =
      `<p class="hint soc-lead">「テーマで絞り込み」でテーマを選び <b>📣 お題にする</b> を押すと、同じ作品セットでティアリストを作ってもらうリンクを作れます。届いたリンクを開くとお題に参加できます。</p>` +
      (list.length
        ? `<div class="soc-friends">` + list.map((c, i) =>
          `<div class="soc-friend"><button type="button" class="soc-friend-open" data-i="${i}">` +
          `<b>${escapeHtml(c.title)}</b><small>${c.owner ? "作成したお題" : "参加中"}</small></button>` +
          `<button type="button" class="soc-friend-del" data-i="${i}" title="一覧から外す">✕</button></div>`).join("") + `</div>`
        : `<p class="soc-empty">まだお題はありません。</p>`);
    box.querySelectorAll(".soc-friend-open").forEach((b) => b.addEventListener("click", () => {
      closeModal("socialModal");
      openChallengeResults(list[Number(b.dataset.i)].id);
    }));
    box.querySelectorAll(".soc-friend-del").forEach((b) => b.addEventListener("click", () => {
      state.challenges.splice(Number(b.dataset.i), 1);
      saveState();
      renderChallengeList();
      render();
    }));
  }

  function handleChallengeLink() {
    const params = new URLSearchParams(location.search);
    const id = params.get("challenge");
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return;
    params.delete("challenge");
    const qs = params.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    openChallengeLanding(id);
  }

  // =======================================================================
  // 作品情報エディタ（公開年・ジャンル・種別・監督・出演者・ポスターを表示／修正）
  // =======================================================================
  let infoMovieId = null;
  let infoPosterData = null; // アップロードした画像の dataURL（変更が無ければ null）

  function openMovieInfo(movie) {
    infoMovieId = movie.id;
    infoPosterData = null;
    const $ = (id) => document.getElementById(id);
    $("infoTitle").value = movie.title || "";
    $("infoYear").value = movie.year || "";
    $("infoKind").value = movie.kind || "";
    $("infoDirectors").value = ((movie.meta && movie.meta.directors) || []).join(", ");
    $("infoCast").value = ((movie.meta && movie.meta.cast) || []).join(", ");
    $("infoUserThemes").value = (movie.userThemes || []).join(", ");
    const utList = $("userThemeList");
    if (utList) {
      utList.innerHTML = allUserThemeNames()
        .map((t) => `<option value="${escapeHtml(t)}"></option>`)
        .join("");
    }
    $("infoComment").value = movie.comment || "";
    $("infoPosterUrl").value = "";
    const fileInput = $("infoPosterFile");
    if (fileInput) fileInput.value = "";
    setInfoPreview(movie.poster || "");
    // ジャンル: 自動取得(m.genres)＋タイトル一致のジャンルを初期チェック
    const cur = new Set((movie.genres || []));
    movieCollections(movie).forEach((l) => { if (GENRES.some((g) => g.label === l)) cur.add(l); });
    const wrap = $("infoGenres");
    wrap.innerHTML = "";
    GENRES.forEach((g) => {
      const lbl = document.createElement("label");
      lbl.className = "info-genre-chip";
      lbl.innerHTML =
        `<input type="checkbox" value="${escapeHtml(g.label)}" ${cur.has(g.label) ? "checked" : ""}/>` +
        `<span>${g.emoji} ${escapeHtml(g.label)}</span>`;
      wrap.appendChild(lbl);
    });
    openModal("movieInfoModal");
    loadWatchOptions(movie);
    loadCommunityInfo(movie);
  }

  // 「いま観られる方法」（配信/レンタル/購入/劇場）を JustWatch(日本) から取得して表示
  const WATCH_GROUPS = [
    { keys: ["flatrate"], label: "定額見放題", icon: "▶️" },
    { keys: ["free"], label: "無料", icon: "🆓" },
    { keys: ["ads"], label: "広告つき無料", icon: "📺" },
    { keys: ["rent"], label: "レンタル", icon: "💰" },
    { keys: ["buy"], label: "購入", icon: "🛒" },
  ];

  async function loadWatchOptions(movie) {
    const box = document.getElementById("infoWatch");
    if (!box) return;
    const reqId = movie.id;
    box.innerHTML = `<span class="info-watch-loading">配信・上映状況を確認しています…</span>`;
    let data;
    try {
      const res = await fetch(
        "/api/watch?title=" + encodeURIComponent(movie.title || "") +
        "&year=" + encodeURIComponent(movie.year || "") +
        "&fid=" + encodeURIComponent(movie.filmarksId || ""));
      if (!res.ok) throw new Error("bad");
      data = await res.json();
    } catch (e) {
      if (infoMovieId !== reqId) return;
      box.innerHTML =
        `<span class="info-watch-note">配信・上映状況の取得にはローカルサーバー（<code>python3 server.py</code>）が必要です。</span>`;
      return;
    }
    if (infoMovieId !== reqId) return; // 別作品に切り替わっていたら無視
    renderWatchOptions(box, movie, data);
  }

  function renderWatchOptions(box, movie, data) {
    const offers = (data && data.offers) || [];
    const cinema = (data && data.cinema) || null;
    const jwUrl = (data && data.url) ||
      ("https://www.justwatch.com/jp/検索?q=" + encodeURIComponent(movie.title || ""));
    let html = "";

    // 映画館（上映中かどうか）を最上段に表示
    if (cinema) {
      if (cinema.showing) {
        html +=
          `<div class="watch-group watch-cinema">` +
          `<span class="watch-group-label">🎦 映画館</span>` +
          `<span class="watch-chips">` +
          `<span class="watch-chip watch-chip-cinema">上映中</span>` +
          (cinema.url
            ? `<a class="watch-cinema-link" href="${cinema.url}" target="_blank" rel="noopener">上映館を探す ↗</a>`
            : "") +
          `</span></div>`;
      } else {
        html +=
          `<div class="watch-group watch-cinema">` +
          `<span class="watch-group-label">🎦 映画館</span>` +
          `<span class="watch-chips"><span class="watch-chip watch-chip-off">上映情報なし</span></span>` +
          `</div>`;
      }
    }

    // 配信・レンタル・購入
    WATCH_GROUPS.forEach((g) => {
      const names = [...new Set(
        offers.filter((o) => g.keys.includes(o.type)).map((o) => o.name))];
      if (!names.length) return;
      html +=
        `<div class="watch-group">` +
        `<span class="watch-group-label">${g.icon} ${g.label}</span>` +
        `<span class="watch-chips">` +
        names.map((n) => `<span class="watch-chip">${escapeHtml(n)}</span>`).join("") +
        `</span></div>`;
    });

    if (!offers.length && (!cinema || !cinema.showing)) {
      html +=
        `<p class="info-watch-note">いま配信・レンタル・購入・劇場で観られるサービスは見つかりませんでした（未配信／上映終了の可能性があります）。</p>`;
    }
    html +=
      `<div class="watch-foot">` +
      `<a class="btn btn-ghost btn-sm" href="${jwUrl}" target="_blank" rel="noopener">JustWatchで確認 ↗</a>` +
      `<span class="watch-credit">配信: JustWatch／上映: Filmarks（日本）</span>` +
      `</div>`;
    box.innerHTML = html;
  }

  function setInfoPreview(src) {
    const img = document.getElementById("infoPosterImg");
    if (!img) return;
    if (src) { img.src = src; img.style.display = ""; }
    else { img.removeAttribute("src"); img.style.display = "none"; }
  }

  function saveMovieInfo() {
    const found = infoMovieId ? findMovie(infoMovieId) : null;
    if (!found) { closeModal("movieInfoModal"); return; }
    const m = found.movie;
    const $ = (id) => document.getElementById(id);

    const title = $("infoTitle").value.trim();
    if (title) m.title = title;
    m.year = $("infoYear").value.trim();
    m.yearCheckedV = YEAR_FIX_VERSION; // 手動指定を自動統一で上書きしない

    const kind = $("infoKind").value;
    if (kind) m.kind = kind; else delete m.kind;

    const splitList = (s) => s.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
    m.meta = { directors: splitList($("infoDirectors").value), cast: splitList($("infoCast").value) };
    m.kindChecked = true; // 監督・出演者・種別は手動確定（自動分析で上書きしない）

    m.genres = [...$("infoGenres").querySelectorAll("input:checked")].map((c) => c.value);
    m.genreCheckedV = GENRE_FIX_VERSION; // 手動指定を自動取得で上書きしない

    const userThemes = splitList($("infoUserThemes").value);
    if (userThemes.length) m.userThemes = userThemes; else delete m.userThemes;

    const comment = $("infoComment").value.trim();
    if (comment) m.comment = comment; else delete m.comment;

    // ポスター: アップロード画像 > URL入力 > 既存
    const url = $("infoPosterUrl").value.trim();
    if (infoPosterData) m.poster = infoPosterData;
    else if (url) m.poster = url;

    closeModal("movieInfoModal");
    infoMovieId = null;
    infoPosterData = null;
    updateThemeButton();
    updateFilterInfo();
    render();
    toast("作品情報を保存しました");
  }

  // =======================================================================
  // Tier operations
  // =======================================================================
  function addTier() {
    state.tiers.push({ id: uid(), label: "新", color: TIER_COLORS[state.tiers.length % TIER_COLORS.length], items: [] });
    render();
  }

  function resetTiers() {
    const ranked = state.tiers.reduce((n, t) => n + t.items.length, 0);
    const msg = ranked
      ? `ティアに振り分けた ${ranked}本がすべて「未分類」に戻り、ティアは S/A/B/C/D の5段になります。\n本当に初期化しますか？`
      : "ティアを S/A/B/C/D の5段に戻します。よろしいですか？";
    if (!confirm(msg)) return;
    pushBackup(); // 初期化前の状態を「前の状態に戻す」にも残しておく
    const before = JSON.parse(JSON.stringify({ tiers: state.tiers, pool: state.pool }));
    const all = state.tiers.flatMap((t) => t.items);
    state.pool.push(...all);
    state.tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));
    render();
    closeModal("settingsModal");
    toast("ティアを初期化しました", {
      label: "元に戻す",
      onClick: () => {
        state.tiers = before.tiers;
        state.pool = before.pool;
        render();
        toast("初期化を取り消しました");
      },
    });
  }

  let currentEditor = null;
  function closeTierEditor() {
    if (currentEditor) {
      currentEditor.remove();
      currentEditor = null;
      document.removeEventListener("mousedown", onDocClickForEditor, true);
    }
  }

  function onDocClickForEditor(e) {
    if (currentEditor && !currentEditor.contains(e.target)) {
      closeTierEditor();
    }
  }

  function openTierEditor(tier, anchorEl) {
    closeTierEditor();
    const pop = document.createElement("div");
    pop.className = "tier-editor";

    const idx = state.tiers.indexOf(tier);
    pop.innerHTML = `
      <label class="field">
        <span>ラベル</span>
        <input type="text" class="te-label" value="${escapeHtml(tier.label)}" maxlength="12" />
      </label>
      <label class="field">
        <span>色</span>
        <div class="color-swatches"></div>
      </label>
      <div class="tier-editor-actions">
        <div class="move-group">
          <button class="btn btn-ghost btn-sm te-up" title="上へ" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="btn btn-ghost btn-sm te-down" title="下へ" ${idx === state.tiers.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <button class="btn btn-danger btn-sm te-delete">削除</button>
      </div>
    `;

    const swatchWrap = pop.querySelector(".color-swatches");
    TIER_COLORS.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "swatch" + (c === tier.color ? " selected" : "");
      sw.style.background = c;
      sw.addEventListener("click", () => {
        tier.color = c;
        swatchWrap.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
        sw.classList.add("selected");
        render();
      });
      swatchWrap.appendChild(sw);
    });

    const labelInput = pop.querySelector(".te-label");
    labelInput.addEventListener("input", () => {
      tier.label = labelInput.value;
      render();
    });

    pop.querySelector(".te-up").addEventListener("click", () => {
      const i = state.tiers.indexOf(tier);
      if (i > 0) {
        state.tiers.splice(i - 1, 0, state.tiers.splice(i, 1)[0]);
        render();
        closeTierEditor();
      }
    });
    pop.querySelector(".te-down").addEventListener("click", () => {
      const i = state.tiers.indexOf(tier);
      if (i < state.tiers.length - 1) {
        state.tiers.splice(i + 1, 0, state.tiers.splice(i, 1)[0]);
        render();
        closeTierEditor();
      }
    });
    pop.querySelector(".te-delete").addEventListener("click", () => {
      if (state.tiers.length <= 1) {
        toast("最後のティアは削除できません");
        return;
      }
      state.pool.push(...tier.items);
      state.tiers.splice(state.tiers.indexOf(tier), 1);
      render();
      closeTierEditor();
    });

    document.body.appendChild(pop);
    // position near anchor
    const r = anchorEl.getBoundingClientRect();
    let left = r.right + 8;
    let top = r.top;
    if (left + 260 > window.innerWidth) left = Math.max(8, r.left - 268);
    if (top + pop.offsetHeight > window.innerHeight) top = Math.max(8, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    currentEditor = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocClickForEditor, true), 0);
    labelInput.focus();
    labelInput.select();
  }

  // =======================================================================
  // Search sources
  // =======================================================================
  // データ取得元は Filmarks に一元化している（検索・ポスター・監督/出演・人物）。
  // =======================================================================
  // Filmarks 検索（ポスターが安定して付くので検索・ポスター補完の主ソース）
  async function searchFilmarks(query) {
    let res;
    try {
      res = await fetch("/api/filmarks/search?q=" + encodeURIComponent(query));
    } catch (e) {
      throw new Error("NO_SERVER");
    }
    if (!res.ok) {
      if (res.status === 502) throw new Error("FETCH_FAILED");
      throw new Error("HTTP_" + res.status);
    }
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title,
      year: r.year || "",
      poster: r.poster || "",
      filmarksId: r.id,
      url: r.url,
    }));
  }

  // =======================================================================
  // Person (bulk add by actor / director)
  // =======================================================================
  const ROLE_CATEGORIES = [
    "監督", "出演", "声の出演", "脚本", "原作", "原案",
    "製作総指揮", "製作", "撮影", "編集", "音楽",
  ];

  // 「人物でまとめて」でランダム提示する候補（俳優・監督ミックス）
  const PEOPLE_SUGGESTIONS = [
    "トム・クルーズ", "レオナルド・ディカプリオ", "ブラッド・ピット", "ロバート・デ・ニーロ",
    "トム・ハンクス", "デンゼル・ワシントン", "ホアキン・フェニックス", "キアヌ・リーブス",
    "メリル・ストリープ", "スカーレット・ヨハンソン", "ナタリー・ポートマン", "エマ・ストーン",
    "ティモシー・シャラメ", "ライアン・ゴズリング", "ヒュー・ジャックマン", "ジョニー・デップ",
    "クリスチャン・ベール", "ジェイク・ギレンホール", "アン・ハサウェイ",
    "クリストファー・ノーラン", "スティーヴン・スピルバーグ", "クエンティン・タランティーノ",
    "マーティン・スコセッシ", "リドリー・スコット", "デヴィッド・フィンチャー", "ティム・バートン",
    "ウェス・アンダーソン", "ドゥニ・ヴィルヌーヴ", "グレタ・ガーウィグ",
    "宮﨑駿", "黒澤明", "是枝裕和", "北野武", "山田洋次", "細田守", "新海誠", "濱口竜介",
    "岩井俊二", "庵野秀明", "三谷幸喜", "役所広司", "阿部寛", "菅田将暉", "岡田准一", "佐藤健",
    "大泉洋", "堤真一", "妻夫木聡", "西島秀俊", "綾瀬はるか", "新垣結衣", "石原さとみ",
    "広瀬すず", "有村架純", "松たか子", "宮沢りえ", "三船敏郎", "高倉健",
  ];

  let personFilms = [];
  let personRoleFilter = "all";
  let currentPersonName = "";

  function renderPersonSuggest() {
    const wrap = document.getElementById("personSuggest");
    if (!wrap) return;
    wrap.innerHTML = "";
    pickRandom(PEOPLE_SUGGESTIONS, 8).forEach((name) => {
      const b = document.createElement("button");
      b.className = "collection-chip";
      b.textContent = name;
      b.addEventListener("click", () => quickLoadPerson(name));
      wrap.appendChild(b);
    });
  }

  // 候補名をタップ → 検索して最初の人物のフィルモグラフィを直接開く
  async function quickLoadPerson(name) {
    const input = document.getElementById("personSearchInput");
    const status = document.getElementById("personStatus");
    input.value = name;
    document.getElementById("personResults").innerHTML = "";
    document.getElementById("personFilmography").classList.add("hidden");
    status.textContent = `「${name}」を検索中…`;
    let res;
    try {
      res = await fetch("/api/filmarks/person/search?q=" + encodeURIComponent(name));
    } catch (e) {
      status.innerHTML =
        "人物検索にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
      return;
    }
    if (!res.ok) {
      status.textContent = "検索に失敗しました。";
      return;
    }
    const data = await res.json();
    const list = data.results || [];
    if (!list.length) {
      status.textContent = "該当する人物が見つかりませんでした。";
      return;
    }
    loadFilmography(list[0]);
  }

  async function searchPerson() {
    const input = document.getElementById("personSearchInput");
    const status = document.getElementById("personStatus");
    const q = input.value.trim();
    if (!q) return;
    status.textContent = "検索中…";
    document.getElementById("personResults").innerHTML = "";
    document.getElementById("personFilmography").classList.add("hidden");
    let res;
    try {
      res = await fetch("/api/filmarks/person/search?q=" + encodeURIComponent(q));
    } catch (e) {
      status.innerHTML =
        "人物検索にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
      return;
    }
    if (!res.ok) {
      status.textContent = "検索に失敗しました。";
      return;
    }
    const data = await res.json();
    const list = data.results || [];
    if (!list.length) {
      status.textContent = "該当する人物が見つかりませんでした。";
      return;
    }
    status.textContent = `${list.length}人見つかりました（クリックで作品一覧へ）`;
    renderPersonResults(list);
  }

  function renderPersonResults(list) {
    const wrap = document.getElementById("personResults");
    wrap.innerHTML = "";
    list.forEach((p) => {
      const card = document.createElement("div");
      card.className = "person-card";
      card.innerHTML =
        (p.photo
          ? `<img class="person-photo" src="${p.photo}" alt="" loading="lazy" crossorigin="anonymous" />`
          : `<div class="person-photo person-photo-fb">👤</div>`) +
        `<div class="person-cardname">${escapeHtml(p.name)}</div>`;
      card.addEventListener("click", () => loadFilmography(p));
      wrap.appendChild(card);
    });
  }

  async function loadFilmography(person) {
    const status = document.getElementById("personStatus");
    status.textContent = `「${person.name}」の作品を取得中…`;
    let res;
    try {
      res = await fetch("/api/filmarks/person/movies?id=" + encodeURIComponent(person.id));
    } catch (e) {
      status.textContent = "取得に失敗しました。";
      return;
    }
    if (!res.ok) {
      status.textContent = "取得に失敗しました。";
      return;
    }
    const data = await res.json();
    personFilms = data.results || [];
    personPicked.clear();
    currentPersonName = person.name;
    personRoleFilter = "all";
    status.textContent = "";
    document.getElementById("personResults").innerHTML = "";
    document.getElementById("personName").textContent =
      `${person.name}（全${personFilms.length}作品）`;
    document.getElementById("personFilmography").classList.remove("hidden");
    buildRoleChips();
    renderFilmGrid();
  }

  function buildRoleChips() {
    const wrap = document.getElementById("roleChips");
    wrap.innerHTML = "";
    const present = ROLE_CATEGORIES.filter((cat) =>
      personFilms.some((f) => (f.role || "").includes(cat))
    );
    const chips = [{ key: "all", label: `すべて (${personFilms.length})` }].concat(
      present.map((cat) => ({
        key: cat,
        label: `${cat} (${personFilms.filter((f) => (f.role || "").includes(cat)).length})`,
      }))
    );
    chips.forEach((c) => {
      const b = document.createElement("button");
      b.className = "role-chip" + (c.key === personRoleFilter ? " active" : "");
      b.textContent = c.label;
      b.addEventListener("click", () => {
        personRoleFilter = c.key;
        wrap.querySelectorAll(".role-chip").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        renderFilmGrid();
      });
      wrap.appendChild(b);
    });
  }

  function filteredFilms() {
    if (personRoleFilter === "all") return personFilms;
    return personFilms.filter((f) => (f.role || "").includes(personRoleFilter));
  }

  // 登録済み判定は「外部ID一致」または「正規化タイトル一致」で行う。
  // 旧データは eigaId / tmdbId しか持たないことがあるため、タイトルでも照合して
  // どのタブから追加しても同一作品として扱う。
  function movieExists({ eigaId, tmdbId, filmarksId, title } = {}) {
    const nt = title ? normTitle(title) : "";
    return allMovies().some(
      (m) =>
        (eigaId && m.eigaId === eigaId) ||
        (tmdbId && m.tmdbId === tmdbId) ||
        (filmarksId && m.filmarksId === filmarksId) ||
        (nt && normTitle(m.title) === nt)
    );
  }

  // タイトル正規化での登録済み判定（ID 照合前の軽い事前フィルタ用）
  function isRegisteredByTitle(title) {
    const nt = normTitle(title);
    if (!nt) return false;
    return allMovies().some((m) => normTitle(m.title) === nt);
  }

  // 他タブと同じく「タップで選択 → 下部のボタンでまとめて追加」。
  // 役割の絞り込みを切り替えても選択は保持する。
  const personPicked = new Set();

  function personFilm(f) {
    return { title: f.title, poster: f.poster || "", year: f.year || "", filmarksId: f.id, role: f.role || "" };
  }

  function renderFilmGrid() {
    const grid = document.getElementById("filmGrid");
    const films = filteredFilms().map(personFilm);
    grid.innerHTML = "";
    films.forEach((f) => {
      const card = makePickCard(f, {
        subtitle: (f.year || "") + (f.role ? " ・ " + f.role : ""),
        onToggle: () => {
          if (card.classList.contains("picked")) personPicked.add(f.filmarksId);
          else personPicked.delete(f.filmarksId);
          updatePersonPickUI();
        },
      });
      if (personPicked.has(f.filmarksId) && !card.classList.contains("result-added")) {
        card.classList.add("picked");
        card.querySelector(".pick-badge").textContent = "✓ 選択中";
      }
      grid.appendChild(card);
    });
    document.getElementById("personActions").style.display = films.length ? "flex" : "none";
    updatePersonPickUI();
  }

  function updatePersonPickUI() {
    setPickBtn("personAddBtn", "filmGrid");
    const grid = document.getElementById("filmGrid");
    const cards = [...grid.querySelectorAll(".pick-card:not(.result-added)")];
    const allPicked = cards.length > 0 && cards.every((c) => c.classList.contains("picked"));
    const btn = document.getElementById("personSelectAllBtn");
    btn.textContent = allPicked ? "選択をすべて解除" : `表示中の${cards.length}作品をすべて選ぶ`;
    btn.disabled = cards.length === 0;
  }

  function togglePersonSelectAll() {
    const cards = [...document.querySelectorAll("#filmGrid .pick-card:not(.result-added)")];
    const pick = !cards.every((c) => c.classList.contains("picked"));
    cards.forEach((c) => {
      c.classList.toggle("picked", pick);
      c.querySelector(".pick-badge").textContent = pick ? "✓ 選択中" : "選ぶ";
      if (pick) personPicked.add(c._film.filmarksId); else personPicked.delete(c._film.filmarksId);
    });
    updatePersonPickUI();
  }

  function bulkAddPerson() {
    const picked = collectPicked(document.getElementById("filmGrid"));
    const c = addFilms(picked);
    if (c) {
      picked.forEach((f) => personPicked.delete(f.filmarksId));
      renderFilmGrid();
      notifyBulkAdded("personAddBtn", "filmGrid", c);
    }
  }

  // =======================================================================
  // Theme filter (auto-suggested from movies in the list)
  // =======================================================================
  function allMovies() {
    return [...state.pool, ...state.tiers.flatMap((t) => t.items)];
  }

  // メタ情報の取得（監督・出演・種別・ジャンル・公開年）対象。
  // 絞り込み時に「未鑑賞（ウォッチリスト）」の件数も正しく数えられるよう、
  // ティアリスト（鑑賞済み）に加えてウォッチリストも補完対象に含める。
  function enrichPool() {
    return [...allMovies(), ...(state.watchlist || [])];
  }

  function matchesFilter(movie) {
    // AND: 選択中のテーマをすべて満たす作品 / OR: いずれかを満たす作品
    if (!activeFilters.length) return true;
    return filterMode === "or"
      ? activeFilters.some((f) => matchesOne(movie, f))
      : activeFilters.every((f) => matchesOne(movie, f));
  }

  function matchesOne(movie, f) {
    const { type, value } = f;
    if (type === "year") return String(movie.year || "") === value;
    if (type === "decade") {
      const y = parseInt(movie.year, 10);
      return y && String(Math.floor(y / 10) * 10) === value;
    }
    if (type === "director") return !!(movie.meta && (movie.meta.directors || []).includes(value));
    if (type === "actor") return !!(movie.meta && (movie.meta.cast || []).includes(value));
    if (type === "collection") return movieCollections(movie).includes(value);
    if (type === "genre") return (movie.genres || []).includes(value) || movieCollections(movie).includes(value);
    if (type === "award") return movieCollections(movie).includes(value);
    if (type === "kind") return movie.kind === value;
    if (type === "userTheme") return (movie.userThemes || []).includes(value);
    if (type === "nitaku") return !!movie.nitaku;
    return true;
  }

  // 作品種別（邦画/洋画 × 実写/アニメ）の定義。順序が表示順になる。
  const KIND_DEFS = [
    ["jp_live", "邦画実写"],
    ["foreign_live", "洋画実写"],
    ["jp_anime", "邦画アニメ"],
    ["foreign_anime", "洋画アニメ"],
  ];
  const KIND_LABEL = Object.fromEntries(KIND_DEFS);

  // クレジット結果から種別を判定する（製作国が不明なら分類しない）
  function classifyKind(cr) {
    if (!cr || !cr.country) return null;
    return (cr.jp ? "jp" : "foreign") + "_" + (cr.anime ? "anime" : "live");
  }

  // テーマ候補を集計して {years, directors, actors} を返す
  function getThemeData() {
    const yearCount = new Map();
    const dirCount = new Map();
    const actorCount = new Map();
    const collCount = new Map();
    const kindCount = new Map();
    const genreCount = new Map();
    const userThemeCount = new Map();
    const genreSet = new Set(GENRES.map((g) => g.label));
    allMovies().forEach((m) => {
      if (m.year) yearCount.set(m.year, (yearCount.get(m.year) || 0) + 1);
      if (m.kind) kindCount.set(m.kind, (kindCount.get(m.kind) || 0) + 1);
      (m.userThemes || []).forEach((t) => userThemeCount.set(t, (userThemeCount.get(t) || 0) + 1));
      if (m.meta) {
        (m.meta.directors || []).forEach((d) => dirCount.set(d, (dirCount.get(d) || 0) + 1));
        (m.meta.cast || []).forEach((c) => actorCount.set(c, (actorCount.get(c) || 0) + 1));
      }
      const cols = movieCollections(m);
      cols.forEach((label) => collCount.set(label, (collCount.get(label) || 0) + 1));
      // ジャンルは「自動取得(m.genres)」＋「ジャンルタブ追加時のタグ」を作品ごとに一度だけ集計
      const gset = new Set(m.genres || []);
      cols.forEach((label) => { if (genreSet.has(label)) gset.add(label); });
      gset.forEach((label) => genreCount.set(label, (genreCount.get(label) || 0) + 1));
    });
    const kinds = KIND_DEFS
      .filter(([k]) => kindCount.get(k))
      .map(([k, label]) => ({ value: "kind:" + k, label, count: kindCount.get(k) }));
    const years = [...yearCount.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([v, n]) => ({ value: "year:" + v, label: `${v}年`, count: n }));
    const toPersons = (counts, prefix) =>
      [...counts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => ({ value: prefix + ":" + name, label: name, count: n }));
    const awardSet = new Set(AWARDS.map((a) => a.label));
    const sortEntries = (entries) =>
      entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const collections = sortEntries(
      [...collCount.entries()].filter(([label]) => !awardSet.has(label) && !genreSet.has(label))
    ).map(([label, n]) => ({ value: "collection:" + label, label, count: n }));
    const genres = sortEntries(
      [...genreCount.entries()]
    ).map(([label, n]) => ({ value: "genre:" + label, label, count: n }));
    const awards = sortEntries(
      [...collCount.entries()].filter(([label]) => awardSet.has(label))
    ).map(([label, n]) => ({ value: "award:" + label, label, count: n }));
    const userThemes = sortEntries(
      [...userThemeCount.entries()]
    ).map(([label, n]) => ({ value: "userTheme:" + label, label, count: n }));
    return {
      year: years,
      kind: kinds,
      director: toPersons(dirCount, "director"),
      actor: toPersons(actorCount, "actor"),
      collection: collections,
      genre: genres,
      award: awards,
      userTheme: userThemes,
    };
  }

  // 登録済みの全タグ名（重複なし・五十音）
  function allUserThemeNames() {
    const set = new Set();
    allMovies().forEach((m) => (m.userThemes || []).forEach((t) => set.add(t)));
    return [...set].sort((a, b) => a.localeCompare(b, "ja"));
  }

  function themeButtonLabel() {
    if (!activeFilters.length) return "すべて表示 ▾";
    const parts = activeFilters.map(filterLabel);
    const joined = parts.join(filterJoiner());
    const label = joined.length > 28 ? `${parts[0]} 他${parts.length - 1}件` : joined;
    return `${label} ▾`;
  }

  function updateThemeButton() {
    const btn = document.getElementById("themeFilterBtn");
    const clear = document.getElementById("clearThemeBtn");
    if (btn) {
      btn.textContent = themeButtonLabel();
      btn.classList.toggle("active", hasFilter());
    }
    if (clear) clear.classList.toggle("hidden", !hasFilter());
    const rank = document.getElementById("rankThemeBtn");
    if (rank) rank.classList.toggle("hidden", !hasFilter());
    const ch = document.getElementById("challengeCreateBtn");
    if (ch) ch.classList.toggle("hidden", !hasFilter() || !!activeChallenge());
    renderChallengeBar();
  }

  // ---- テーマ選択パネル ----
  let currentThemePanel = null;
  let themePanelCat = "year";

  function closeThemePanel() {
    if (currentThemePanel) {
      currentThemePanel.remove();
      currentThemePanel = null;
      const bd = document.querySelector(".theme-sheet-backdrop");
      if (bd) bd.remove();
      document.body.classList.remove("sheet-open");
      document.removeEventListener("mousedown", onDocClickForThemePanel, true);
    }
  }

  function onDocClickForThemePanel(e) {
    const btn = document.getElementById("themeFilterBtn");
    if (currentThemePanel && !currentThemePanel.contains(e.target) && e.target !== btn) {
      closeThemePanel();
    }
  }

  function openThemePanel(anchorEl) {
    if (currentThemePanel) {
      closeThemePanel();
      return;
    }
    const data = getThemeData();
    // 有効なカテゴリの初期選択
    const cats = [
      { key: "userTheme", label: "🏷 タグ" },
      { key: "year", label: "公開年" },
      { key: "kind", label: "種別" },
      { key: "genre", label: "ジャンル" },
      { key: "collection", label: "コレクション" },
      { key: "award", label: "映画賞・映画祭" },
      { key: "director", label: "監督" },
      { key: "actor", label: "出演者" },
    ];
    if (!(data[themePanelCat] || []).length) {
      const first = cats.find((c) => (data[c.key] || []).length);
      themePanelCat = first ? first.key : "year";
    }

    const pop = document.createElement("div");
    const asSheet = window.matchMedia("(max-width: 768px)").matches;
    pop.className = "theme-panel" + (asSheet ? " theme-panel-sheet" : "");
    pop.innerHTML =
      (asSheet
        ? `<div class="theme-sheet-head"><b>🎯 テーマで絞り込み</b><button type="button" class="theme-sheet-close">完了</button></div>`
        : "") +
      `<div class="theme-active"></div>` +
      `<div class="theme-cats">` +
      cats
        .map(
          (c) =>
            `<button class="theme-cat${c.key === themePanelCat ? " active" : ""}" data-cat="${c.key}">${c.label}<span class="cat-n">${(data[c.key] || []).length}</span></button>`
        )
        .join("") +
      `</div>` +
      `<input class="theme-search" type="text" placeholder="名前・年で絞り込み" />` +
      `<div class="theme-options"></div>`;

    const search = pop.querySelector(".theme-search");
    const optionsWrap = pop.querySelector(".theme-options");
    const activeWrap = pop.querySelector(".theme-active");

    // 選択中テーマ（チップ）を描画。× で個別解除できる。
    // 2件以上選ぶと AND（すべて満たす）／OR（いずれか）の切替を表示する。
    const renderActiveChips = () => {
      if (!activeFilters.length) {
        activeWrap.innerHTML =
          `<span class="theme-active-hint">タップで選択（複数選ぶと重ねて絞り込み）</span>`;
        return;
      }
      const modeToggle = activeFilters.length > 1
        ? `<div class="theme-mode" role="group" aria-label="複数テーマの条件">` +
          `<button class="theme-mode-btn${filterMode === "and" ? " active" : ""}" data-mode="and">すべて満たす<span class="theme-mode-sub">AND</span></button>` +
          `<button class="theme-mode-btn${filterMode === "or" ? " active" : ""}" data-mode="or">いずれか<span class="theme-mode-sub">OR</span></button>` +
          `</div>`
        : "";
      activeWrap.innerHTML =
        modeToggle +
        activeFilters
          .map(
            (f, i) =>
              `<button class="theme-chip" data-chip="${i}" title="このテーマを解除">` +
              `<span>${escapeHtml(filterLabel(f))}</span><span class="theme-chip-x">✕</span></button>`
          )
          .join("") +
        (activeFilters.length > 1
          ? `<button class="theme-chip-clear" data-chip-clear="1">すべて解除</button>`
          : "");
      activeWrap.querySelectorAll("[data-mode]").forEach((b) =>
        b.addEventListener("click", () => {
          filterMode = b.dataset.mode;
          zoneLimits.clear();
          render();
          renderActiveChips();
          renderOptions();
        }));
      activeWrap.querySelectorAll("[data-chip]").forEach((b) =>
        b.addEventListener("click", () => {
          activeFilters.splice(parseInt(b.dataset.chip, 10), 1);
          zoneLimits.clear();
          render();
          renderActiveChips();
          renderOptions();
        }));
      const clearAll = activeWrap.querySelector("[data-chip-clear]");
      if (clearAll) clearAll.addEventListener("click", () => {
        activeFilters = [];
        filterMode = "and";
        zoneLimits.clear();
        render();
        renderActiveChips();
        renderOptions();
      });
    };

    // スワイプ（スクロール）とタップ（選択）を区別する。ポインタが一定以上動いたら
    // その直後のクリックは「スクロール操作」とみなして項目選択を無効化する。
    // タッチ／マウス／ペンのいずれでも動くよう Pointer Events を使う。
    let swipeMoved = false;
    let swipeStartY = 0;
    optionsWrap.addEventListener("pointerdown", (e) => {
      swipeMoved = false;
      swipeStartY = e.clientY;
    });
    optionsWrap.addEventListener("pointermove", (e) => {
      // e.buttons が立っている＝押しながら移動（＝スワイプ／ドラッグ）
      if (e.buttons && Math.abs(e.clientY - swipeStartY) > 8) swipeMoved = true;
    });

    const renderOptions = () => {
      const q = search.value.trim();
      const items = (data[themePanelCat] || []).filter(
        (o) => !q || o.label.includes(q)
      );
      const isPerson = themePanelCat === "director" || themePanelCat === "actor";
      const isKind = themePanelCat === "kind";
      // 監督・出演者・種別は作品ページの取得（分析）が必要
      const needsAnalysis = isPerson || isKind;
      const pending = needsAnalysis ? unanalyzedCount() : 0;
      let html =
        `<button class="theme-option${!hasFilter() ? " current" : ""}" data-value="">すべて表示（解除）</button>`;
      // タグ: いつでも新規作成できるボタンを先頭に置く
      if (themePanelCat === "userTheme") {
        html += `<button class="theme-create" data-create="1">＋ 新しいタグを作成</button>`;
      }
      // 分析が必要なタブ: 未取得作品があれば、その場で取得して候補を増やせる
      if (needsAnalysis && pending > 0) {
        const what = isKind ? "作品の種別（邦画/洋画・実写/アニメ）" : "各作品の監督・出演者";
        html +=
          `<button class="theme-analyze" data-analyze="1" title="${what}を取得して候補に追加します">🔄 作品情報を取得（未取得 ${pending} 本）</button>`;
      }
      if (!items.length) {
        if (isKind) {
          html += pending > 0
            ? (kindEnrichDisabled
                ? `<div class="theme-empty">上のボタンで取得すると、邦画実写・洋画実写・邦画アニメ・洋画アニメが候補に並びます。</div>`
                : `<div class="theme-empty">種別を自動取得中です（バックグラウンド）。しばらくすると邦画実写・洋画実写・邦画アニメ・洋画アニメが候補に並びます。</div>`)
            : `<div class="theme-empty">種別を判定できる作品が見つかりませんでした。</div>`;
        } else if (isPerson) {
          html += pending > 0
            ? (kindEnrichDisabled
                ? `<div class="theme-empty">上のボタンで取得すると、監督・出演者が候補に並びます。</div>`
                : `<div class="theme-empty">監督・出演者を自動取得中です（バックグラウンド）。しばらくすると候補が並びます。</div>`)
            : `<div class="theme-empty">複数の作品に共通する${themePanelCat === "director" ? "監督" : "出演者"}が見つかりませんでした。</div>`;
        } else if (themePanelCat === "collection") {
          html +=
            `<div class="theme-empty">登録作の中にシリーズ・コレクション作品が見つかりませんでした。</div>`;
        } else if (themePanelCat === "genre") {
          const loadingGenres = !genreFixDisabled &&
            allMovies().some((m) => m.genreCheckedV !== GENRE_FIX_VERSION);
          html += loadingGenres
            ? `<div class="theme-empty">ジャンルを自動取得中です（バックグラウンド）。しばらくすると候補が並びます。</div>`
            : `<div class="theme-empty">登録作の中にジャンル該当作品が見つかりませんでした。</div>`;
        } else if (themePanelCat === "award") {
          html +=
            `<div class="theme-empty">登録作の中に映画賞・映画祭の受賞作が見つかりませんでした。</div>`;
        } else if (themePanelCat === "userTheme") {
          html +=
            `<div class="theme-empty">まだタグがありません。上の「＋ 新しいタグを作成」から、好きな切り口で作品をまとめられます。</div>`;
        } else {
          html += `<div class="theme-empty">該当なし</div>`;
        }
      } else if (themePanelCat === "userTheme") {
        html += items
          .map(
            (o) =>
              `<div class="theme-option-row">` +
              `<button class="theme-option${isOptionActive(o.value) ? " current" : ""}" data-value="${escapeHtml(o.value)}">` +
              `<span class="opt-check">${isOptionActive(o.value) ? "✓" : ""}</span>` +
              `<span class="opt-label">${escapeHtml(o.label)}</span><span class="opt-count">${o.count}</span></button>` +
              `<button class="theme-edit" data-edit="${escapeHtml(o.label)}" title="このタグを編集">✎</button>` +
              `</div>`
          )
          .join("");
      } else {
        html += items
          .map(
            (o) =>
              `<button class="theme-option${isOptionActive(o.value) ? " current" : ""}" data-value="${escapeHtml(o.value)}">` +
              `<span class="opt-check">${isOptionActive(o.value) ? "✓" : ""}</span>` +
              `<span class="opt-label">${escapeHtml(o.label)}</span><span class="opt-count">${o.count}</span></button>`
          )
          .join("");
      }
      optionsWrap.innerHTML = html;
      const analyzeBtn = optionsWrap.querySelector("[data-analyze]");
      if (analyzeBtn) {
        analyzeBtn.addEventListener("click", async () => {
          analyzeBtn.disabled = true;
          analyzeBtn.textContent = "取得中…";
          await enrichThemes();
          if (currentThemePanel === pop) {
            closeThemePanel();
            openThemePanel(anchorEl);
          }
        });
      }
      optionsWrap.querySelectorAll(".theme-option").forEach((b) => {
        b.addEventListener("click", () => {
          // スワイプ直後のクリックは選択とみなさない（スクロール操作のため）
          if (swipeMoved) { swipeMoved = false; return; }
          if (!b.dataset.value) {
            // 「すべて表示（解除）」は全解除してパネルを閉じる
            applyThemeFilter("");
            closeThemePanel();
            return;
          }
          // それ以外は選択のトグル。複数選ぶと AND で重ねられるようパネルは開いたまま。
          applyThemeFilter(b.dataset.value);
          renderActiveChips();
          renderOptions();
        });
      });
      const createBtn = optionsWrap.querySelector("[data-create]");
      if (createBtn) createBtn.addEventListener("click", () => {
        if (swipeMoved) { swipeMoved = false; return; }
        closeThemePanel();
        openThemeEditModal("");
      });
      optionsWrap.querySelectorAll(".theme-edit").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          if (swipeMoved) { swipeMoved = false; return; }
          closeThemePanel();
          openThemeEditModal(b.dataset.edit);
        });
      });
    };

    pop.querySelectorAll(".theme-cat").forEach((b) => {
      b.addEventListener("click", () => {
        themePanelCat = b.dataset.cat;
        pop.querySelectorAll(".theme-cat").forEach((x) => x.classList.toggle("active", x === b));
        renderOptions();
        if (!asSheet) search.focus();
      });
    });
    search.addEventListener("input", renderOptions);

    if (asSheet) {
      const bd = document.createElement("div");
      bd.className = "theme-sheet-backdrop";
      bd.addEventListener("click", closeThemePanel);
      document.body.appendChild(bd);
      pop.querySelector(".theme-sheet-close").addEventListener("click", closeThemePanel);
      document.body.appendChild(pop);
      document.body.classList.add("sheet-open");
      renderActiveChips();
      renderOptions();
      currentThemePanel = pop;
      return;
    }

    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
    }
    if (top + pop.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, r.top - pop.offsetHeight - 6);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    renderActiveChips();
    renderOptions();
    currentThemePanel = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocClickForThemePanel, true), 0);
    search.focus();
  }

  function updateFilterInfo() {
    const info = document.getElementById("filterInfo");
    if (!info) return;
    const total = allMovies().length;
    if (!hasFilter() && !searchQuery) {
      info.textContent = `登録 ${total} 本`;
    } else {
      // 絞り込み時は「鑑賞済み（ティアリスト）＋未鑑賞（ウォッチリスト）＝合計」を表示
      const watched = visibleItems(allMovies()).length;
      const wish = visibleItems(state.watchlist || []).length;
      info.textContent =
        `鑑賞済み ${watched} 本 ＋ 未鑑賞 ${wish} 本 ＝ 合計 ${watched + wish} 本`;
    }
  }

  function applyThemeFilter(rawValue) {
    if (!rawValue) {
      activeFilters = [];
      filterMode = "and";
    } else {
      const idx = rawValue.indexOf(":");
      const f = { type: rawValue.slice(0, idx), value: rawValue.slice(idx + 1) };
      const i = activeFilters.findIndex((x) => x.type === f.type && x.value === f.value);
      if (i >= 0) activeFilters.splice(i, 1); // 選択済みなら解除（トグル）
      else activeFilters.push(f);             // 未選択なら条件として追加
    }
    zoneLimits.clear();
    render();
  }

  // =======================================================================
  // タグ（ユーザー定義ラベル）の作成・編集
  // =======================================================================
  let themePickSet = new Set(); // モーダル内の暫定メンバー（保存時にだけ反映）
  let themePickSort = "added"; // "added"（登録順） / "title"（あいうえお順）
  let themePickDir = "asc"; // "asc"（昇順） / "desc"（降順）

  // 並び替えボタンの見た目（アクティブ表示・昇降矢印）を更新する
  function updateThemePickSortBtns() {
    document.querySelectorAll(".tp-sort-btn").forEach((b) => {
      const active = b.dataset.sort === themePickSort;
      b.classList.toggle("active", active);
      const arrow = b.querySelector(".tp-sort-arrow");
      if (arrow) arrow.textContent = active ? (themePickDir === "asc" ? "↑" : "↓") : "";
    });
  }

  function openThemeEditModal(name) {
    const nameInput = document.getElementById("themeNameInput");
    const dataList = document.getElementById("themeNameList");
    const search = document.getElementById("themePickSearch");
    updateThemePickSortBtns();
    if (dataList) {
      dataList.innerHTML = allUserThemeNames()
        .map((t) => `<option value="${escapeHtml(t)}"></option>`)
        .join("");
    }
    if (nameInput) {
      nameInput.value = name || "";
      nameInput.oninput = () => { rebuildThemePickSet(nameInput.value.trim()); renderThemePickList(); };
    }
    if (search) {
      search.value = "";
      search.oninput = renderThemePickList;
    }
    rebuildThemePickSet(name || "");
    renderThemePickList();
    openModal("themeEditModal");
    if (nameInput && !name) setTimeout(() => nameInput.focus(), 0);
  }

  // 指定テーマの現在メンバーで暫定セットを初期化する
  function rebuildThemePickSet(name) {
    themePickSet = new Set();
    if (!name) return;
    allMovies().forEach((m) => {
      if ((m.userThemes || []).includes(name)) themePickSet.add(m.id);
    });
  }

  function updateThemePickCount() {
    const countEl = document.getElementById("themePickCount");
    if (!countEl) return;
    const total = allMovies().length;
    countEl.textContent = `${themePickSet.size} 本を選択中 ・ 全 ${total} 本（入れたい作品にチェック）`;
  }

  function renderThemePickList() {
    const wrap = document.getElementById("themePickList");
    if (!wrap) return;
    const search = document.getElementById("themePickSearch");
    const q = search ? normTitle(search.value.trim()) : "";
    const movies = allMovies();
    ensureAddedStamps();
    const list = (q ? movies.filter((m) => normTitle(m.title).includes(q)) : movies.slice());
    if (themePickSort === "title") {
      list.sort((a, b) => titleSortKey(a).localeCompare(titleSortKey(b), "ja", { numeric: true }));
    } else {
      list.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    }
    if (themePickDir === "desc") list.reverse();
    updateThemePickCount();
    if (!movies.length) {
      wrap.innerHTML = `<p class="theme-empty">先に映画を登録してください。</p>`;
      return;
    }
    wrap.innerHTML = "";
    list.forEach((m) => {
      const lbl = document.createElement("label");
      lbl.className = "theme-pick-item" + (themePickSet.has(m.id) ? " checked" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = m.id;
      cb.checked = themePickSet.has(m.id);
      cb.addEventListener("change", () => {
        if (cb.checked) themePickSet.add(m.id); else themePickSet.delete(m.id);
        lbl.classList.toggle("checked", cb.checked);
        updateThemePickCount();
      });
      const thumb = document.createElement("span");
      thumb.className = "theme-pick-thumb";
      if (m.poster) {
        const img = document.createElement("img");
        img.src = m.poster;
        img.alt = "";
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        thumb.textContent = "🎬";
      }
      const t = document.createElement("span");
      t.className = "theme-pick-title";
      t.textContent = m.title + (m.year ? `（${m.year}）` : "");
      lbl.appendChild(cb);
      lbl.appendChild(thumb);
      lbl.appendChild(t);
      wrap.appendChild(lbl);
    });
  }

  function saveThemeEdit() {
    const nameInput = document.getElementById("themeNameInput");
    const name = (nameInput ? nameInput.value : "").trim();
    if (!name) { toast("テーマ名を入力してください"); if (nameInput) nameInput.focus(); return; }
    // 暫定セットの内容を各作品へ反映（検索で隠れていた作品も含めて全件同期）
    allMovies().forEach((m) => {
      const arr = m.userThemes || [];
      const i = arr.indexOf(name);
      if (themePickSet.has(m.id)) {
        if (i < 0) arr.push(name);
      } else if (i >= 0) {
        arr.splice(i, 1);
      }
      if (arr.length) m.userThemes = arr; else delete m.userThemes;
    });
    const count = themePickSet.size;
    closeModal("themeEditModal");
    if (count > 0) {
      activeFilters = [{ type: "userTheme", value: name }];
    }
    zoneLimits.clear();
    render();
    toast(count > 0
      ? `タグ「${name}」を保存しました（${count} 本）`
      : `タグ「${name}」に作品が選ばれていません`);
  }

  function deleteThemeEdit() {
    const nameInput = document.getElementById("themeNameInput");
    const name = (nameInput ? nameInput.value : "").trim();
    if (!name) { closeModal("themeEditModal"); return; }
    if (!window.confirm(`タグ「${name}」を削除しますか？（作品自体は消えません）`)) return;
    allMovies().forEach((m) => {
      if (Array.isArray(m.userThemes)) {
        const i = m.userThemes.indexOf(name);
        if (i >= 0) m.userThemes.splice(i, 1);
        if (!m.userThemes.length) delete m.userThemes;
      }
    });
    activeFilters = activeFilters.filter(
      (f) => !(f.type === "userTheme" && f.value === name));
    closeModal("themeEditModal");
    render();
    toast(`タグ「${name}」を削除しました`);
  }

  // =======================================================================
  // テーマ別ランキング（絞り込んだ作品に順位をつける）
  // =======================================================================
  let rankOrder = []; // モーダル内の暫定順位（作品ID配列・保存時に反映）

  function rankKey() {
    if (!activeFilters.length) return null;
    // 組み合わせ順に依存しないよう、キーは並べ替えて連結する。
    // AND/OR で対象作品が変わるためモードもキーに含める。
    const parts = activeFilters.map((f) => `${f.type}:${f.value}`).sort().join("&");
    return (activeFilters.length > 1 ? filterMode + "|" : "") + parts;
  }

  // 現在の絞り込みに一致する作品IDを、ティア上位→下位→未分類の順で返す
  function filteredIdsByTier() {
    const ids = [];
    state.tiers.forEach((t) => (t.items || []).forEach((m) => { if (matchesFilter(m)) ids.push(m.id); }));
    state.pool.forEach((m) => { if (matchesFilter(m)) ids.push(m.id); });
    return ids;
  }

  function openRankingModal() {
    if (!activeFilters.length) { toast("先にテーマで絞り込んでください"); return; }
    const key = rankKey();
    if (!state.rankings || typeof state.rankings !== "object") state.rankings = {};
    const matchIds = new Set(allMovies().filter(matchesFilter).map((m) => m.id));
    if (!matchIds.size) { toast("この絞り込みに該当する作品がありません"); return; }
    // 保存済みの順位を土台に、存在＆該当する作品だけ残し、新規作をティア順で末尾に追加
    const saved = Array.isArray(state.rankings[key]) ? state.rankings[key] : [];
    rankOrder = saved.filter((id) => matchIds.has(id));
    const inOrder = new Set(rankOrder);
    filteredIdsByTier().forEach((id) => { if (!inOrder.has(id)) { rankOrder.push(id); inOrder.add(id); } });

    const titleEl = document.getElementById("rankingTitle");
    if (titleEl) titleEl.textContent = `🏆 ${themeFilterName()} ランキング`;
    const exTitle = document.getElementById("rankingExportTitle");
    if (exTitle) exTitle.textContent = `🏆 ${themeFilterName()} ランキング`;
    renderRankingList();
    openModal("rankingModal");
  }

  // 絞り込み内容を人間向けの名前にする（複数選択時は「×」で連結）
  function themeFilterName() {
    if (!activeFilters.length) return "";
    return activeFilters.map(filterLabel).join(filterJoiner());
  }

  function moveRank(id, delta) {
    const i = rankOrder.indexOf(id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= rankOrder.length) return;
    rankOrder.splice(i, 1);
    rankOrder.splice(j, 0, id);
    renderRankingList();
  }

  function renderRankingList() {
    const wrap = document.getElementById("rankingList");
    if (!wrap) return;
    wrap.innerHTML = "";
    rankOrder.forEach((id, idx) => {
      const found = findMovie(id);
      if (!found) return;
      const m = found.movie;
      const row = document.createElement("div");
      row.className = "rank-row";
      row.draggable = true;
      row.dataset.id = id;

      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "";
      const badge = document.createElement("span");
      badge.className = "rank-badge" + (idx < 3 ? " rank-badge-top" : "");
      badge.textContent = medal || String(idx + 1);

      const thumb = document.createElement("span");
      thumb.className = "rank-thumb";
      if (m.poster) {
        const img = document.createElement("img");
        img.src = m.poster; img.alt = ""; img.loading = "lazy";
        thumb.appendChild(img);
      } else { thumb.textContent = "🎬"; }

      const info = document.createElement("span");
      info.className = "rank-info";
      const t = document.createElement("span");
      t.className = "rank-title";
      t.textContent = m.title || "(無題)";
      const sub = document.createElement("span");
      sub.className = "rank-sub";
      sub.textContent = m.year ? `${m.year}年` : "";
      info.appendChild(t);
      info.appendChild(sub);

      const ctrls = document.createElement("span");
      ctrls.className = "rank-ctrls";
      const up = document.createElement("button");
      up.className = "rank-btn"; up.textContent = "↑"; up.title = "順位を上げる";
      up.disabled = idx === 0;
      up.addEventListener("click", () => moveRank(id, -1));
      const down = document.createElement("button");
      down.className = "rank-btn"; down.textContent = "↓"; down.title = "順位を下げる";
      down.disabled = idx === rankOrder.length - 1;
      down.addEventListener("click", () => moveRank(id, 1));
      ctrls.appendChild(up);
      ctrls.appendChild(down);

      row.appendChild(badge);
      row.appendChild(thumb);
      row.appendChild(info);
      row.appendChild(ctrls);
      wrap.appendChild(row);
    });
    wireRankingDnd(wrap);
  }

  // ドラッグ中にホバー中の縦位置から、挿入先の直後要素を求める
  function rankRowAfter(wrap, y) {
    const rows = [...wrap.querySelectorAll(".rank-row:not(.dragging)")];
    let closest = { offset: -Infinity, el: null };
    for (const r of rows) {
      const box = r.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el: r };
    }
    return closest.el;
  }

  // 順位番号・メダル・ボタンの有効/無効を、現在のDOM並びに合わせて更新（再描画せず）
  function refreshRankBadges(wrap) {
    const rows = [...wrap.querySelectorAll(".rank-row")];
    rows.forEach((r, idx) => {
      const badge = r.querySelector(".rank-badge");
      if (badge) {
        const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : "";
        badge.textContent = medal || String(idx + 1);
        badge.classList.toggle("rank-badge-top", idx < 3);
      }
      const btns = r.querySelectorAll(".rank-btn");
      if (btns[0]) btns[0].disabled = idx === 0;
      if (btns[1]) btns[1].disabled = idx === rows.length - 1;
    });
  }

  // ランキング行のドラッグ＆ドロップ並べ替え。
  // 描画のたびに行は作り直されるので dragstart/dragend は毎回付け直す。
  // 一方 wrap への dragover は一度だけ登録し、ドラッグ中はDOMを直接動かす
  // （毎回 renderRankingList すると掴んだ要素が消えて1つずつしか動かせなくなるため）。
  function wireRankingDnd(wrap) {
    wrap.querySelectorAll(".rank-row").forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        row.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", row.dataset.id); // Firefox対策
        }
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        // DOMの最終的な並びから順位配列を確定し、番号などを整える
        rankOrder = [...wrap.querySelectorAll(".rank-row")].map((r) => r.dataset.id);
        renderRankingList();
      });
    });
    if (wrap._rankDndBound) return;
    wrap._rankDndBound = true;
    wrap.addEventListener("dragover", (e) => {
      const dragging = wrap.querySelector(".rank-row.dragging");
      if (!dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const after = rankRowAfter(wrap, e.clientY);
      if (after == null) wrap.appendChild(dragging);
      else if (after !== dragging.nextSibling) wrap.insertBefore(dragging, after);
      refreshRankBadges(wrap);
    });
    wrap.addEventListener("drop", (e) => e.preventDefault());
  }

  function saveRanking() {
    const key = rankKey();
    if (!key) { closeModal("rankingModal"); return; }
    if (!state.rankings || typeof state.rankings !== "object") state.rankings = {};
    state.rankings[key] = rankOrder.slice();
    saveState();
    closeModal("rankingModal");
    toast(`「${themeFilterName()}」のランキングを保存しました`);
  }

  function shuffleRanking() {
    for (let i = rankOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rankOrder[i], rankOrder[j]] = [rankOrder[j], rankOrder[i]];
    }
    renderRankingList();
  }

  function rankByTier() {
    const tierIds = filteredIdsByTier();
    const inTier = new Set(tierIds);
    // ティアに入っている順を先頭に、それ以外（あれば）は現状順で末尾へ
    rankOrder = [...tierIds, ...rankOrder.filter((id) => !inTier.has(id))];
    renderRankingList();
  }

  async function exportRankingPng() {
    if (!window.htmlToImage) { toast("画像ライブラリの読み込みに失敗しました（ネット接続を確認）"); return; }
    const region = document.getElementById("rankingExport");
    const exTitle = document.getElementById("rankingExportTitle");
    if (!region) return;
    if (exTitle) exTitle.style.display = "block";
    try {
      toast("画像を生成中…");
      const dataUrl = await window.htmlToImage.toPng(region, {
        pixelRatio: 2,
        backgroundColor: "#171a21",
        cacheBust: true,
        includeQueryParams: true,
      });
      const a = document.createElement("a");
      a.download = (themeFilterName() || "ranking") + "-ranking.png";
      a.href = dataUrl;
      a.click();
      toast("画像を保存しました");
    } catch (e) {
      console.error(e);
      toast("画像化に失敗しました。外部URLのポスターはCORSで失敗する場合があります。");
    } finally {
      if (exTitle) exTitle.style.display = "none";
    }
  }

  // 補完（監督・出演・種別）がまだ必要か。ID未保持でも、まだ検索での解決を
  // 試していなければ対象にする（公開年・コレクション等から追加した旧データを拾う）。
  function needsEnrich(m) {
    if (m.meta && m.kindChecked) return false;
    if (m.filmarksId) return true;
    return !m.kindIdTried;
  }

  // まだ監督・出演者・種別を取得していない（取得可能な）作品数
  function unanalyzedCount() {
    return enrichPool().filter(needsEnrich).length;
  }

  async function enrichThemes() {
    const info = document.getElementById("filterInfo");
    const btn = document.getElementById("analyzeThemesBtn");
    const pool = enrichPool();
    // ID を持たない未解決の作品（公開年・コレクション等から追加）は、まず
    // Filmarks タイトル検索で filmarksId を解決してから詳細を取得する。
    const noId = pool.filter((m) => needsEnrich(m) && !m.filmarksId);
    const haveId = pool.filter((m) => needsEnrich(m) && m.filmarksId);

    if (!noId.length && !haveId.length) {
      updateThemeButton();
      toast("分析済みです。テーマで絞り込めます");
      return;
    }

    if (btn) btn.disabled = true;
    let done = 0;
    const total = noId.length + haveId.length;
    const setProg = (label) => { info.textContent = `${label} ${done}/${total}`; };
    setProg("分析中…");

    // バッチ処理（60件ずつ）。applyCredit で共通反映し、進捗を更新する。
    const runBatch = async (list, idOf, endpoint) => {
      for (let i = 0; i < list.length; i += 60) {
        const chunk = list.slice(i, i + 60);
        const ids = chunk.map(idOf).join(",");
        const res = await fetch(endpoint + "?ids=" + encodeURIComponent(ids));
        if (!res.ok) throw new Error("NO_SERVER");
        const data = await res.json();
        chunk.forEach((m) => { applyCredit(m, (data.results || {})[idOf(m)]); done++; });
        setProg("分析中…");
      }
    };

    try {
      // 1) filmarksId の解決（1件ずつ検索）
      for (const m of noId) {
        let results = [];
        try {
          results = await searchFilmarks(m.title);
        } catch (e) {
          if (e.message === "NO_SERVER") throw e;
        }
        const hit = pickFilmarksIdMatch(results, m.title, m.year);
        if (hit && hit.filmarksId) {
          m.filmarksId = hit.filmarksId;
        } else {
          m.kindIdTried = true;
          m.kindChecked = true;
          if (!m.meta) m.meta = { directors: [], cast: [] };
        }
        done++;
        setProg("分析中…");
      }
      // 2) filmarksId 経由で監督・出演・種別・公開年を取得
      const fmTargets = enrichPool().filter((m) => needsEnrich(m) && m.filmarksId);
      await runBatch(fmTargets, (m) => m.filmarksId, "/api/filmarks/details");
      saveState();
      updateThemeButton();
      updateFilterInfo();
      toast("分析が完了しました。テーマで絞り込めます");
    } catch (e) {
      updateFilterInfo();
      if (e.message === "NO_SERVER") {
        toast("分析にはローカルサーバーが必要です（python3 server.py）");
      } else {
        toast("分析に失敗しました: " + e.message);
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // =======================================================================
  // Poster back-fill (ポスター未設定の作品を検索して補完)
  // =======================================================================
  function normTitle(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[\s　]+/g, "")
      .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～、。・「」『』〜～]/g, "");
  }

  // 検索結果から、そのタイトルに最も合うポスター候補を選ぶ（誤補完を避けるため一定以上一致が必要）
  function pickPosterMatch(candidates, title, year) {
    const nt = normTitle(title);
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (!c.poster) continue;
      const nc = normTitle(c.title);
      let score = 0;
      if (nc === nt) score = 100;
      else if (nc && (nc.includes(nt) || nt.includes(nc))) score = 60;
      if (year && c.year && String(c.year) === String(year)) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return bestScore >= 60 ? best : null;
  }

  // 旧ソース（映画.com / TMDB）のポスターは Filmarks のものへ差し替える。
  const LEGACY_POSTER_RE = /media\.eiga\.com|image\.tmdb\.org/;
  function hasLegacyPoster(m) {
    return !m.legacyPosterTried && LEGACY_POSTER_RE.test(String(m.poster || ""));
  }

  // ポスターが無い作品を、追加・読み込みのたびに自動でバックグラウンド補完する。
  const posterAttempted = new Set(); // 一度試した作品は再試行しない（無限ループ防止）
  let autoFillRunning = false;
  let autoFillDisabled = false;    // サーバー無しなど、補完不能なら停止
  let autoFillTimer = null;

  function scheduleAutoFill() {
    if (autoFillDisabled) return;
    clearTimeout(autoFillTimer);
    autoFillTimer = setTimeout(autoFillPosters, 1500);
  }

  async function autoFillPosters() {
    if (autoFillRunning || autoFillDisabled) return;
    const targets = enrichPool().filter(
      (m) => ((!m.poster || !String(m.poster).trim()) || hasLegacyPoster(m)) && !posterAttempted.has(m.id)
    );
    if (!targets.length) return;

    autoFillRunning = true;
    let filled = 0;
    let replaced = 0;
    let legacyTouched = false;
    try {
      for (const m of targets) {
        posterAttempted.add(m.id);
        const legacy = hasLegacyPoster(m);
        let results;
        try {
          results = await searchFilmarks(m.title);
        } catch (e) {
          if (e.message === "NO_SERVER") { autoFillDisabled = true; break; }
          continue;
        }
        // 既存ポスターの差し替えは誤紐付けを避けるため厳しめに照合する
        const found = legacy
          ? pickFilmarksIdMatch(results.filter((c) => c.poster), m.title, m.year)
          : pickPosterMatch(results, m.title, m.year);
        if (legacy) { m.legacyPosterTried = true; legacyTouched = true; }
        if (found && found.poster) {
          m.poster = found.poster;
          if (!m.year && found.year) m.year = found.year;
          if (!m.filmarksId && found.filmarksId) m.filmarksId = found.filmarksId;
          if (legacy) replaced++; else filled++;
        }
      }
    } finally {
      autoFillRunning = false;
    }

    if (filled || replaced || legacyTouched) {
      saveState();
      if (filled || replaced) render();
      if (filled) toast(`ポスターを ${filled} 件自動補完しました`);
      else if (replaced) toast(`ポスター ${replaced} 件を Filmarks のものに更新しました`);
    }
  }

  // 作品の年が確定済みかの目印（手動で年を直した作品を自動取得で上書きしないため）
  const YEAR_FIX_VERSION = 2;

  // =======================================================================
  // ジャンル自動紐付け：登録作品のジャンルを Filmarks から取得してタグ付けする。
  // これにより「ジャンル」タブから追加していない作品も、テーマのジャンル絞り込みに
  // 反映される。取得済み（genreCheckedV 一致）の作品は再取得しない。
  // =======================================================================
  const GENRE_FIX_VERSION = 1; // ロジック変更時に上げると全作品を再取得する
  let _fmGenreLabelMap = null;
  function fmGenreLabel(id) {
    if (!_fmGenreLabelMap) _fmGenreLabelMap = new Map(GENRES.map((g) => [g.fmGenre, g.label]));
    return _fmGenreLabelMap.get(id) || null;
  }

  let genreFixRunning = false;
  let genreFixDisabled = false; // サーバー無しなら停止
  let genreFixTimer = null;

  function scheduleGenreFix() {
    if (genreFixDisabled) return;
    clearTimeout(genreFixTimer);
    genreFixTimer = setTimeout(enrichGenres, 2600);
  }

  async function enrichGenres() {
    if (genreFixRunning || genreFixDisabled) return;
    const targets = enrichPool().filter((m) => m.genreCheckedV !== GENRE_FIX_VERSION);
    if (!targets.length) return;

    genreFixRunning = true;
    let changed = 0;
    try {
      for (let i = 0; i < targets.length; i += 20) {
        const chunk = targets.slice(i, i + 20);
        const payload = chunk.map((m) => ({ title: m.title, year: m.year || "" }));
        let res;
        try {
          res = await fetch(
            "/api/filmarks/movie_genres?titles=" + encodeURIComponent(JSON.stringify(payload))
          );
        } catch (netErr) {
          genreFixDisabled = true; // サーバー未起動：このセッションは停止（次回再試行）
          break;
        }
        // サーバーの一時エラー(5xx等)はこのチャンクを確定させず、次回に再試行させる
        if (!res.ok) continue;
        const data = await res.json();
        const map = data.results || {};
        chunk.forEach((m) => {
          const ids = map[m.title];
          const labels = Array.isArray(ids) ? ids.map(fmGenreLabel).filter(Boolean) : [];
          if (labels.length) {
            m.genres = labels;
            m.genreCheckedV = GENRE_FIX_VERSION; // 取得成功：確定
            changed++;
          } else {
            // 一致せず/対応ジャンル無し：数回だけ再試行してから諦める
            m.genreTries = (m.genreTries || 0) + 1;
            if (m.genreTries >= 3) m.genreCheckedV = GENRE_FIX_VERSION;
          }
        });
        saveState();
        updateFilterInfo();
      }
      if (changed) { updateThemeButton(); render(); }
    } finally {
      genreFixRunning = false;
    }
  }

  // ---- 種別（邦画/洋画・実写/アニメ）と監督・出演者をバックグラウンドで自動取得 ----
  // これにより「テーマで絞り込み → 種別」を最初から候補付きで開ける。
  let kindEnrichRunning = false;
  let kindEnrichDisabled = false; // サーバー無しなら停止（次回起動時に再試行）
  let kindEnrichTimer = null;

  function scheduleKindEnrich() {
    if (kindEnrichDisabled) return;
    clearTimeout(kindEnrichTimer);
    kindEnrichTimer = setTimeout(enrichKindsBg, 2000);
  }

  // credits/details（監督・出演・製作国・公開年・ジャンル）を作品に反映する共通処理。
  function applyCredit(m, cr) {
    if (cr) {
      m.meta = { directors: cr.directors || [], cast: cr.cast || [] };
      if (cr.year) { m.year = cr.year; m.yearCheckedV = YEAR_FIX_VERSION; }
      const k = classifyKind(cr);
      if (k) m.kind = k;
      // Filmarks 詳細にはジャンルIDも含まれるので、同時に確定して別リクエストを節約
      if (Array.isArray(cr.genreIds) && cr.genreIds.length && m.genreCheckedV !== GENRE_FIX_VERSION) {
        const labels = cr.genreIds.map(fmGenreLabel).filter(Boolean);
        if (labels.length) { m.genres = labels; m.genreCheckedV = GENRE_FIX_VERSION; }
      }
    } else if (!m.meta) {
      m.meta = { directors: [], cast: [] };
    }
    m.kindChecked = true; // 一度確認したら再取得しない
  }

  // 監督・出演・種別を、ソース別のバッチAPIでまとめて取得する。
  // endpoint: "/api/filmarks/details"。idOf で各作品のIDを取り出す。
  // 戻り値: 反映できた件数。ネットワーク不通なら onDown() を呼んで中断。
  async function fetchCreditsBatch(list, idOf, endpoint, onDown) {
    let changed = 0;
    for (let i = 0; i < list.length; i += 60) {
      const chunk = list.slice(i, i + 60);
      const ids = chunk.map(idOf).join(",");
      let res;
      try {
        res = await fetch(endpoint + "?ids=" + encodeURIComponent(ids));
      } catch (netErr) {
        if (onDown) onDown();
        break;
      }
      if (!res.ok) continue; // 一時エラーは確定させず次回再試行
      const data = await res.json();
      chunk.forEach((m) => {
        applyCredit(m, (data.results || {})[idOf(m)]);
        changed++;
      });
      saveState();
    }
    return changed;
  }

  // タイトル（＋公開年）から Filmarks 検索結果の最有力候補を選ぶ。
  // 種別・監督などのメタ取得用なので、ポスター有無は問わず精度重視で照合する。
  function pickFilmarksIdMatch(candidates, title, year) {
    const nt = normTitle(title);
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const nc = normTitle(c.title);
      let score = 0;
      if (nc === nt) score = 100;
      else if (nc && (nc.includes(nt) || nt.includes(nc))) score = 60;
      if (year && c.year && String(c.year) === String(year)) score += 20;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    // 誤紐付けを避けるため、完全一致（100）か「部分一致＋年一致」（80）以上のみ採用
    return bestScore >= 80 ? best : null;
  }

  const KIND_RESOLVE_CAP = 30; // 1回のバッチで filmarksId を解決する上限（バースト抑制）

  async function enrichKindsBg() {
    if (kindEnrichRunning || kindEnrichDisabled) return;
    const needs = (m) => !m.meta || !m.kindChecked;
    const pool = enrichPool();
    // ID を一切持たない旧データ（公開年・コレクション・賞などから追加）は、
    // Filmarks タイトル検索で filmarksId を解決してから詳細を取得する。
    const noId = pool.filter((m) => needs(m) && !m.filmarksId && !m.kindIdTried);
    const hasId = pool.filter((m) => needs(m) && m.filmarksId);
    if (!noId.length && !hasId.length) return;

    kindEnrichRunning = true;
    let changed = 0;
    try {
      // 1) filmarksId の解決（上限まで。残りは次回に持ち越し）
      let resolved = false;
      for (const m of noId.slice(0, KIND_RESOLVE_CAP)) {
        let results = [];
        try {
          results = await searchFilmarks(m.title);
        } catch (e) {
          if (e.message === "NO_SERVER") { kindEnrichDisabled = true; break; }
          continue;
        }
        const hit = pickFilmarksIdMatch(results, m.title, m.year);
        if (hit && hit.filmarksId) {
          m.filmarksId = hit.filmarksId;
          resolved = true;
        } else {
          // 見つからなければ以後は再検索せず、分析済み扱いにする（種別なし）
          m.kindIdTried = true;
          m.kindChecked = true;
          if (!m.meta) m.meta = { directors: [], cast: [] };
          changed++;
        }
      }
      if (resolved) saveState();
      if (kindEnrichDisabled) return;

      // 2) filmarksId 経由で監督・出演・種別・公開年・ジャンルを取得
      const fmTargets = enrichPool().filter((m) => needs(m) && m.filmarksId);
      changed += await fetchCreditsBatch(
        fmTargets, (m) => m.filmarksId, "/api/filmarks/details",
        () => { kindEnrichDisabled = true; });
    } finally {
      kindEnrichRunning = false;
      if (changed) {
        updateThemeButton();
        updateFilterInfo();
        // 絞り込みパネルを開いている最中なら、候補を最新化する
        if (currentThemePanel) {
          const anchor = document.getElementById("themeFilterBtn");
          closeThemePanel();
          if (anchor) openThemePanel(anchor);
        }
      }
    }
    // まだ ID 未解決の旧データが残っていれば続きをスケジュール
    if (!kindEnrichDisabled &&
        enrichPool().some((m) => needs(m) && !m.filmarksId && !m.kindIdTried)) {
      scheduleKindEnrich();
    }
  }

  // =======================================================================
  // 登録を促進する機能：共通ユーティリティ（チェックして一括追加するグリッド）
  // =======================================================================
  function makePickCard(f, opts) {
    opts = opts || {};
    const added = movieExists(f);
    const card = document.createElement("div");
    card.className = "result-card pick-card" + (added ? " result-added" : "");
    card._film = f;
    const sub = opts.subtitle != null
      ? opts.subtitle
      : (f.date ? f.date.replace(/-/g, "/") : (f.year || ""));
    card.innerHTML =
      (f.poster
        ? `<img src="${f.poster}" alt="" loading="lazy" crossorigin="anonymous" />`
        : `<div class="result-fallback">🎬</div>`) +
      `<div class="result-meta">
         <div class="result-title">${escapeHtml(f.title)}</div>
         <div class="result-year">${escapeHtml(sub)}</div>
       </div>` +
      `<div class="pick-badge">${added ? "✓ 登録済" : "選ぶ"}</div>`;
    if (!added) {
      card.addEventListener("click", () => {
        card.classList.toggle("picked");
        card.querySelector(".pick-badge").textContent =
          card.classList.contains("picked") ? "✓ 選択中" : "選ぶ";
        if (opts.onToggle) opts.onToggle();
      });
    }
    return card;
  }

  function collectPicked(grid) {
    return [...grid.querySelectorAll(".pick-card.picked")].map((c) => c._film);
  }

  function addFilms(films) {
    if (addTarget === "watchlist") return addFilmsToWatchlist(films);
    let count = 0;
    justAddedIds = new Set();
    films.forEach((f) => {
      if (movieExists(f)) return;
      const m = { title: f.title, poster: f.poster || "", year: f.year || "" };
      if (f.eigaId) m.eigaId = f.eigaId;
      if (f.tmdbId) m.tmdbId = f.tmdbId;
      if (f.filmarksId) m.filmarksId = f.filmarksId;
      if (f.collection) m.collection = f.collection;
      removeFromWatchlistByMatch(m);
      const id = uid();
      justAddedIds.add(id);
      state.pool.push({ id, ...m });
      count++;
    });
    if (count) render();
    return count;
  }

  let justAddedIds = new Set();
  let justAddedTimer = 0;

  function notifyBulkAdded(btnId, gridId, c) {
    const toWl = addTarget === "watchlist";
    const dest = toWl ? "観たい" : "未分類";
    const btn = document.getElementById(btnId);
    if (btn) {
      clearTimeout(btn._doneT);
      btn.classList.add("is-done");
      btn.disabled = true;
      btn.textContent = `✓ ${c}本を${dest}に追加しました`;
      btn._doneT = setTimeout(() => {
        btn.classList.remove("is-done");
        setPickBtn(btnId, gridId);
      }, 2200);
    }
    toast(`✓ ${c}本を「${dest}」に追加しました`, {
      label: "閉じて確認する",
      onClick: () => {
        closeModal("addMovieModal");
        if (toWl) {
          state.watchlistCollapsed = false;
        } else {
          state.poolCollapsed = false;
        }
        render();
        const target = toWl ? el.tierRows.querySelector(".tier-row-watchlist") : document.querySelector(".pool");
        if (target) {
          const head = document.querySelector(".app-header");
          const y = target.getBoundingClientRect().top + window.scrollY - (head ? head.offsetHeight : 0) - 12;
          window.scrollTo({ top: y, behavior: "smooth" });
        }
      },
    });
    clearTimeout(justAddedTimer);
    justAddedTimer = setTimeout(() => {
      justAddedIds = new Set();
      document.querySelectorAll(".movie-card.just-added").forEach((c) => c.classList.remove("just-added"));
    }, 12000);
  }

  function setPickBtn(btnId, gridId) {
    const n = collectPicked(document.getElementById(gridId)).length;
    const btn = document.getElementById(btnId);
    if (btn._doneT) { clearTimeout(btn._doneT); btn._doneT = 0; btn.classList.remove("is-done"); }
    btn.textContent = n ? `選んだ${n}本を追加` : "観た作品をタップで選択";
    btn.disabled = n === 0;
  }

  // =======================================================================
  // 公開年（その年に公開された作品を公開が早い順にチェックして追加）
  // =======================================================================
  // 「もっと見る」用のセッション状態。pool には取得済みの未登録作（公開日つき）が入る。
  let recallSession = { year: null, nextPage: 1, hasMore: false, skipped: 0, seen: new Set(), pool: [] };

  function initRecallUI() {
    const sel = document.getElementById("recallYear");
    if (sel.options.length) return;
    const curY = new Date().getFullYear();
    for (let y = curY; y >= 1930; y--) {
      const o = document.createElement("option");
      o.value = String(y);
      o.textContent = y + "年";
      sel.appendChild(o);
    }
    sel.value = String(curY - 10);
  }

  // Filmarks から「公開年」ベースの作品リストを取得
  // （サーバー側で製作年 Y〜Y-5 を横断し、上映日=オリジナル公開日の年で絞り込む。
  //   製作が数年前でもその年に日本公開された作品を拾い、リバイバル上映は
  //   再公開年ではなくオリジナル公開年で扱われる）
  const RECALL_MIN = 100;        // 初回に集める未登録作の最小件数
  const RECALL_BATCH_PAGES = 8;  // 1回のサーバーリクエストで取得するページ数（1ページ約36件）

  // 公開が早い順（日本公開日 YYYYMMDD の昇順）に並べるためのソートキー。
  // 上映日が不明な作品はその年の末尾に回す（先頭に来て順序を乱さないように）。
  function recallSortKey(f) {
    if (f.date) return Number(f.date.replace(/-/g, ""));
    return Number(f.year || "0") * 10000 + 9999;
  }

  // Filmarks の公開年別ページを [from, from+pages) の範囲で取得
  async function fetchFilmarksRange(year, from, pages) {
    let res;
    try {
      res = await fetch(`/api/filmarks/release_year?year=${year}&from=${from}&pages=${pages}`);
    } catch (e) {
      throw new Error("NO_SERVER");
    }
    if (!res.ok) throw new Error("HTTP_" + res.status);
    const data = await res.json();
    return { results: data.results || [], hasMore: !!data.hasMore };
  }

  // 次のページ範囲を取得し、未登録・重複なしの作品を pool に追加する。
  // 返り値: 今回追加できた新規作品数
  async function fetchRecallBatch() {
    const s = recallSession;
    if (!s.hasMore) return 0;
    const data = await fetchFilmarksRange(s.year, s.nextPage, RECALL_BATCH_PAGES);
    s.nextPage += RECALL_BATCH_PAGES;
    s.hasMore = data.hasMore;
    let added = 0;
    for (const b of data.results) {
      const key = normTitle(b.title);
      if (key && s.seen.has(key)) continue;
      if (key) s.seen.add(key);
      if (isRegisteredByTitle(b.title)) { s.skipped++; continue; }
      s.pool.push({ title: b.title, year: b.year || "", poster: b.poster || "", date: b.date || "", filmarksId: b.id });
      added++;
    }
    return added;
  }

  function recallServerHint() {
    return "「公開年」機能にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
  }

  function updateRecallStatus() {
    const status = document.getElementById("recallStatus");
    const s = recallSession;
    if (!s.pool.length) {
      status.textContent = s.skipped
        ? `${s.year}年の作品はすべて登録済みでした。別の年をお試しください。`
        : `${s.year}年の作品が見つかりませんでした。別の年をお試しください。`;
      return;
    }
    let msg = `${s.year}年の作品を公開が早い順に ${s.pool.length}件表示中。観た作品をタップして選び、まとめて追加できます。`;
    if (s.skipped) msg += `（登録済み ${s.skipped}件は除外）`;
    if (!s.hasMore) msg += ` ※この年の未登録作はこれで全て表示しました。`;
    status.textContent = msg;
  }

  function updateRecallMoreBtn() {
    const wrap = document.getElementById("recallMoreWrap");
    if (!wrap) return;
    const s = recallSession;
    wrap.style.display = (s.pool.length && s.hasMore) ? "flex" : "none";
  }

  async function loadRecall() {
    const status = document.getElementById("recallStatus");
    const grid = document.getElementById("recallGrid");
    const actions = document.getElementById("recallActions");
    grid.innerHTML = "";
    actions.style.display = "none";
    const year = parseInt(document.getElementById("recallYear").value, 10);
    recallSession = { year, nextPage: 1, hasMore: true, skipped: 0, seen: new Set(), pool: [] };
    updateRecallMoreBtn();

    status.textContent = `${year}年の作品を取得中…`;
    try {
      while (recallSession.pool.length < RECALL_MIN && recallSession.hasMore) {
        await fetchRecallBatch();
      }
    } catch (e) {
      status.innerHTML = e.message === "NO_SERVER"
        ? recallServerHint()
        : "取得に失敗しました: " + e.message;
      return;
    }
    renderRecallFull();
    updateRecallStatus();
    updateRecallMoreBtn();
  }

  async function loadMoreRecall() {
    const btn = document.getElementById("recallMoreBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "読み込み中…";
    try {
      // 未登録作が最低1件は増えるまで（空振り対策で数バッチ）取得を試みる
      let added = 0, tries = 0;
      while (recallSession.hasMore && added < 1 && tries < 8) {
        added += await fetchRecallBatch();
        tries++;
      }
    } catch (e) {
      document.getElementById("recallStatus").innerHTML = e.message === "NO_SERVER"
        ? recallServerHint()
        : "取得に失敗しました: " + e.message;
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    // プール全体を日本公開日順に並べ直して描画（追加分も正しい位置に差し込まれる）
    renderRecallFull();
    updateRecallStatus();
    btn.disabled = false;
    btn.textContent = label;
    updateRecallMoreBtn();
  }

  const recallSortCmp = (a, b) =>
    recallSortKey(a) - recallSortKey(b) || a.title.localeCompare(b.title, "ja");

  function appendRecallCard(grid, f, pickedSet) {
    const card = makePickCard(f, { onToggle: () => setPickBtn("recallAddBtn", "recallGrid") });
    if (pickedSet && pickedSet.has(normTitle(f.title))) {
      card.classList.add("picked");
      const badge = card.querySelector(".pick-badge");
      if (badge) badge.textContent = "✓ 選択中";
    }
    grid.appendChild(card);
  }

  // pool 全体を公開が早い順に並べ替えて描画し直す（初回・追加登録後に使用）
  function renderRecallFull() {
    const grid = document.getElementById("recallGrid");
    const actions = document.getElementById("recallActions");
    const s = recallSession;
    const picked = new Set(collectPicked(grid).map((f) => normTitle(f.title)));
    grid.innerHTML = "";
    if (!s.pool.length) {
      actions.style.display = "none";
      return;
    }
    s.pool.sort(recallSortCmp);
    s.pool.forEach((f) => appendRecallCard(grid, f, picked));
    actions.style.display = "flex";
    setPickBtn("recallAddBtn", "recallGrid");
  }

  function bulkAddRecall() {
    const picked = collectPicked(document.getElementById("recallGrid"));
    const c = addFilms(picked);
    if (c) {
      // 追加済みは候補から除去して残りを再描画
      const added = new Set(picked.map((p) => normTitle(p.title)));
      recallSession.pool = recallSession.pool.filter((f) => !added.has(normTitle(f.title)));
      renderRecallFull();
      updateRecallStatus();
      notifyBulkAdded("recallAddBtn", "recallGrid", c);
      updateRecallMoreBtn();
    }
  }

  // =======================================================================
  // おすすめ（登録済みの監督・出演者から未登録作を提案）
  // =======================================================================
  let recommendFilms = [];

  async function filmarksPersonFirst(name) {
    let res;
    try {
      res = await fetch("/api/filmarks/person/search?q=" + encodeURIComponent(name));
    } catch (e) {
      throw new Error("NO_SERVER");
    }
    if (!res.ok) return null;
    const d = await res.json();
    return (d.results || [])[0] || null;
  }

  async function filmarksPersonFilms(id) {
    const res = await fetch("/api/filmarks/person/movies?id=" + encodeURIComponent(id));
    if (!res.ok) return [];
    const d = await res.json();
    return d.results || [];
  }

  // 人物ごとのフィルモグラフィ・作品詳細は「候補を更新」でも使い回す
  const recPersonCache = new Map();   // name -> films[] | null
  const recDetailCache = new Map();   // filmarksId -> details
  let recShown = new Set();
  let recRunId = 0;
  let recBuilding = 0;
  const REC_CACHE_KEY = "movieTierList.recCache.v1";
  const REC_CACHE_TTL = 7 * 24 * 3600 * 1000;
  let recCacheLoaded = false;

  // 人物の作品一覧・作品詳細を端末に7日間保存し、次回以降の表示を速くする
  function recLoadCache() {
    if (recCacheLoaded) return;
    recCacheLoaded = true;
    try {
      const c = JSON.parse(localStorage.getItem(REC_CACHE_KEY) || "{}");
      const now = Date.now();
      Object.entries(c.persons || {}).forEach(([k, v]) => { if (now - v.t < REC_CACHE_TTL) recPersonCache.set(k, v.f); });
      Object.entries(c.details || {}).forEach(([k, v]) => { if (now - v.t < REC_CACHE_TTL) recDetailCache.set(k, v.d); });
      recCacheTimes = c;
    } catch (e) {}
  }
  let recCacheTimes = {};

  function recSaveCache() {
    try {
      const now = Date.now();
      const old = recCacheTimes || {};
      const persons = {}, details = {};
      recPersonCache.forEach((f, k) => {
        if (f) persons[k] = { t: (old.persons && old.persons[k] && old.persons[k].t) || now, f };
      });
      [...recDetailCache.entries()].slice(-500).forEach(([k, d]) => {
        if (!d) return;
        details[k] = {
          t: (old.details && old.details[k] && old.details[k].t) || now,
          d: { directors: d.directors || [], cast: (d.cast || []).slice(0, 6), genreIds: d.genreIds || [], rating: d.rating || 0 },
        };
      });
      recCacheTimes = { persons, details };
      localStorage.setItem(REC_CACHE_KEY, JSON.stringify(recCacheTimes));
    } catch (e) {}
  }
  const recNorm = (s) => String(s || "").replace(/[\s　・･.]/g, "").toLowerCase();

  // ティア順位で重み付けした人物スコア。上位ティアほど高く、下位ティアはマイナス。
  // 出演者は主要キャスト（上位3人）を重く、脇役は軽く数える。
  function recommendProfile() {
    const dir = new Map(), act = new Map(), gen = new Map();
    const bump = (mp, k, w) => { if (k) mp.set(k, (mp.get(k) || 0) + w); };
    const N = state.tiers.length;
    const add = (m, w) => {
      if (m.meta) {
        (m.meta.directors || []).forEach((d) => bump(dir, d, w * 1.5));
        (m.meta.cast || []).forEach((c, i) => bump(act, c, w * (i < 3 ? 1 : 0.35)));
      }
      (m.genres || []).forEach((g) => bump(gen, g, w));
    };
    state.tiers.forEach((t, i) => {
      const w = N > 1 ? 3 - (4 * i) / (N - 1) : 2;
      t.items.forEach((m) => add(m, w));
    });
    state.pool.forEach((m) => add(m, 0.5));
    const top = (mp, k) => [...mp.entries()].filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k);
    const genTotal = [...gen.values()].reduce((a, v) => a + Math.max(0, v), 0) || 1;
    return {
      people: [...top(dir, 8).map(([n, w]) => ({ name: n, w, role: "dir" })),
               ...top(act, 12).map(([n, w]) => ({ name: n, w, role: "act" }))],
      gen, genTotal,
    };
  }

  async function recPersonFilms(name) {
    if (recPersonCache.has(name)) return recPersonCache.get(name);
    let res;
    try {
      res = await fetch("/api/filmarks/person/search?q=" + encodeURIComponent(name));
    } catch (e) {
      throw new Error("NO_SERVER");
    }
    let films = null;
    if (res.ok) {
      const d = await res.json();
      const list = d.results || [];
      // 同姓同名・部分一致を避けるため、名前が完全一致する人物を優先
      const p = list.find((x) => recNorm(x.name) === recNorm(name));
      if (p) films = (await filmarksPersonFilms(p.id)).map((f) => ({
        id: f.id, title: f.title, year: f.year || "", date: f.date || "", poster: f.poster || "",
      }));
    }
    recPersonCache.set(name, films);
    return films;
  }

  async function recFetchDetails(ids) {
    const need = ids.filter((id) => !recDetailCache.has(id));
    for (let i = 0; i < need.length; i += 60) {
      const chunk = need.slice(i, i + 60);
      try {
        const res = await fetch("/api/filmarks/details?ids=" + encodeURIComponent(chunk.join(",")));
        if (!res.ok) continue;
        const data = await res.json();
        chunk.forEach((id) => recDetailCache.set(id, (data.results || {})[id] || null));
      } catch (e) { break; }
    }
  }

  async function buildRecommendations() {
    recBuilding++;
    try { await buildRecommendationsNow(); } finally { recBuilding--; }
  }

  async function buildRecommendationsNow() {
    const runId = ++recRunId;
    recLoadCache();
    const status = document.getElementById("recommendStatus");
    const grid = document.getElementById("recommendGrid");
    const actions = document.getElementById("recommendActions");
    const btn = document.getElementById("recommendRefreshBtn");
    grid.innerHTML = "";
    actions.style.display = "none";

    const movies = allMovies();
    if (!movies.length) {
      status.textContent = "まずは観た映画を数本登録してください。登録した監督・出演者から候補を提案します。";
      return;
    }
    if (!movies.some((m) => m.meta)) {
      status.innerHTML =
        `候補を作るには登録作の監督・出演者情報が必要です。 ` +
        `<button id="recAnalyzeBtn" class="btn btn-primary btn-sm">リストを分析する</button>`;
      const b = document.getElementById("recAnalyzeBtn");
      if (b) b.addEventListener("click", async () => { await enrichThemes(); buildRecommendations(); });
      return;
    }

    const prof = recommendProfile();
    if (!prof.people.length) {
      status.textContent = "監督・出演者の情報が見つかりませんでした。";
      return;
    }

    if (btn) btn.disabled = true;
    try {
      // 1) 好みの人物のフィルモグラフィを集める（2回目以降はキャッシュ）
      let done = 0;
      const queue = [...prof.people];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          await recPersonFilms(p.name);
          done++;
          if (runId === recRunId)
            status.textContent = `あなたの好みから候補を集めています… ${done}/${prof.people.length}`;
        }
      };
      await Promise.all(Array.from({ length: 5 }, worker));
      if (runId !== recRunId) return;

      const thisYear = new Date().getFullYear();
      const today = new Date().toISOString().slice(0, 10);
      const cands = new Map();
      prof.people.forEach((p) => {
        (recPersonCache.get(p.name) || []).forEach((f) => {
          if (!f.id || (f.year && +f.year > thisYear) || (f.date && f.date > today)) return;
          if (movieExists({ filmarksId: f.id, title: f.title })) return;
          const c = cands.get(f.id) || {
            film: { title: f.title, poster: f.poster || "", year: f.year || "", filmarksId: f.id },
            people: [], base: 0,
          };
          c.people.push(p);
          c.base += p.w;
          cands.set(f.id, c);
        });
      });

      // 2) 既に表示した候補は後回しにし、未表示の上位から作品詳細を取得して精査
      let pool = [...cands.values()].filter((c) => !recShown.has(c.film.filmarksId));
      if (pool.length < 20) { recShown = new Set(); pool = [...cands.values()]; }
      pool.sort((a, b) => b.base - a.base);
      pool = pool.slice(0, 60);
      const jitter = new Map(pool.map((c) => [c.film.filmarksId, 0.85 + Math.random() * 0.3]));
      const missing = pool.some((c) => !recDetailCache.has(c.film.filmarksId));
      if (missing) {
        // 詳細の確認を待たずに、まずは仮の順位で表示しておく
        recommendFilms = recScore(pool, prof, jitter).slice(0, 40);
        renderRecommend();
        status.textContent = `${recommendFilms.length}件の候補を表示中（評価・出演の確認中…まもなく並び替わります）`;
        await recFetchDetails(pool.map((c) => c.film.filmarksId));
        if (runId !== recRunId) return;
      }

      recommendFilms = recScore(pool, prof, jitter).slice(0, 40);
      recommendFilms.forEach((f) => recShown.add(f.filmarksId));
      recSaveCache();

      if (!recommendFilms.length) {
        status.textContent = "新しい候補が見つかりませんでした（すでに多く登録済みかもしれません）。";
        renderRecommend();
        return;
      }
      status.textContent = `${recommendFilms.length}件の候補（好みに近い順）。観た作品をタップして選び、まとめて追加できます。「候補を更新」で別の作品を表示します。`;
      renderRecommend();
    } catch (e) {
      if (e.message === "NO_SERVER")
        status.innerHTML =
          "候補の取得にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
      else status.textContent = "候補の取得に失敗しました。少し時間をおいて再度お試しください。";
    } finally {
      if (btn && runId === recRunId) btn.disabled = false;
    }
  }

  function recScore(pool, prof, jitter) {
      const scored = pool.map((c) => {
        const d = recDetailCache.get(c.film.filmarksId);
        let score = 0;
        const reasons = [];
        c.people.forEach((p) => {
          // 実際に監督／主要キャストかを作品詳細で確認。端役・ナレーション等は軽く
          let k = 0.3;
          if (d) {
            const dirs = (d.directors || []).map(recNorm);
            const cast = (d.cast || []).map(recNorm);
            const idx = cast.indexOf(recNorm(p.name));
            if (dirs.includes(recNorm(p.name))) k = 1;
            else if (idx >= 0) k = idx < 4 ? 1 : 0.6;
          } else k = 0.6;
          score += p.w * k;
          if (k >= 0.6) reasons.push({ label: p.role === "dir" ? `${p.name}監督` : p.name, w: p.w * k });
        });
        if (d) {
          const genres = (d.genreIds || []).map(fmGenreLabel).filter(Boolean);
          genres.forEach((g) => { score += 2 * Math.max(0, prof.gen.get(g) || 0) / prof.genTotal; });
          if (d.rating) score *= Math.min(1.4, Math.max(0.4, (d.rating - 2.8) / 1.0));
          else score *= 0.5;
        }
        score *= jitter.get(c.film.filmarksId) || 1;
        reasons.sort((a, b) => b.w - a.w);
        const rating = d && d.rating ? `★${d.rating.toFixed(1)}` : "";
        return {
          ...c.film,
          reason: [reasons.slice(0, 2).map((r) => r.label).join("・"), rating].filter(Boolean).join(" ・ "),
          _score: score,
        };
      }).filter((f) => f._score > 0);
      return scored.sort((a, b) => b._score - a._score);
  }

  function renderRecommend() {
    const grid = document.getElementById("recommendGrid");
    const actions = document.getElementById("recommendActions");
    const picked = new Set(collectPicked(grid).map((f) => f.filmarksId));
    grid.innerHTML = "";
    const list = recommendFilms.filter((f) => !movieExists({ filmarksId: f.filmarksId, title: f.title }));
    if (!list.length) {
      actions.style.display = "none";
      return;
    }
    list.forEach((f) => {
      const card = makePickCard(f, {
        subtitle: (f.year ? f.year + " ・ " : "") + f.reason,
        onToggle: () => setPickBtn("recommendAddBtn", "recommendGrid"),
      });
      if (picked.has(f.filmarksId)) {
        card.classList.add("picked");
        card.querySelector(".pick-badge").textContent = "✓ 選択中";
      }
      grid.appendChild(card);
    });
    const tab = document.querySelector('.tab[data-tab="recommend"]');
    actions.style.display = tab && tab.classList.contains("active") ? "flex" : "none";
    setPickBtn("recommendAddBtn", "recommendGrid");
  }

  function bulkAddRecommend() {
    const c = addFilms(collectPicked(document.getElementById("recommendGrid")));
    if (c) {
      renderRecommend();
      notifyBulkAdded("recommendAddBtn", "recommendGrid", c);
    }
  }

  // =======================================================================
  // 公開予定（統計データ＝好みの傾向に合う「これから公開の作品」を提案）
  // =======================================================================
  let upcomingFilms = [];

  // ティアリストの内容から好みプロフィールを作る。上位ティアほど重みを大きくし、
  // 監督・出演者・ジャンル・種別ごとの嗜好スコアを集計する。
  function tasteProfile() {
    const dir = new Map(), act = new Map(), gen = new Map(), kind = new Map();
    const genreSet = new Set(GENRES.map((g) => g.label));
    const bump = (mp, k, w) => { if (k) mp.set(k, (mp.get(k) || 0) + w); };
    const addOne = (m, w) => {
      if (m.meta) {
        (m.meta.directors || []).forEach((d) => bump(dir, d, w));
        (m.meta.cast || []).forEach((c) => bump(act, c, w));
      }
      const gs = new Set(m.genres || []);
      movieCollections(m).forEach((l) => { if (genreSet.has(l)) gs.add(l); });
      gs.forEach((g) => bump(gen, g, w));
      if (m.kind) bump(kind, m.kind, w);
    };
    const N = state.tiers.length;
    // 上位ティア（Sなど）を厚めに。未分類は控えめに反映
    state.tiers.forEach((t, i) => { const w = (N - i) + 1; t.items.forEach((m) => addOne(m, w)); });
    state.pool.forEach((m) => addOne(m, 1));
    return { dir, act, gen, kind, count: allMovies().length };
  }

  // 公開予定の1作品を好みプロフィールに照らしてスコアリングし、理由も返す
  function scoreUpcoming(m, prof) {
    let score = 0;
    const rs = [];
    (m.meta && m.meta.directors || []).forEach((d) => {
      const w = prof.dir.get(d); if (w) { score += w * 4; rs.push({ label: `${d}監督`, w: w * 4 }); }
    });
    (m.meta && m.meta.cast || []).forEach((c) => {
      const w = prof.act.get(c); if (w) { score += w * 2; rs.push({ label: c, w: w * 2 }); }
    });
    (m.genres || []).forEach((g) => {
      const w = prof.gen.get(g); if (w) { score += w; rs.push({ label: g, w }); }
    });
    if (m.kind) { const w = prof.kind.get(m.kind); if (w) score += w * 0.3; }
    // 重複ラベルを除いて重い順に
    const seen = new Set();
    const reasons = rs.sort((a, b) => b.w - a.w)
      .filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)))
      .slice(0, 2).map((r) => r.label);
    return { score, reason: reasons.join("・") };
  }

  function openUpcomingModal() {
    openModal("upcomingModal");
    if (!upcomingFilms.length) buildUpcoming();
    else renderUpcoming();
  }

  async function buildUpcoming() {
    const status = document.getElementById("upcomingStatus");
    const grid = document.getElementById("upcomingGrid");
    grid.innerHTML = "";
    upcomingFilms = [];

    // 1) 公開予定リストを取得
    status.textContent = "これから公開される作品を集めています…";
    let list = [];
    try {
      const res = await fetch("/api/filmarks/coming?pages=8");
      if (!res.ok) throw new Error("bad");
      const data = await res.json();
      list = data.results || [];
    } catch (e) {
      status.innerHTML =
        "公開予定の取得にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
      return;
    }
    // 未来日・未登録・未ウォッチのものだけに絞る
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    const cands = [];
    list.forEach((f) => {
      if (!f.id || seen.has(f.id)) return;
      if (f.date && f.date < today) return;
      if (movieExists({ filmarksId: f.id, title: f.title })) return;
      seen.add(f.id);
      cands.push({ title: f.title, poster: f.poster || "", year: f.year || "",
        date: f.date || "", filmarksId: f.id });
    });
    if (!cands.length) {
      status.textContent = "公開予定の新作が見つかりませんでした。少し時間をおいて再度お試しください。";
      return;
    }

    // 2) 好みプロフィール
    const prof = tasteProfile();

    // 3) 各作品の監督・出演・ジャンル・種別を取得（好みとの照合＋作品情報の表示用）
    for (let i = 0; i < cands.length; i += 60) {
      const chunk = cands.slice(i, i + 60);
      const ids = chunk.map((m) => m.filmarksId).join(",");
      let res;
      try {
        res = await fetch("/api/filmarks/details?ids=" + encodeURIComponent(ids));
      } catch (e) { break; }
      if (!res.ok) continue;
      const data = await res.json();
      chunk.forEach((m) => applyCredit(m, (data.results || {})[m.filmarksId]));
      status.textContent = `作品情報を取得しています… ${Math.min(i + 60, cands.length)}/${cands.length}`;
    }

    // 4) スコアリングして並べ替え（好み一致が上位、次に公開日の早い順）
    upcomingFilms = cands.map((m) => {
      const { score, reason } = prof.count ? scoreUpcoming(m, prof) : { score: 0, reason: "" };
      return {
        title: m.title, poster: m.poster, year: m.year, date: m.date,
        filmarksId: m.filmarksId, reason, _score: score,
        directors: (m.meta && m.meta.directors) || [],
        cast: (m.meta && m.meta.cast) || [],
        genres: m.genres || [], kind: m.kind || "",
      };
    }).sort((a, b) => b._score - a._score || String(a.date).localeCompare(String(b.date)));

    const matched = upcomingFilms.filter((f) => f._score > 0).length;
    if (!prof.count) {
      status.textContent = `近日公開の${upcomingFilms.length}件を公開日順に表示しています。観た映画を登録すると、あなたの好みに合わせて並び替えます。`;
    } else if (matched) {
      status.textContent = `あなたの好みに近い公開予定作を上位に${matched}件。「作品情報 ↗」で詳細を確認して、観たいリストに追加できます。`;
    } else {
      status.textContent = `好みに近い新作は見つかりませんでしたが、近日公開の${upcomingFilms.length}件を表示します。`;
    }
    renderUpcoming();
  }

  function renderUpcoming() {
    const grid = document.getElementById("upcomingGrid");
    grid.innerHTML = "";
    // すでにティア/未分類にある作品（鑑賞済み）は除外。観たいリスト済みは「追加済み」表示で残す。
    const list = upcomingFilms.filter(
      (f) => !movieExists({ filmarksId: f.filmarksId, title: f.title }));
    if (!list.length) return;
    // マッチ度は「その回の最高スコア」を100%とした相対値で表す
    const maxScore = list.reduce((mx, f) => Math.max(mx, f._score || 0), 0);
    list.forEach((f) => {
      const matchPct = maxScore > 0 ? Math.round((f._score || 0) / maxScore * 100) : null;
      grid.appendChild(makeUpcomingCard(f, matchPct));
    });
  }

  // マッチ度の見た目（帯の色とラベル）を段階で返す
  function matchTier(pct) {
    if (pct >= 80) return { cls: "up-match-high", label: "ぴったり" };
    if (pct >= 50) return { cls: "up-match-mid", label: "好みに近い" };
    if (pct >= 20) return { cls: "up-match-low", label: "ややマッチ" };
    return { cls: "up-match-none", label: "参考" };
  }

  function makeUpcomingCard(f, matchPct) {
    const card = document.createElement("div");
    card.className = "up-card";
    const inWatch = watchlistExists({ filmarksId: f.filmarksId, title: f.title });
    const dateStr = f.date ? f.date.replace(/-/g, "/") : (f.year || "");
    const kindLabel = f.kind ? (KIND_LABEL[f.kind] || "") : "";
    const metaBits = [];
    if (f.directors.length) metaBits.push("監督: " + f.directors.slice(0, 2).join("・"));
    if (f.cast.length) metaBits.push("出演: " + f.cast.slice(0, 3).join("・"));
    if (f.genres.length) metaBits.push("ジャンル: " + f.genres.slice(0, 3).join("・"));

    let matchHtml = "";
    if (matchPct != null) {
      const t = matchTier(matchPct);
      matchHtml =
        `<div class="up-match ${t.cls}">
           <div class="up-match-head">
             <span class="up-match-label">🎯 マッチ度 <b>${matchPct}%</b></span>
             <span class="up-match-tag">${t.label}</span>
           </div>
           <div class="up-match-bar"><span style="width:${matchPct}%"></span></div>
           ${f.reason ? `<div class="up-reason">✨ ${escapeHtml(f.reason)}</div>` : ""}
         </div>`;
    }

    card.innerHTML =
      (f.poster
        ? `<img class="up-poster" src="${f.poster}" alt="" loading="lazy" crossorigin="anonymous" />`
        : `<div class="up-poster up-poster-fallback">🎬</div>`) +
      `<div class="up-info">
         <div class="up-title">${escapeHtml(f.title)}</div>
         <div class="up-sub">📅 ${escapeHtml(dateStr)}公開${kindLabel ? " ・ " + escapeHtml(kindLabel) : ""}</div>
         ${matchHtml}
         ${metaBits.length ? `<div class="up-meta">${escapeHtml(metaBits.join(" ／ "))}</div>` : ""}
         <div class="up-actions">
           <button class="btn btn-sm up-add ${inWatch ? "up-added" : "btn-primary"}"${inWatch ? " disabled" : ""}>${inWatch ? "✓ 観たいリストに追加済み" : "🔖 観たいリストに追加"}</button>
           <a class="btn btn-ghost btn-sm" href="https://filmarks.com/movies/${encodeURIComponent(f.filmarksId)}" target="_blank" rel="noopener">作品情報 ↗</a>
         </div>
       </div>`;
    const addBtn = card.querySelector(".up-add");
    if (!inWatch) {
      addBtn.addEventListener("click", () => {
        const ok = addToWatchlist({
          title: f.title, poster: f.poster || "", year: f.year || "", filmarksId: f.filmarksId,
        });
        if (ok) {
          addBtn.disabled = true;
          addBtn.classList.remove("btn-primary");
          addBtn.classList.add("up-added");
          addBtn.textContent = "✓ 観たいリストに追加済み";
        }
      });
    }
    return card;
  }

  // =======================================================================
  // コレクション（人気シリーズ・名作をチェックして追加）
  // =======================================================================
  const COLLECTIONS = [
    {
      id: "ghibli", label: "スタジオジブリ", emoji: "🌿",
      titles: [
        "風の谷のナウシカ", "天空の城ラピュタ", "となりのトトロ", "火垂るの墓", "魔女の宅急便",
        "おもひでぽろぽろ", "紅の豚", "平成狸合戦ぽんぽこ", "耳をすませば", "もののけ姫",
        "ホーホケキョ となりの山田くん", "千と千尋の神隠し", "猫の恩返し", "ハウルの動く城",
        "ゲド戦記", "崖の上のポニョ", "借りぐらしのアリエッティ", "コクリコ坂から", "風立ちぬ",
        "かぐや姫の物語", "思い出のマーニー", "レッドタートル ある島の物語", "アーヤと魔女", "君たちはどう生きるか",
      ],
    },
    {
      id: "pixar", label: "ピクサー", emoji: "💡",
      titles: [
        "トイ・ストーリー", "モンスターズ・インク", "ファインディング・ニモ", "Mr.インクレディブル",
        "カーズ", "レミーのおいしいレストラン", "ウォーリー", "カールじいさんの空飛ぶ家", "トイ・ストーリー3",
        "メリダとおそろしの森", "モンスターズ・ユニバーシティ", "インサイド・ヘッド", "アーロと少年",
        "ファインディング・ドリー", "リメンバー・ミー", "インクレディブル・ファミリー", "トイ・ストーリー4",
        "2分の1の魔法", "ソウルフル・ワールド", "あの夏のルカ", "私ときどきレッサーパンダ",
        "バズ・ライトイヤー", "マイ・エレメント", "インサイド・ヘッド2",
      ],
    },
    {
      id: "hp", label: "ハリー・ポッター / ファンタビ", emoji: "⚡",
      titles: [
        "ハリー・ポッターと賢者の石", "ハリー・ポッターと秘密の部屋", "ハリー・ポッターとアズカバンの囚人",
        "ハリー・ポッターと炎のゴブレット", "ハリー・ポッターと不死鳥の騎士団", "ハリー・ポッターと謎のプリンス",
        "ハリー・ポッターと死の秘宝 PART1", "ハリー・ポッターと死の秘宝 PART2",
        "ファンタスティック・ビーストと魔法使いの旅", "ファンタスティック・ビーストの黒い魔法使いの誕生",
        "ファンタスティック・ビーストとダンブルドアの秘密",
      ],
    },
    {
      id: "mi", label: "ミッション:インポッシブル", emoji: "🕶️",
      titles: [
        "ミッション:インポッシブル", "M:i-2", "ミッション:インポッシブル3",
        "ミッション:インポッシブル/ゴースト・プロトコル", "ミッション:インポッシブル/ローグ・ネイション",
        "ミッション:インポッシブル/フォールアウト", "ミッション:インポッシブル/デッドレコニング PART ONE",
      ],
    },
    {
      id: "fast", label: "ワイルド・スピード", emoji: "🏎️",
      titles: [
        "ワイルド・スピード", "ワイルド・スピードX2", "ワイルド・スピードX3 TOKYO DRIFT",
        "ワイルド・スピード MAX", "ワイルド・スピード MEGA MAX", "ワイルド・スピード EURO MISSION",
        "ワイルド・スピード SKY MISSION", "ワイルド・スピード ICE BREAK",
        "ワイルド・スピード/スーパーコンボ", "ワイルド・スピード ジェットブレイク",
      ],
    },
    {
      id: "bond", label: "007（クレイグ期）", emoji: "🍸",
      titles: [
        "007 カジノ・ロワイヤル", "007 慰めの報酬", "007 スカイフォール", "007 スペクター", "007 ノー・タイム・トゥ・ダイ",
      ],
    },
    {
      id: "mcu", label: "マーベル（アベンジャーズ系）", emoji: "🦸",
      titles: [
        "アイアンマン", "アイアンマン2", "マイティ・ソー", "キャプテン・アメリカ/ザ・ファースト・アベンジャー",
        "アベンジャーズ", "アイアンマン3", "アベンジャーズ/エイジ・オブ・ウルトロン", "シビル・ウォー/キャプテン・アメリカ",
        "ドクター・ストレンジ", "スパイダーマン:ホームカミング", "マイティ・ソー バトルロイヤル", "ブラックパンサー",
        "アベンジャーズ/インフィニティ・ウォー", "キャプテン・マーベル", "アベンジャーズ/エンドゲーム",
      ],
    },
    {
      id: "lotr", label: "ロード・オブ・ザ・リング / ホビット", emoji: "💍",
      titles: [
        "ロード・オブ・ザ・リング", "ロード・オブ・ザ・リング/二つの塔", "ロード・オブ・ザ・リング/王の帰還",
        "ホビット 思いがけない冒険", "ホビット 竜に奪われた王国", "ホビット 決戦のゆくえ",
      ],
    },
    {
      id: "sw", label: "スター・ウォーズ", emoji: "🌌",
      titles: [
        "スター・ウォーズ エピソード1/ファントム・メナス", "スター・ウォーズ エピソード2/クローンの攻撃",
        "スター・ウォーズ エピソード3/シスの復讐", "スター・ウォーズ", "スター・ウォーズ/帝国の逆襲",
        "スター・ウォーズ/ジェダイの帰還", "スター・ウォーズ/フォースの覚醒", "スター・ウォーズ/最後のジェダイ",
        "スター・ウォーズ/スカイウォーカーの夜明け", "ローグ・ワン/スター・ウォーズ・ストーリー",
      ],
    },
    {
      id: "jurassic", label: "ジュラシック・パーク / ワールド", emoji: "🦕",
      titles: [
        "ジュラシック・パーク", "ロスト・ワールド/ジュラシック・パーク", "ジュラシック・パークIII",
        "ジュラシック・ワールド", "ジュラシック・ワールド/炎の王国", "ジュラシック・ワールド/新たなる支配者",
      ],
    },
    {
      id: "btf", label: "バック・トゥ・ザ・フューチャー", emoji: "🚗",
      titles: [
        "バック・トゥ・ザ・フューチャー", "バック・トゥ・ザ・フューチャー PART2", "バック・トゥ・ザ・フューチャー PART3",
      ],
    },
    {
      id: "matrix", label: "マトリックス", emoji: "🕳️",
      titles: [
        "マトリックス", "マトリックス リローデッド", "マトリックス レボリューションズ", "マトリックス レザレクションズ",
      ],
    },
    {
      id: "nolan", label: "クリストファー・ノーラン監督作", emoji: "🎩",
      titles: [
        "メメント", "バットマン ビギンズ", "プレステージ", "ダークナイト", "インセプション",
        "ダークナイト ライジング", "インターステラー", "ダンケルク", "TENET テネット", "オッペンハイマー",
      ],
    },
    {
      id: "spiderman", label: "スパイダーマン（実写）", emoji: "🕷️",
      titles: [
        "スパイダーマン", "スパイダーマン2", "スパイダーマン3", "アメイジング・スパイダーマン",
        "アメイジング・スパイダーマン2", "スパイダーマン:ホームカミング", "スパイダーマン:ファー・フロム・ホーム",
        "スパイダーマン:ノー・ウェイ・ホーム",
      ],
    },
    {
      id: "pirates", label: "パイレーツ・オブ・カリビアン", emoji: "🏴‍☠️",
      titles: [
        "パイレーツ・オブ・カリビアン/呪われた海賊たち", "パイレーツ・オブ・カリビアン/デッドマンズ・チェスト",
        "パイレーツ・オブ・カリビアン/ワールド・エンド", "パイレーツ・オブ・カリビアン/生命の泉",
        "パイレーツ・オブ・カリビアン/最後の海賊",
      ],
    },
    {
      id: "hosoda", label: "細田守 監督作", emoji: "🐺",
      titles: [
        "時をかける少女", "サマーウォーズ", "おおかみこどもの雨と雪", "バケモノの子", "未来のミライ", "竜とそばかすの姫",
      ],
    },
    {
      id: "shinkai", label: "新海誠 監督作", emoji: "🌠",
      titles: [
        "ほしのこえ", "雲のむこう、約束の場所", "秒速5センチメートル", "星を追う子ども", "言の葉の庭",
        "君の名は。", "天気の子", "すずめの戸締まり",
      ],
    },
    {
      id: "disney", label: "ディズニー長編アニメ", emoji: "🏰",
      titles: [
        "白雪姫", "シンデレラ", "ふしぎの国のアリス", "ピーター・パン", "眠れる森の美女", "リトル・マーメイド",
        "美女と野獣", "アラジン", "ライオン・キング", "ムーラン", "リロ&スティッチ", "塔の上のラプンツェル",
        "アナと雪の女王", "ベイマックス", "ズートピア", "モアナと伝説の海", "アナと雪の女王2",
        "ラーヤと龍の王国", "ミラベルと魔法だらけの家", "ウィッシュ",
      ],
    },
    {
      id: "indy", label: "インディ・ジョーンズ", emoji: "🤠",
      titles: [
        "レイダース/失われたアーク《聖櫃》", "インディ・ジョーンズ/魔宮の伝説", "インディ・ジョーンズ/最後の聖戦",
        "インディ・ジョーンズ/クリスタル・スカルの王国", "インディ・ジョーンズと運命のダイヤル",
      ],
    },
    {
      id: "rocky", label: "ロッキー / クリード", emoji: "🥊",
      titles: [
        "ロッキー", "ロッキー2", "ロッキー3", "ロッキー4/炎の友情", "ロッキー5/最後のドラマ",
        "ロッキー・ザ・ファイナル", "クリード チャンプを継ぐ男", "クリード 炎の宿敵", "クリード 過去の逆襲",
      ],
    },
    {
      id: "conan", label: "名探偵コナン 劇場版", emoji: "🔎",
      titles: [
        "名探偵コナン 時計じかけの摩天楼", "名探偵コナン 世紀末の魔術師", "名探偵コナン 瞳の中の暗殺者",
        "名探偵コナン ベイカー街の亡霊", "名探偵コナン 迷宮の十字路", "名探偵コナン 銀翼の奇術師",
        "名探偵コナン 純黒の悪夢", "名探偵コナン ゼロの執行人", "名探偵コナン 紺青の拳",
        "名探偵コナン 緋色の弾丸", "名探偵コナン ハロウィンの花嫁", "名探偵コナン 黒鉄の魚影",
      ],
    },
    {
      id: "terminator", label: "ターミネーター", emoji: "🤖",
      titles: [
        "ターミネーター", "ターミネーター2", "ターミネーター3", "ターミネーター4",
        "ターミネーター:新起動/ジェニシス", "ターミネーター:ニュー・フェイト",
      ],
    },
    {
      id: "alien", label: "エイリアン", emoji: "👾",
      titles: [
        "エイリアン", "エイリアン2", "エイリアン3", "エイリアン4",
        "プロメテウス", "エイリアン:コヴェナント", "エイリアン:ロムルス",
      ],
    },
    {
      id: "predator", label: "プレデター", emoji: "🌴",
      titles: [
        "プレデター", "プレデター2", "プレデターズ", "ザ・プレデター", "プレデター:ザ・プレイ",
      ],
    },
    {
      id: "diehard", label: "ダイ・ハード", emoji: "💥",
      titles: [
        "ダイ・ハード", "ダイ・ハード2", "ダイ・ハード3", "ダイ・ハード4.0", "ダイ・ハード/ラスト・デイ",
      ],
    },
    {
      id: "johnwick", label: "ジョン・ウィック", emoji: "🐕",
      titles: [
        "ジョン・ウィック", "ジョン・ウィック:チャプター2", "ジョン・ウィック:パラベラム",
        "ジョン・ウィック:コンセクエンス",
      ],
    },
    {
      id: "bourne", label: "ボーン・シリーズ", emoji: "🎯",
      titles: [
        "ボーン・アイデンティティー", "ボーン・スプレマシー", "ボーン・アルティメイタム",
        "ボーン・レガシー", "ジェイソン・ボーン",
      ],
    },
    {
      id: "xmen", label: "X-MEN", emoji: "🧬",
      titles: [
        "X-メン", "X-MEN2", "X-MEN:ファイナル ディシジョン", "X-MEN:ファースト・ジェネレーション",
        "ウルヴァリン:X-MEN ZERO", "ウルヴァリン:SAMURAI", "X-MEN:フューチャー&パスト",
        "X-MEN:アポカリプス", "LOGAN/ローガン", "X-MEN:ダーク・フェニックス",
      ],
    },
    {
      id: "deadpool", label: "デッドプール", emoji: "🩸",
      titles: ["デッドプール", "デッドプール2", "デッドプール&ウルヴァリン"],
    },
    {
      id: "transformers", label: "トランスフォーマー", emoji: "🚙",
      titles: [
        "トランスフォーマー", "トランスフォーマー/リベンジ", "トランスフォーマー/ダークサイド・ムーン",
        "トランスフォーマー/ロストエイジ", "トランスフォーマー/最後の騎士王", "バンブルビー",
        "トランスフォーマー/ビースト覚醒",
      ],
    },
    {
      id: "despicable", label: "怪盗グルー / ミニオンズ", emoji: "🍌",
      titles: [
        "怪盗グルーの月泥棒", "怪盗グルーのミニオン危機一発", "ミニオンズ", "怪盗グルーのミニオン大脱走",
        "ミニオンズ フィーバー", "怪盗グルーのミニオン超変身",
      ],
    },
    {
      id: "shrek", label: "シュレック", emoji: "👹",
      titles: ["シュレック", "シュレック2", "シュレック3", "シュレック フォーエバー", "長ぐつをはいたネコ"],
    },
    {
      id: "kungfupanda", label: "カンフー・パンダ", emoji: "🐼",
      titles: ["カンフー・パンダ", "カンフー・パンダ2", "カンフー・パンダ3", "カンフー・パンダ4"],
    },
    {
      id: "homealone", label: "ホーム・アローン", emoji: "🏠",
      titles: ["ホーム・アローン", "ホーム・アローン2", "ホーム・アローン3", "ホーム・アローン4", "ホーム・スイート・ホーム・アローン"],
    },
    {
      id: "kingsman", label: "キングスマン", emoji: "🕴️",
      titles: ["キングスマン", "キングスマン:ゴールデン・サークル", "キングスマン:ファースト・エージェント"],
    },
    {
      id: "hungergames", label: "ハンガー・ゲーム", emoji: "🏹",
      titles: [
        "ハンガー・ゲーム", "ハンガー・ゲーム2", "ハンガー・ゲーム FINAL:レジスタンス",
        "ハンガー・ゲーム FINAL:レボリューション", "ハンガー・ゲーム0",
      ],
    },
    {
      id: "twilight", label: "トワイライト", emoji: "🧛",
      titles: [
        "トワイライト～初恋～", "ニュームーン/トワイライト・サーガ", "エクリプス/トワイライト・サーガ",
        "ブレイキング・ドーン Part1", "ブレイキング・ドーン Part2",
      ],
    },
    {
      id: "conjuring", label: "死霊館ユニバース", emoji: "👻",
      titles: [
        "死霊館", "アナベル 死霊館の人形", "死霊館 エンフィールド事件", "アナベル 死霊人形の誕生",
        "死霊館のシスター", "アナベル 死霊博物館", "死霊館 悪魔のせいなら、無罪。", "死霊館 最後の儀式",
      ],
    },
    {
      id: "saw", label: "ソウ / SAW", emoji: "🪚",
      titles: [
        "ソウ", "ソウ2", "ソウ3", "ソウ4", "ソウ5", "ソウ6", "ソウ ザ・ファイナル",
        "ジグソウ:ソウ・レガシー", "スパイラル:ソウ オールリセット", "ソウX",
      ],
    },
    {
      id: "oceans", label: "オーシャンズ", emoji: "🎰",
      titles: ["オーシャンズ11", "オーシャンズ12", "オーシャンズ13", "オーシャンズ8"],
    },
    {
      id: "mib", label: "メン・イン・ブラック", emoji: "🕶️",
      titles: ["メン・イン・ブラック", "メン・イン・ブラック2", "メン・イン・ブラック3", "メン・イン・ブラック:インターナショナル"],
    },
    {
      id: "godzilla", label: "ゴジラ（近年）", emoji: "🦖",
      titles: [
        "シン・ゴジラ", "GODZILLA ゴジラ", "ゴジラ キング・オブ・モンスターズ",
        "ゴジラvsコング", "ゴジラ-1.0", "ゴジラxコング 新たなる帝国",
      ],
    },
    {
      id: "tarantino", label: "タランティーノ監督作", emoji: "🎬",
      titles: [
        "レザボア・ドッグス", "パルプ・フィクション", "ジャッキー・ブラウン", "キル・ビル Vol.1",
        "キル・ビル Vol.2", "デス・プルーフ", "イングロリアス・バスターズ", "ジャンゴ 繋がれざる者",
        "ヘイトフル・エイト", "ワンス・アポン・ア・タイム・イン・ハリウッド",
      ],
    },
    {
      id: "spielberg", label: "スピルバーグ監督作", emoji: "🦈",
      titles: [
        "ジョーズ", "未知との遭遇", "E.T.", "カラーパープル", "太陽の帝国", "シンドラーのリスト",
        "プライベート・ライアン", "A.I.", "マイノリティ・リポート", "キャッチ・ミー・イフ・ユー・キャン",
        "ミュンヘン", "リンカーン", "ブリッジ・オブ・スパイ", "レディ・プレイヤー1", "ザ・ペンタゴン・ペーパーズ",
        "ウエスト・サイド・ストーリー", "フェイブルマンズ",
      ],
    },
    {
      id: "fincher", label: "デヴィッド・フィンチャー監督作", emoji: "🩶",
      titles: [
        "セブン", "ゲーム", "ファイト・クラブ", "パニック・ルーム", "ゾディアック",
        "ベンジャミン・バトン 数奇な人生", "ソーシャル・ネットワーク", "ドラゴン・タトゥーの女",
        "ゴーン・ガール", "MANK/マンク", "ザ・キラー",
      ],
    },
    {
      id: "scorsese", label: "スコセッシ監督作", emoji: "🎩",
      titles: [
        "タクシードライバー", "レイジング・ブル", "グッドフェローズ", "カジノ", "ギャング・オブ・ニューヨーク",
        "アビエイター", "ディパーテッド", "シャッター アイランド", "ヒューゴの不思議な発明",
        "ウルフ・オブ・ウォールストリート", "沈黙 -サイレンス-", "アイリッシュマン", "キラーズ・オブ・ザ・フラワームーン",
      ],
    },
    {
      id: "ridleyscott", label: "リドリー・スコット監督作", emoji: "⚔️",
      titles: [
        "エイリアン", "ブレードランナー", "テルマ&ルイーズ", "グラディエーター", "ブラックホーク・ダウン",
        "キングダム・オブ・ヘブン", "アメリカン・ギャングスター", "プロメテウス", "オデッセイ",
        "エイリアン:コヴェナント", "最後の決闘裁判", "ハウス・オブ・グッチ", "ナポレオン", "グラディエーターII",
      ],
    },
    {
      id: "cameron", label: "ジェームズ・キャメロン監督作", emoji: "🌊",
      titles: [
        "ターミネーター", "エイリアン2", "アビス", "ターミネーター2", "トゥルーライズ",
        "タイタニック", "アバター", "アバター:ウェイ・オブ・ウォーター",
      ],
    },
    {
      id: "wesanderson", label: "ウェス・アンダーソン監督作", emoji: "🦊",
      titles: [
        "天才マックスの世界", "ザ・ロイヤル・テネンバウムズ", "ライフ・アクアティック", "ダージリン急行",
        "ファンタスティック Mr.FOX", "ムーンライズ・キングダム", "グランド・ブダペスト・ホテル",
        "犬ヶ島", "フレンチ・ディスパッチ", "アステロイド・シティ",
      ],
    },
    {
      id: "kurosawa", label: "黒澤明 監督作", emoji: "🈁",
      titles: [
        "羅生門", "生きる", "七人の侍", "蜘蛛巣城", "隠し砦の三悪人", "用心棒", "椿三十郎",
        "天国と地獄", "赤ひげ", "影武者", "乱", "夢",
      ],
    },
    {
      id: "koreeda", label: "是枝裕和 監督作", emoji: "🏡",
      titles: [
        "誰も知らない", "歩いても 歩いても", "空気人形", "奇跡", "そして父になる", "海街diary",
        "海よりもまだ深く", "三度目の殺人", "万引き家族", "真実", "ベイビー・ブローカー", "怪物",
      ],
    },
    {
      id: "evangelion", label: "エヴァンゲリオン 劇場版", emoji: "🟣",
      titles: [
        "新世紀エヴァンゲリオン劇場版 Air/まごころを、君に", "ヱヴァンゲリヲン新劇場版:序",
        "ヱヴァンゲリヲン新劇場版:破", "ヱヴァンゲリヲン新劇場版:Q", "シン・エヴァンゲリオン劇場版",
      ],
    },
    {
      id: "kyoani", label: "京都アニメーション作品", emoji: "🌸",
      titles: [
        "涼宮ハルヒの消失", "劇場版 けいおん!", "映画 聲の形", "劇場版 響け!ユーフォニアム",
        "リズと青い鳥", "ヴァイオレット・エヴァーガーデン 外伝", "劇場版 ヴァイオレット・エヴァーガーデン",
      ],
    },
    {
      id: "dreamworks", label: "ドリームワークス・アニメ", emoji: "🌙",
      titles: [
        "シュレック", "マダガスカル", "カンフー・パンダ", "ヒックとドラゴン", "メガマインド",
        "ガーディアンズ 伝説の勇者たち", "ヒックとドラゴン2", "トロールズ", "ボス・ベイビー",
        "ヒックとドラゴン 聖地への冒険", "野生の島のロズ",
      ],
    },
    {
      id: "scifi_classics", label: "名作SF", emoji: "🛸",
      titles: [
        "2001年宇宙の旅", "ブレードランナー", "エイリアン", "ターミネーター2", "マトリックス",
        "インセプション", "インターステラー", "メッセージ", "ブレードランナー 2049", "DUNE/デューン 砂の惑星",
      ],
    },
    // ---- 監督（海外） ----
    { id: "eastwood", label: "クリント・イーストウッド監督作", emoji: "🎬", titles: ["許されざる者", "ミスティック・リバー", "ミリオンダラー・ベイビー", "硫黄島からの手紙", "グラン・トリノ", "インビクタス/負けざる者たち", "アメリカン・スナイパー", "ハドソン川の奇跡", "運び屋", "クライ・マッチョ"] },
    { id: "zemeckis", label: "ロバート・ゼメキス監督作", emoji: "🕰️", titles: ["バック・トゥ・ザ・フューチャー", "ロジャー・ラビット", "フォレスト・ガンプ/一期一会", "コンタクト", "キャスト・アウェイ", "ポーラー・エクスプレス", "ベオウルフ/呪われし勇者", "フライト", "ザ・ウォーク"] },
    { id: "pta", label: "ポール・トーマス・アンダーソン監督作", emoji: "🛢️", titles: ["ブギーナイツ", "マグノリア", "パンチドランク・ラブ", "ゼア・ウィル・ビー・ブラッド", "ザ・マスター", "インヒアレント・ヴァイス", "ファントム・スレッド", "リコリス・ピザ"] },
    { id: "coen", label: "コーエン兄弟監督作", emoji: "🎳", titles: ["ファーゴ", "ビッグ・リボウスキ", "オー・ブラザー!", "バーバー", "ノーカントリー", "バーン・アフター・リーディング", "シリアスマン", "トゥルー・グリット", "インサイド・ルーウィン・デイヴィス"] },
    { id: "deltoro", label: "ギレルモ・デル・トロ監督作", emoji: "🐟", titles: ["クロノス", "デビルズ・バックボーン", "ヘルボーイ", "パンズ・ラビリンス", "パシフィック・リム", "クリムゾン・ピーク", "シェイプ・オブ・ウォーター", "ナイトメア・アリー", "ギレルモ・デル・トロのピノッキオ"] },
    { id: "villeneuve", label: "ドゥニ・ヴィルヌーヴ監督作", emoji: "🏜️", titles: ["灼熱の魂", "プリズナーズ", "複製された男", "ボーダーライン", "メッセージ", "ブレードランナー 2049", "DUNE/デューン 砂の惑星", "デューン 砂の惑星PART2"] },
    { id: "cuaron", label: "アルフォンソ・キュアロン監督作", emoji: "🌌", titles: ["リトル・プリンセス", "大いなる遺産", "天国の口、終りの楽園。", "ハリー・ポッターとアズカバンの囚人", "トゥモロー・ワールド", "ゼロ・グラビティ", "ROMA/ローマ"] },
    { id: "inarritu", label: "イニャリトゥ監督作", emoji: "🎭", titles: ["アモーレス・ペロス", "21グラム", "バベル", "BIUTIFUL ビューティフル", "バードマン あるいは", "レヴェナント:蘇えりし者", "バルド、偽りの記録と一握りの真実"] },
    { id: "dannyboyle", label: "ダニー・ボイル監督作", emoji: "☀️", titles: ["トレインスポッティング", "28日後...", "サンシャイン 2057", "スラムドッグ$ミリオネア", "127時間", "スティーブ・ジョブズ", "T2 トレインスポッティング", "イエスタデイ"] },
    { id: "guyritchie", label: "ガイ・リッチー監督作", emoji: "🎩", titles: ["ロック、ストック&トゥー・スモーキング・バレルズ", "スナッチ", "シャーロック・ホームズ", "シャーロック・ホームズ シャドウ ゲーム", "コードネーム U.N.C.L.E.", "キング・アーサー", "ジェントルメン", "カンフー・ジャングル"] },
    { id: "edgarwright", label: "エドガー・ライト監督作", emoji: "🍦", titles: ["ショーン・オブ・ザ・デッド", "ホット・ファズ", "スコット・ピルグリム VS. 邪悪な元カレ軍団", "ワールズ・エンド 酔っぱらいが世界を救う!", "ベイビー・ドライバー", "ラストナイト・イン・ソーホー"] },
    { id: "sammendes", label: "サム・メンデス監督作", emoji: "🌹", titles: ["アメリカン・ビューティー", "ロード・トゥ・パーディション", "ジャーヘッド", "レボリューショナリー・ロード", "007 スカイフォール", "007 スペクター", "1917 命をかけた伝令", "エンパイア・オブ・ライト"] },
    { id: "shyamalan", label: "M・ナイト・シャマラン監督作", emoji: "🔮", titles: ["シックス・センス", "アンブレイカブル", "サイン", "ヴィレッジ", "レディ・イン・ザ・ウォーター", "ハプニング", "スプリット", "ミスター・ガラス", "オールド", "ノック 終末の訪問者"] },
    { id: "jordanpeele", label: "ジョーダン・ピール監督作", emoji: "✂️", titles: ["ゲット・アウト", "アス", "NOPE/ノープ"] },
    { id: "gerwig", label: "グレタ・ガーウィグ監督作", emoji: "🎀", titles: ["レディ・バード", "ストーリー・オブ・マイライフ わたしの若草物語", "バービー"] },
    { id: "sofiacoppola", label: "ソフィア・コッポラ監督作", emoji: "🎐", titles: ["ヴァージン・スーサイズ", "ロスト・イン・トランスレーション", "マリー・アントワネット", "SOMEWHERE", "ブリングリング", "The Beguiled ビガイルド", "プリシラ"] },
    { id: "fordcoppola", label: "フランシス・フォード・コッポラ監督作", emoji: "🍷", titles: ["ゴッドファーザー", "カンバセーション...盗聴...", "ゴッドファーザー PART II", "地獄の黙示録", "アウトサイダー", "ドラキュラ", "ゴッドファーザー PART III", "Megalopolis"] },
    { id: "kubrick", label: "スタンリー・キューブリック監督作", emoji: "🌀", titles: ["現金に体を張れ", "スパルタカス", "ロリータ", "博士の異常な愛情", "2001年宇宙の旅", "時計じかけのオレンジ", "バリー・リンドン", "シャイニング", "フルメタル・ジャケット", "アイズ ワイド シャット"] },
    { id: "hitchcock", label: "ヒッチコック監督作", emoji: "🐦", titles: ["レベッカ", "裏窓", "めまい", "北北西に進路を取れ", "サイコ", "鳥", "ダイヤルMを廻せ!", "見知らぬ乗客", "ロープ"] },
    { id: "soderbergh", label: "スティーブン・ソダーバーグ監督作", emoji: "🎲", titles: ["セックスと嘘とビデオテープ", "アウト・オブ・サイト", "エリン・ブロコビッチ", "トラフィック", "オーシャンズ11", "チェ 28歳の革命", "コンテイジョン", "マジック・マイク", "サイド・エフェクト"] },
    { id: "ronhoward", label: "ロン・ハワード監督作", emoji: "🚀", titles: ["コクーン", "バックドラフト", "アポロ13", "ビューティフル・マインド", "シンデレラマン", "ダ・ヴィンチ・コード", "天使と悪魔", "ラッシュ/プライドと友情", "インフェルノ", "ハン・ソロ/スター・ウォーズ・ストーリー"] },
    { id: "besson", label: "リュック・ベッソン監督作", emoji: "🐬", titles: ["グラン・ブルー", "ニキータ", "レオン", "フィフス・エレメント", "ジャンヌ・ダルク", "アデル/ファラオと復活の秘薬", "LUCY/ルーシー", "ヴァレリアン 千の惑星の救世主"] },
    { id: "jeunet", label: "ジャン=ピエール・ジュネ監督作", emoji: "💚", titles: ["デリカテッセン", "ロスト・チルドレン", "エイリアン4", "アメリ", "ロング・エンゲージメント", "ミックマック", "T.S.スピヴェット"] },
    { id: "almodovar", label: "ペドロ・アルモドバル監督作", emoji: "🌹", titles: ["神経衰弱ぎりぎりの女たち", "オール・アバウト・マイ・マザー", "トーク・トゥ・ハー", "ボルベール<帰郷>", "私が、生きる肌", "ジュリエッタ", "ペイン・アンド・グローリー", "パラレル・マザーズ"] },
    { id: "wongkarwai", label: "ウォン・カーウァイ監督作", emoji: "🚬", titles: ["いますぐ抱きしめたい", "欲望の翼", "恋する惑星", "天使の涙", "ブエノスアイレス", "花様年華", "2046", "マイ・ブルーベリー・ナイツ", "グランド・マスター"] },
    { id: "bongjoonho", label: "ポン・ジュノ監督作", emoji: "🐷", titles: ["ほえる犬は噛まない", "殺人の追憶", "グエムル-漢江の怪物-", "母なる証明", "スノーピアサー", "オクジャ/okja", "パラサイト 半地下の家族", "ミッキー17"] },
    { id: "parkchanwook", label: "パク・チャヌク監督作", emoji: "🗡️", titles: ["JSA", "復讐者に憐れみを", "オールド・ボーイ", "親切なクムジャさん", "渇き", "イノセント・ガーデン", "お嬢さん", "別れる決心"] },
    { id: "leechangdong", label: "イ・チャンドン監督作", emoji: "🕯️", titles: ["ペパーミント・キャンディー", "オアシス", "シークレット・サンシャイン", "ポエトリー アグネスの詩", "バーニング 劇場版"] },
    { id: "carpenter", label: "ジョン・カーペンター監督作", emoji: "🌫️", titles: ["ダーク・スター", "ハロウィン", "ニューヨーク1997", "遊星からの物体X", "クリスティーン", "スターマン/愛・宇宙はるかに", "ゼイリブ", "マウス・オブ・マッドネス"] },
    { id: "lynch", label: "デヴィッド・リンチ監督作", emoji: "🎭", titles: ["イレイザーヘッド", "エレファント・マン", "ブルーベルベット", "ワイルド・アット・ハート", "ロスト・ハイウェイ", "ストレイト・ストーリー", "マルホランド・ドライブ", "インランド・エンパイア"] },
    { id: "malick", label: "テレンス・マリック監督作", emoji: "🌾", titles: ["地獄の逃避行", "天国の日々", "シン・レッド・ライン", "ニュー・ワールド", "ツリー・オブ・ライフ", "トゥ・ザ・ワンダー", "聖杯たちの騎士", "名もなき生涯"] },
    { id: "woodyallen", label: "ウディ・アレン監督作", emoji: "🎷", titles: ["アニー・ホール", "マンハッタン", "ハンナとその姉妹", "ミッドナイト・イン・パリ", "ブルージャスミン", "カフェ・ソサエティ", "教授のおかしな妄想殺人", "レイニーデイ・イン・ニューヨーク"] },
    { id: "spikelee", label: "スパイク・リー監督作", emoji: "✊", titles: ["ドゥ・ザ・ライト・シング", "マルコムX", "25時", "インサイド・マン", "ブラック・クランズマン", "ザ・ファイブ・ブラッズ"] },
    { id: "waititi", label: "タイカ・ワイティティ監督作", emoji: "🦋", titles: ["ボーイ", "ワイルドピープル!", "ヴァンパイア・シェアハウス", "マイティ・ソー バトルロイヤル", "ジョジョ・ラビット", "ソー:ラブ&サンダー", "ネクスト・ゴール・ウィンズ"] },
    { id: "jamesgunn", label: "ジェームズ・ガン監督作", emoji: "🦝", titles: ["スーパー!", "ガーディアンズ・オブ・ギャラクシー", "ガーディアンズ・オブ・ギャラクシー:リミックス", "ザ・スーサイド・スクワッド", "ガーディアンズ・オブ・ギャラクシー:VOLUME 3", "スーパーマン"] },
    { id: "zacksnyder", label: "ザック・スナイダー監督作", emoji: "🦉", titles: ["ドーン・オブ・ザ・デッド", "300", "ウォッチメン", "エンジェル ウォーズ", "マン・オブ・スティール", "バットマン vs スーパーマン", "ジャスティス・リーグ", "アーミー・オブ・ザ・デッド", "レベル・ムーン"] },
    { id: "michaelbay", label: "マイケル・ベイ監督作", emoji: "💣", titles: ["バッドボーイズ", "ザ・ロック", "アルマゲドン", "パール・ハーバー", "アイランド", "トランスフォーマー", "ペイン&ゲイン", "13時間 ベンガジの秘密の兵士", "アンビュランス"] },
    { id: "eggers", label: "ロバート・エガース監督作", emoji: "🕯️", titles: ["ウィッチ", "ライトハウス", "ノースマン 導かれし復讐者", "ノスフェラトゥ"] },
    { id: "ariaster", label: "アリ・アスター監督作", emoji: "🌼", titles: ["ヘレディタリー/継承", "ミッドサマー", "ボーはおそれている"] },

    // ---- 監督（日本） ----
    { id: "kitano", label: "北野武 監督作", emoji: "🎨", titles: ["その男、凶暴につき", "ソナチネ", "キッズ・リターン", "HANA-BI", "菊次郎の夏", "座頭市", "アウトレイジ", "アウトレイジ ビヨンド", "首"] },
    { id: "iwai", label: "岩井俊二 監督作", emoji: "🌸", titles: ["Love Letter", "スワロウテイル", "四月物語", "リリイ・シュシュのすべて", "花とアリス", "ヴァンパイア", "リップヴァンウィンクルの花嫁", "ラストレター"] },
    { id: "kon", label: "今敏 監督作", emoji: "🎡", titles: ["PERFECT BLUE", "千年女優", "東京ゴッドファーザーズ", "パプリカ"] },
    { id: "oshii", label: "押井守 監督作", emoji: "🐕", titles: ["うる星やつら2 ビューティフル・ドリーマー", "機動警察パトレイバー the Movie", "GHOST IN THE SHELL/攻殻機動隊", "イノセンス", "スカイ・クロラ"] },
    { id: "yamada", label: "山田洋次 監督作", emoji: "🍵", titles: ["幸福の黄色いハンカチ", "たそがれ清兵衛", "隠し剣 鬼の爪", "武士の一分", "母べえ", "東京家族", "小さいおうち", "家族はつらいよ"] },
    { id: "hamaguchi", label: "濱口竜介 監督作", emoji: "🚗", titles: ["ハッピーアワー", "寝ても覚めても", "偶然と想像", "ドライブ・マイ・カー", "悪は存在しない"] },
    { id: "nakashima", label: "中島哲也 監督作", emoji: "🍬", titles: ["下妻物語", "嫌われ松子の一生", "パコと魔法の絵本", "告白", "渇き。", "来る"] },
    { id: "yuasa", label: "湯浅政明 監督作", emoji: "🌊", titles: ["マインド・ゲーム", "夜は短し歩けよ乙女", "夜明け告げるルーのうた", "きみと、波にのれたら", "犬王"] },
    { id: "katabuchi", label: "片渕須直 監督作", emoji: "🎏", titles: ["アリーテ姫", "マイマイ新子と千年の魔法", "この世界の片隅に", "この世界の(さらにいくつもの)片隅に"] },
    { id: "otomo", label: "大友克洋 監督作", emoji: "🏍️", titles: ["AKIRA", "MEMORIES", "スチームボーイ"] },

    // ---- シリーズ（海外） ----
    { id: "independenceday", label: "インデペンデンス・デイ", emoji: "🛸", titles: ["インデペンデンス・デイ", "インデペンデンス・デイ:リサージェンス"] },
    { id: "transporter", label: "トランスポーター", emoji: "🚗", titles: ["トランスポーター", "トランスポーター2", "トランスポーター3", "トランスポーター イグニション"] },
    { id: "lethalweapon", label: "リーサル・ウェポン", emoji: "🔫", titles: ["リーサル・ウェポン", "リーサル・ウェポン2", "リーサル・ウェポン3", "リーサル・ウェポン4"] },
    { id: "rushhour", label: "ラッシュアワー", emoji: "👮", titles: ["ラッシュアワー", "ラッシュアワー2", "ラッシュアワー3"] },
    { id: "nightmuseum", label: "ナイト ミュージアム", emoji: "🏛️", titles: ["ナイト ミュージアム", "ナイト ミュージアム2", "ナイト ミュージアム/エジプト王の秘密"] },
    { id: "paddington", label: "パディントン", emoji: "🧸", titles: ["パディントン", "パディントン2", "パディントン 消えた黄金郷の秘密"] },
    { id: "tmnt", label: "ミュータント・タートルズ", emoji: "🐢", titles: ["ミュータント・タートルズ", "ミュータント・タートルズ:影<シャドウズ>", "ミュータント・タートルズ:ミュータント・パニック!"] },
    { id: "gijoe", label: "G.I.ジョー", emoji: "🎖️", titles: ["G.I.ジョー", "G.I.ジョー バック2リベンジ", "スネーク・アイズ:G.I.ジョー・オリジンズ"] },
    { id: "purge", label: "パージ", emoji: "🎭", titles: ["パージ", "パージ:アナーキー", "パージ:大統領令", "ザ・ファースト・パージ", "フォーエヴァー・パージ"] },
    { id: "quietplace", label: "クワイエット・プレイス", emoji: "🤫", titles: ["クワイエット・プレイス", "クワイエット・プレイス 破られた沈黙", "クワイエット・プレイス:DAY 1"] },
    { id: "it", label: "IT / イット", emoji: "🎈", titles: ["IT/イット “それ”が見えたら、終わり。", "IT/イット THE END “それ”が見えたら、終わり。"] },
    { id: "halloween", label: "ハロウィン", emoji: "🎃", titles: ["ハロウィン", "ブギーマン", "ハロウィン", "ハロウィン KILLS", "ハロウィン THE END"] },
    { id: "friday13", label: "13日の金曜日", emoji: "🔪", titles: ["13日の金曜日", "13日の金曜日 PART2", "13日の金曜日 PART3", "ジェイソンX 13日の金曜日", "フレディVSジェイソン"] },
    { id: "elmstreet", label: "エルム街の悪夢", emoji: "😴", titles: ["エルム街の悪夢", "エルム街の悪夢2 フレディの復讐", "エルム街の悪夢3 惨劇の館", "フレディVSジェイソン"] },
    { id: "childsplay", label: "チャイルド・プレイ", emoji: "🧸", titles: ["チャイルド・プレイ", "チャイルド・プレイ2", "チャイルド・プレイ3", "チャイルド・プレイ/チャッキーの花嫁", "カルト・オブ・チャッキー"] },
    { id: "scream", label: "スクリーム", emoji: "😱", titles: ["スクリーム", "スクリーム2", "スクリーム3", "スクリーム4:ネクスト・ジェネレーション", "スクリーム", "スクリームVI"] },
    { id: "finaldestination", label: "ファイナル・デスティネーション", emoji: "💀", titles: ["ファイナル・デスティネーション", "デッドコースター", "ファイナル・デッドコースター", "ファイナル・デッドサーキット", "ファイナル・デッドブリッジ", "ファイナル・デスティネーション ブラッドライン"] },
    { id: "residentevil", label: "バイオハザード（実写）", emoji: "🧟", titles: ["バイオハザード", "バイオハザードII アポカリプス", "バイオハザードIII", "バイオハザードIV アフターライフ", "バイオハザードV リトリビューション", "バイオハザード:ザ・ファイナル"] },
    { id: "underworld", label: "アンダーワールド", emoji: "🐺", titles: ["アンダーワールド", "アンダーワールド:エボリューション", "アンダーワールド:ビギンズ", "アンダーワールド 覚醒", "アンダーワールド ブラッド・ウォーズ"] },
    { id: "blade", label: "ブレイド", emoji: "🗡️", titles: ["ブレイド", "ブレイド2", "ブレイド3"] },
    { id: "narnia", label: "ナルニア国物語", emoji: "🦁", titles: ["ナルニア国物語/第1章:ライオンと魔女", "ナルニア国物語/第2章:カスピアン王子の角笛", "ナルニア国物語/第3章:アスラン王と魔法の島"] },
    { id: "percyjackson", label: "パーシー・ジャクソン", emoji: "🔱", titles: ["パーシー・ジャクソンとオリンポスの神々", "パーシー・ジャクソンとオリンポスの神々:魔の海"] },
    { id: "mazerunner", label: "メイズ・ランナー", emoji: "🌽", titles: ["メイズ・ランナー", "メイズ・ランナー2:砂漠の迷宮", "メイズ・ランナー:最期の迷宮"] },
    { id: "divergent", label: "ダイバージェント", emoji: "🧩", titles: ["ダイバージェント", "ダイバージェントNEO", "ダイバージェントFINAL"] },
    { id: "madmax", label: "マッドマックス", emoji: "🛢️", titles: ["マッドマックス", "マッドマックス2", "マッドマックス/サンダードーム", "マッドマックス 怒りのデス・ロード", "マッドマックス:フュリオサ"] },
    { id: "kickass", label: "キック・アス", emoji: "🥷", titles: ["キック・アス", "キック・アス ジャスティス・フォーエバー"] },
    { id: "hangover", label: "ハングオーバー", emoji: "🍻", titles: ["ハングオーバー! 消えた花ムコと史上最悪の二日酔い", "ハングオーバー!! 史上最悪の二日酔い、国境を越える", "ハングオーバー!!! 最後の反省会"] },
    { id: "nationaltreasure", label: "ナショナル・トレジャー", emoji: "🗝️", titles: ["ナショナル・トレジャー", "ナショナル・トレジャー/リンカーン暗殺者の日記"] },
    { id: "sherlock", label: "シャーロック・ホームズ（RDJ）", emoji: "🔍", titles: ["シャーロック・ホームズ", "シャーロック・ホームズ シャドウ ゲーム"] },
    { id: "topgun", label: "トップガン", emoji: "✈️", titles: ["トップガン", "トップガン マーヴェリック"] },
    { id: "rambo", label: "ランボー", emoji: "🏹", titles: ["ランボー", "ランボー/怒りの脱出", "ランボー3/怒りのアフガン", "ランボー/最後の戦場", "ランボー ラスト・ブラッド"] },
    { id: "expendables", label: "エクスペンダブルズ", emoji: "💪", titles: ["エクスペンダブルズ", "エクスペンダブルズ2", "エクスペンダブルズ3 ワールドミッション", "エクスペンダブルズ ニューブラッド"] },
    { id: "karatekid", label: "ベスト・キッド / カラテキッド", emoji: "🥋", titles: ["ベスト・キッド", "ベスト・キッド2", "ベスト・キッド3 最後の挑戦", "ベスト・キッド4", "ベスト・キッド", "カラテキッド レジェンド"] },

    // ---- DC / マーベル系 ----
    { id: "dceu", label: "DCEU（ジャスティス・リーグ系）", emoji: "🦇", titles: ["マン・オブ・スティール", "バットマン vs スーパーマン ジャスティスの誕生", "スーサイド・スクワッド", "ワンダーウーマン", "ジャスティス・リーグ", "アクアマン", "シャザム!", "バーズ・オブ・プレイ", "ワンダーウーマン 1984", "ザ・フラッシュ"] },
    { id: "joker", label: "ジョーカー", emoji: "🃏", titles: ["ジョーカー", "ジョーカー:フォリ・ア・ドゥ"] },
    { id: "thebatman", label: "THE BATMAN", emoji: "🦇", titles: ["THE BATMAN-ザ・バットマン-"] },
    { id: "wonderwoman", label: "ワンダーウーマン", emoji: "⚡", titles: ["ワンダーウーマン", "ワンダーウーマン 1984"] },
    { id: "aquaman", label: "アクアマン", emoji: "🔱", titles: ["アクアマン", "アクアマン/失われた王国"] },
    { id: "gotg", label: "ガーディアンズ・オブ・ギャラクシー", emoji: "🌠", titles: ["ガーディアンズ・オブ・ギャラクシー", "ガーディアンズ・オブ・ギャラクシー:リミックス", "ガーディアンズ・オブ・ギャラクシー:VOLUME 3"] },
    { id: "antman", label: "アントマン", emoji: "🐜", titles: ["アントマン", "アントマン&ワスプ", "アントマン&ワスプ:クアントマニア"] },
    { id: "captainamerica", label: "キャプテン・アメリカ", emoji: "🛡️", titles: ["キャプテン・アメリカ/ザ・ファースト・アベンジャー", "キャプテン・アメリカ/ウィンター・ソルジャー", "シビル・ウォー/キャプテン・アメリカ", "キャプテン・アメリカ:ブレイブ・ニュー・ワールド"] },
    { id: "thor", label: "マイティ・ソー", emoji: "🔨", titles: ["マイティ・ソー", "マイティ・ソー/ダーク・ワールド", "マイティ・ソー バトルロイヤル", "ソー:ラブ&サンダー"] },
    { id: "doctorstrange", label: "ドクター・ストレンジ", emoji: "🌀", titles: ["ドクター・ストレンジ", "ドクター・ストレンジ/マルチバース・オブ・マッドネス"] },
    { id: "venom", label: "ヴェノム", emoji: "🕸️", titles: ["ヴェノム", "ヴェノム:レット・ゼア・ビー・カーネイジ", "ヴェノム:ザ・ラストダンス"] },

    // ---- 日本のシリーズ ----
    { id: "doraemon", label: "映画 ドラえもん", emoji: "🔔", titles: ["映画ドラえもん のび太の恐竜", "映画ドラえもん のび太の宇宙開拓史", "映画ドラえもん のび太の魔界大冒険", "STAND BY ME ドラえもん", "映画ドラえもん のび太の月面探査記", "映画ドラえもん のび太の新恐竜", "映画ドラえもん のび太の空の理想郷"] },
    { id: "shinchan", label: "映画 クレヨンしんちゃん", emoji: "🖍️", titles: ["クレヨンしんちゃん 嵐を呼ぶモーレツ!オトナ帝国の逆襲", "クレヨンしんちゃん 嵐を呼ぶ アッパレ!戦国大合戦", "クレヨンしんちゃん オラの引越し物語", "映画クレヨンしんちゃん バカうまっ!B級グルメサバイバル!!", "映画クレヨンしんちゃん 襲来!!宇宙人シリリ"] },
    { id: "pokemon", label: "劇場版 ポケットモンスター", emoji: "⚡", titles: ["ミュウツーの逆襲", "幻のポケモン ルギア爆誕", "結晶塔の帝王 ENTEI", "水の都の護神 ラティアスとラティオス", "ミュウと波導の勇者 ルカリオ", "ミュウツーの逆襲 EVOLUTION", "ココ"] },
    { id: "onepiece", label: "劇場版 ONE PIECE", emoji: "🏴‍☠️", titles: ["ワンピース", "ONE PIECE THE MOVIE デッドエンドの冒険", "ONE PIECE FILM STRONG WORLD", "ONE PIECE FILM Z", "ONE PIECE FILM GOLD", "ONE PIECE STAMPEDE", "ONE PIECE FILM RED"] },
    { id: "dragonball", label: "劇場版 ドラゴンボール", emoji: "🐉", titles: ["ドラゴンボールZ 神と神", "ドラゴンボールZ 復活の「F」", "ドラゴンボール超 ブロリー", "ドラゴンボール超 スーパーヒーロー"] },
    { id: "kimetsu", label: "劇場版 鬼滅の刃", emoji: "⚔️", titles: ["劇場版「鬼滅の刃」無限列車編", "劇場版「鬼滅の刃」無限城編 第一章"] },
    { id: "jujutsu", label: "劇場版 呪術廻戦", emoji: "👊", titles: ["劇場版 呪術廻戦 0"] },
    { id: "rurouni", label: "るろうに剣心（実写）", emoji: "⚔️", titles: ["るろうに剣心", "るろうに剣心 京都大火編", "るろうに剣心 伝説の最期編", "るろうに剣心 最終章 The Final", "るろうに剣心 最終章 The Beginning"] },
    { id: "kingdom", label: "キングダム（実写）", emoji: "🗡️", titles: ["キングダム", "キングダム2 遥かなる大地へ", "キングダム 運命の炎", "キングダム 大将軍の帰還"] },
    { id: "gintama", label: "銀魂（実写）", emoji: "🍭", titles: ["銀魂", "銀魂2 掟は破るためにこそある"] },
    { id: "20thcenturyboys", label: "20世紀少年", emoji: "🎸", titles: ["20世紀少年", "20世紀少年 第2章 最後の希望", "20世紀少年 最終章 ぼくらの旗"] },
    { id: "deathnote", label: "デスノート（実写）", emoji: "📓", titles: ["デスノート", "デスノート the Last name", "L change the WorLd", "デスノート Light up the NEW world"] },
    { id: "odoru", label: "踊る大捜査線", emoji: "🚔", titles: ["踊る大捜査線 THE MOVIE", "踊る大捜査線 THE MOVIE2 レインボーブリッジを封鎖せよ!", "踊る大捜査線 THE MOVIE3 ヤツらを解放せよ!", "踊る大捜査線 THE FINAL 新たなる希望"] },
    { id: "gamera", label: "ガメラ（平成三部作）", emoji: "🐢", titles: ["ガメラ 大怪獣空中決戦", "ガメラ2 レギオン襲来", "ガメラ3 邪神<イリス>覚醒"] },
    { id: "godzilla_showa", label: "ゴジラ（昭和・平成）", emoji: "🦖", titles: ["ゴジラ", "モスラ対ゴジラ", "三大怪獣 地球最大の決戦", "ゴジラvsビオランテ", "ゴジラvsキングギドラ", "ゴジラvsモスラ", "ゴジラvsメカゴジラ", "ゴジラvsデストロイア", "ゴジラ×メカゴジラ"] },
    { id: "tokyorevengers", label: "東京リベンジャーズ（実写）", emoji: "🏍️", titles: ["東京リベンジャーズ", "東京リベンジャーズ2 血のハロウィン編 -運命-", "東京リベンジャーズ2 血のハロウィン編 -決戦-"] },
    { id: "tondesaitama", label: "翔んで埼玉", emoji: "🗾", titles: ["翔んで埼玉", "翔んで埼玉 ~琵琶湖より愛をこめて~"] },

    // ---- アニメ・スタジオ ----
    { id: "madhouse", label: "マッドハウス作品", emoji: "🎞️", titles: ["時をかける少女", "サマーウォーズ", "REDLINE", "ペルソナ3", "劇場版 ソードアート・オンライン", "オオカミこどもの雨と雪"] },
    { id: "mappa", label: "MAPPA作品", emoji: "🔥", titles: ["この世界の片隅に", "劇場版 呪術廻戦 0", "ユーリ!!! on ICE", "劇場版 鬼滅の刃 無限列車編"] },
    { id: "gundam", label: "機動戦士ガンダム 劇場版", emoji: "🤖", titles: ["機動戦士ガンダム", "機動戦士ガンダムIII めぐりあい宇宙編", "機動戦士ガンダム 逆襲のシャア", "機動戦士ガンダムF91", "機動戦士ガンダム 閃光のハサウェイ"] },
    { id: "spiderverse", label: "スパイダーバース", emoji: "🕸️", titles: ["スパイダーマン:スパイダーバース", "スパイダーマン:アクロス・ザ・スパイダーバース"] },
    { id: "iceage", label: "アイス・エイジ", emoji: "🦣", titles: ["アイス・エイジ", "アイス・エイジ2", "アイス・エイジ3 ティラノのおとしもの", "アイス・エイジ4 パイレーツ大冒険", "アイス・エイジ5 止まらない大地変動"] },
    { id: "sing", label: "SING/シング", emoji: "🎤", titles: ["SING/シング", "SING/シング:ネクストステージ"] },
    { id: "legomovie", label: "レゴ ムービー", emoji: "🧱", titles: ["LEGO ムービー", "レゴバットマン ザ・ムービー", "レゴ ニンジャゴー ザ・ムービー", "レゴ ムービー2"] },

    // ---- 俳優の代表作 ----
    { id: "tomhanks", label: "トム・ハンクス 代表作", emoji: "🎩", titles: ["ビッグ", "フィラデルフィア", "フォレスト・ガンプ/一期一会", "アポロ13", "プライベート・ライアン", "グリーンマイル", "キャスト・アウェイ", "ターミナル", "キャプテン・フィリップス", "ハドソン川の奇跡"] },
    { id: "dicaprio", label: "ディカプリオ 代表作", emoji: "🌟", titles: ["ギルバート・グレイプ", "タイタニック", "ギャング・オブ・ニューヨーク", "アビエイター", "ディパーテッド", "ブラッド・ダイヤモンド", "シャッター アイランド", "インセプション", "ウルフ・オブ・ウォールストリート", "レヴェナント:蘇えりし者"] },
    { id: "bradpitt", label: "ブラッド・ピット 代表作", emoji: "😎", titles: ["セブン", "ファイト・クラブ", "オーシャンズ11", "Mr.&Mrs. スミス", "ベンジャミン・バトン 数奇な人生", "イングロリアス・バスターズ", "マネーボール", "ワールド・ウォーZ", "ワンス・アポン・ア・タイム・イン・ハリウッド"] },
    { id: "tomcruise", label: "トム・クルーズ 代表作", emoji: "🕶️", titles: ["トップガン", "レインマン", "ア・フュー・グッドメン", "ザ・エージェント", "マグノリア", "ラスト サムライ", "宇宙戦争", "オブリビオン", "エッジ・オブ・トゥモロー", "トップガン マーヴェリック"] },
    { id: "denzel", label: "デンゼル・ワシントン 代表作", emoji: "🎯", titles: ["グローリー", "マルコムX", "ザ・ハリケーン", "トレーニング デイ", "マイ・ボディガード", "アメリカン・ギャングスター", "フライト", "イコライザー", "フェンス"] },
    { id: "deniro", label: "ロバート・デ・ニーロ 代表作", emoji: "🎬", titles: ["タクシードライバー", "ディア・ハンター", "レイジング・ブル", "ミッドナイト・ラン", "グッドフェローズ", "ケープ・フィアー", "カジノ", "ヒート", "レナードの朝", "アイリッシュマン"] },
    { id: "pacino", label: "アル・パチーノ 代表作", emoji: "🎭", titles: ["ゴッドファーザー", "セルピコ", "狼たちの午後", "スカーフェイス", "セント・オブ・ウーマン/夢の香り", "ヒート", "セルピコ", "インサイダー", "アイリッシュマン"] },
    { id: "streep", label: "メリル・ストリープ 代表作", emoji: "👑", titles: ["ディア・ハンター", "クレイマー、クレイマー", "ソフィーの選択", "マディソン郡の橋", "プラダを着た悪魔", "マンマ・ミーア!", "ジュリー&ジュリア", "マーガレット・サッチャー 鉄の女の涙"] },
    { id: "keanu", label: "キアヌ・リーブス 代表作", emoji: "🐶", titles: ["ビルとテッドの大冒険", "スピード", "マトリックス", "コンスタンティン", "地球が静止する日", "ジョン・ウィック", "ジョン・ウィック:チャプター2"] },
    { id: "willsmith", label: "ウィル・スミス 代表作", emoji: "🌟", titles: ["インデペンデンス・デイ", "メン・イン・ブラック", "エネミー・オブ・アメリカ", "アイ,ロボット", "幸せのちから", "ハンコック", "アラジン", "ドリームプラン"] },
    { id: "therock", label: "ドウェイン・ジョンソン 代表作", emoji: "💪", titles: ["ハムナプトラ2 黄金のピラミッド", "ワイルド・スピード MEGA MAX", "G.I.ジョー バック2リベンジ", "サン・アンドレアス", "モアナと伝説の海", "ジュマンジ/ウェルカム・トゥ・ジャングル", "ジュマンジ/ネクスト・レベル", "ブラックアダム"] },
    { id: "yakusho", label: "役所広司 出演作", emoji: "🎌", titles: ["Shall we ダンス?", "うなぎ", "失楽園", "たそがれ清兵衛", "バベル", "13人の刺客", "渇き。", "三度目の殺人", "スパイの妻", "PERFECT DAYS"] },
    { id: "suda", label: "菅田将暉 出演作", emoji: "🎤", titles: ["共喰い", "そこのみにて光輝く", "海月姫", "何者", "帝一の國", "あゝ、荒野", "民王", "銀魂", "アルキメデスの大戦", "キャラクター"] },
    { id: "ayase", label: "綾瀬はるか 出演作", emoji: "🌷", titles: ["ICHI", "おっぱいバレー", "ホタルノヒカリ", "プリンシパル 恋する私はヒロインですか?", "海街diary", "海賊とよばれた男", "本能寺ホテル", "今夜、ロマンス劇場で", "奥様は、取り扱い注意"] },

    // ---- テーマ ----
    { id: "zombie", label: "ゾンビ映画", emoji: "🧟", titles: ["ゾンビ", "バタリアン", "28日後...", "ショーン・オブ・ザ・デッド", "ドーン・オブ・ザ・デッド", "ゾンビランド", "ワールド・ウォーZ", "新感染 ファイナル・エクスプレス", "カメラを止めるな!"] },
    { id: "vampire", label: "ヴァンパイア映画", emoji: "🧛", titles: ["ドラキュラ", "インタビュー・ウィズ・ヴァンパイア", "ブレイド", "アンダーワールド", "モールス", "トワイライト～初恋～", "オンリー・ラヴァーズ・レフト・アライヴ", "ヴァンパイア・シェアハウス"] },
    { id: "disaster", label: "パニック・災害映画", emoji: "🌊", titles: ["タワーリング・インフェルノ", "ポセイドン・アドベンチャー", "アルマゲドン", "ディープ・インパクト", "ツイスター", "デイ・アフター・トゥモロー", "2012", "サン・アンドレアス", "ジオストーム"] },
    { id: "heist", label: "強盗・ケイパー映画", emoji: "💰", titles: ["ヒート", "スティング", "オーシャンズ11", "イタリアン・ジョブ", "インサイド・マン", "ベイビー・ドライバー", "ザ・タウン", "ナイスガイズ!"] },
    { id: "timeloop", label: "タイムループ・時間もの", emoji: "⏳", titles: ["恋はデジャ・ブ", "バタフライ・エフェクト", "ソース・コード", "エッジ・オブ・トゥモロー", "アバウト・タイム~愛おしい時間について~", "ハッピー・デス・デイ", "TENET テネット", "パーム・スプリングス"] },
    { id: "truestory", label: "実話ベースの名作", emoji: "📰", titles: ["シンドラーのリスト", "ビューティフル・マインド", "アポロ13", "ソーシャル・ネットワーク", "アルゴ", "スポットライト 世紀のスクープ", "ハクソー・リッジ", "グリーンブック", "フォードvsフェラーリ", "ドリーム"] },
    { id: "courtroom", label: "法廷・裁判ドラマ", emoji: "⚖️", titles: ["十二人の怒れる男", "評決", "ア・フュー・グッドメン", "フィラデルフィア", "ザ・ランドリー", "アイヒマンを追え", "リチャード・ジュエル", "シカゴ7裁判", "最後の決闘裁判"] },
    { id: "xmas", label: "クリスマス映画", emoji: "🎄", titles: ["素晴らしき哉、人生!", "ホーム・アローン", "34丁目の奇跡", "グリンチ", "ラブ・アクチュアリー", "ポーラー・エクスプレス", "ナイトメアー・ビフォア・クリスマス", "エルフ ~サンタの国からやってきた~"] },
    { id: "a24", label: "A24作品", emoji: "🅰️", titles: ["ムーンライト", "ヘレディタリー/継承", "レディ・バード", "ミッドサマー", "ウィッチ", "フロリダ・プロジェクト 真夏の魔法", "ミナリ", "エブリシング・エブリウェア・オール・アット・ワンス", "TALK TO ME/トーク・トゥ・ミー"] },
    { id: "blumhouse", label: "ブラムハウス（ホラー）", emoji: "🚪", titles: ["パラノーマル・アクティビティ", "インシディアス", "シニスター", "ザ・ギフト", "ゲット・アウト", "アス", "透明人間", "ブラック・フォン", "M3GAN/ミーガン"] },
    { id: "korean", label: "韓国映画 名作", emoji: "🇰🇷", titles: ["JSA", "オールド・ボーイ", "殺人の追憶", "母なる証明", "新感染 ファイナル・エクスプレス", "お嬢さん", "バーニング 劇場版", "パラサイト 半地下の家族", "ハント"] },
    { id: "french", label: "フランス映画 名作", emoji: "🇫🇷", titles: ["勝手にしやがれ", "太陽がいっぱい", "アメリ", "戦場のピアニスト", "コーラス", "最強のふたり", "アーティスト", "ティエリー・トグルドーの憂鬱", "TITANE/チタン"] },
    { id: "bollywood", label: "インド映画", emoji: "🇮🇳", titles: ["ムトゥ 踊るマハラジャ", "きっと、うまくいく", "PK", "バーフバリ 伝説誕生", "バーフバリ 王の凱旋", "ダンガル きっと、つよくなる", "パッドマン 5億人の女性を救った男", "RRR", "エンドロールのつづき"] },
    { id: "hongkong", label: "香港・中国映画", emoji: "🇭🇰", titles: ["少林サッカー", "インファナル・アフェア", "HERO", "LOVERS", "グランド・マスター", "レッドクリフ Part I", "イップ・マン 序章", "イップ・マン 葉問", "王朝の陰謀"] },
    { id: "disneyremake", label: "ディズニー実写リメイク", emoji: "🏰", titles: ["アリス・イン・ワンダーランド", "マレフィセント", "シンデレラ", "ジャングル・ブック", "美女と野獣", "アラジン", "ライオン・キング", "ムーラン", "リトル・マーメイド"] },
    { id: "monster", label: "モンスター・怪獣映画", emoji: "🐲", titles: ["キング・コング", "ジョーズ", "グレムリン", "トレマーズ", "クローバーフィールド/HAKAISHA", "パシフィック・リム", "GODZILLA ゴジラ", "コング:スカル・アイランド", "シン・ゴジラ"] },
    { id: "animation_jp", label: "日本アニメ映画 名作", emoji: "🎌", titles: ["AKIRA", "GHOST IN THE SHELL/攻殻機動隊", "パプリカ", "サマーウォーズ", "この世界の片隅に", "君の名は。", "聲の形", "打ち上げ花火、下から見るか？横から見るか？", "劇場版 鬼滅の刃 無限列車編"] },
    { id: "cyberpunk", label: "サイバーパンク / ディストピア", emoji: "🌃", titles: ["ブレードランナー", "AKIRA", "マトリックス", "GHOST IN THE SHELL/攻殻機動隊", "トータル・リコール", "マイノリティ・リポート", "エリジウム", "ブレードランナー 2049", "レディ・プレイヤー1"] },
    { id: "space", label: "宇宙・スペースSF", emoji: "🚀", titles: ["2001年宇宙の旅", "エイリアン", "コンタクト", "アポロ13", "ゼロ・グラビティ", "インターステラー", "オデッセイ", "アド・アストラ", "DUNE/デューン 砂の惑星"] },
    { id: "roadmovie", label: "ロードムービー", emoji: "🛣️", titles: ["イージー・ライダー", "レインマン", "テルマ&ルイーズ", "リトル・ミス・サンシャイン", "モーターサイクル・ダイアリーズ", "はじまりへの旅", "ノマドランド", "グリーンブック"] },
    { id: "tearjerker", label: "泣ける名作", emoji: "😢", titles: ["きみに読む物語", "グリーンマイル", "ライフ・イズ・ビューティフル", "手紙 (映画)", "世界の中心で、愛をさけぶ", "余命1ヶ月の花嫁", "おくりびと", "湯を沸かすほどの熱い愛", "そして、バトンは渡された"] },
  ];

  // ジャンル（コレクション・映画賞とは独立して常時表示する）
  // fmGenre は Filmarks のジャンルID。各ジャンルの作品は Filmarks から動的に取得する。
  const GENRES = [
    { id: "g_action", label: "アクション", emoji: "💥", fmGenre: 5 },
    { id: "g_drama", label: "ドラマ", emoji: "🎭", fmGenre: 8 },
    { id: "g_comedy", label: "コメディ", emoji: "😂", fmGenre: 20 },
    { id: "g_romance", label: "恋愛", emoji: "💕", fmGenre: 25 },
    { id: "g_suspense", label: "サスペンス", emoji: "🕵️", fmGenre: 2 },
    { id: "g_thriller", label: "スリラー", emoji: "🔪", fmGenre: 903 },
    { id: "g_horror", label: "ホラー", emoji: "👻", fmGenre: 17 },
    { id: "g_sf", label: "SF", emoji: "🛸", fmGenre: 42 },
    { id: "g_fantasy", label: "ファンタジー", emoji: "🧙", fmGenre: 56 },
    { id: "g_mystery", label: "ミステリー", emoji: "🔍", fmGenre: 894 },
    { id: "g_adventure", label: "アドベンチャー・冒険", emoji: "🧭", fmGenre: 39 },
    { id: "g_crime", label: "クライム", emoji: "🕶️", fmGenre: 896 },
    { id: "g_youth", label: "青春", emoji: "🌈", fmGenre: 36 },
    { id: "g_war", label: "戦争", emoji: "🎖️", fmGenre: 44 },
    { id: "g_animation", label: "アニメ", emoji: "🎨", fmGenre: 61 },
    { id: "g_musical", label: "ミュージカル", emoji: "🎵", fmGenre: 892 },
    { id: "g_music", label: "音楽", emoji: "🎶", fmGenre: 35 },
    { id: "g_sports", label: "スポーツ", emoji: "🏅", fmGenre: 895 },
    { id: "g_western", label: "西部劇", emoji: "🤠", fmGenre: 52 },
    { id: "g_documentary", label: "ドキュメンタリー", emoji: "🎥", fmGenre: 12 },
    { id: "g_family", label: "ファミリー", emoji: "👨‍👩‍👧", fmGenre: 57 },
    { id: "g_history", label: "歴史", emoji: "🏛️", fmGenre: 893 },
    { id: "g_period", label: "時代劇", emoji: "⚔️", fmGenre: 47 },
    { id: "g_biography", label: "伝記", emoji: "📖", fmGenre: 899 },
    { id: "g_panic", label: "パニック", emoji: "🌊", fmGenre: 891 },
    { id: "g_violence", label: "バイオレンス", emoji: "🔥", fmGenre: 898 },
    { id: "g_yakuza", label: "ヤクザ・任侠", emoji: "🀄", fmGenre: 277 },
    { id: "g_gang", label: "ギャング・マフィア", emoji: "💼", fmGenre: 902 },
  ];

  // 映画賞・映画祭（コレクションとは独立して常時表示する）
  const AWARDS = [
    { id: "oscar_best", label: "アカデミー賞 作品賞", emoji: "🏆", titles: [
      { title: "つばさ", year: "1927" }, { title: "暴力団", year: "1927" }, { title: "第七天国", year: "1927" },
      { title: "ブロードウェイ・メロディー", year: "1928" }, { title: "アリバイ", year: "1928" }, { title: "ハリウッド・レヴィユー", year: "1928" }, { title: "懐しのアリゾナ", year: "1928" }, { title: "The Patriot", year: "1928" },
      { title: "西部戦線異状なし", year: "1929" }, { title: "ビッグ・ハウス", year: "1929" }, { title: "Disraeli", year: "1929" }, { title: "結婚双紙", year: "1929" }, { title: "ラヴ・パレード", year: "1929" },
      { title: "シマロン", year: "1930" }, { title: "女性に捧ぐ", year: "1930" }, { title: "犯罪都市", year: "1930" }, { title: "スキピイ", year: "1930" }, { title: "トレイダ・ホーン", year: "1930" },
      { title: "グランド・ホテル", year: "1931" }, { title: "人類の戦士", year: "1931" }, { title: "バッド・ガール", year: "1931" }, { title: "チャンプ", year: "1931" }, { title: "特輯社会面", year: "1931" }, { title: "君とひととき", year: "1931" }, { title: "上海特急", year: "1931" }, { title: "陽気な中尉さん", year: "1931" },
      { title: "カヴァルケード", year: "1932" }, { title: "戦場よさらば", year: "1932" }, { title: "四十二番街", year: "1932" }, { title: "仮面の米国", year: "1932" }, { title: "一日だけの淑女", year: "1932" }, { title: "若草物語", year: "1932" }, { title: "ヘンリー八世の私生活", year: "1932" }, { title: "わたしは別よ", year: "1932" }, { title: "永遠に微笑む", year: "1932" }, { title: "あめりか祭", year: "1932" },
      { title: "或る夜の出来事", year: "1934" }, { title: "白い蘭", year: "1934" }, { title: "クレオパトラ", year: "1934" }, { title: "お姫様大行進", year: "1934" }, { title: "コンチネンタル", year: "1934" }, { title: "これがアメリカ艦隊", year: "1934" }, { title: "ロスチャイルド", year: "1934" }, { title: "模倣の人生", year: "1934" }, { title: "恋の一夜", year: "1934" }, { title: "影なき男", year: "1934" }, { title: "奇傑パンチョ", year: "1934" }, { title: "ホワイト・パレード", year: "1934" },
      { title: "戦艦バウンティ号の叛乱", year: "1935" }, { title: "乙女よ嘆くな", year: "1935" }, { title: "踊るブロードウェイ", year: "1935" }, { title: "海賊ブラッド", year: "1935" }, { title: "孤児ダビド物語", year: "1935" }, { title: "男の敵", year: "1935" }, { title: "ベンガルの槍騎兵", year: "1935" }, { title: "真夏の夜の夢", year: "1935" }, { title: "噫無情", year: "1935" }, { title: "浮かれ姫君", year: "1935" }, { title: "人生は四十二から", year: "1935" }, { title: "トップ・ハット", year: "1935" },
      { title: "巨星ジーグフェルド", year: "1936" }, { title: "風雲児アドヴァース", year: "1936" }, { title: "孔雀夫人", year: "1936" }, { title: "結婚クーデター", year: "1936" }, { title: "オペラハット", year: "1936" }, { title: "ロミオとジュリエット", year: "1936" }, { title: "桑港", year: "1936" }, { title: "科学者の道", year: "1936" }, { title: "嵐の三色旗", year: "1936" }, { title: "天使の花園", year: "1936" },
      { title: "ゾラの生涯", year: "1937" }, { title: "新婚道中記", year: "1937" }, { title: "我は海の子", year: "1937" }, { title: "デッドエンド", year: "1937" }, { title: "大地", year: "1937" }, { title: "シカゴ", year: "1937" }, { title: "失はれた地平線", year: "1937" }, { title: "オーケストラの少女", year: "1937" }, { title: "ステージ・ドア", year: "1937" }, { title: "スタア誕生", year: "1937" },
      { title: "我が家の楽園", year: "1938" }, { title: "ロビンフッドの冒険", year: "1938" }, { title: "世紀の楽団", year: "1938" }, { title: "少年の町", year: "1938" }, { title: "城砦", year: "1938" }, { title: "四人の姉妹", year: "1938" }, { title: "大いなる幻影", year: "1938" }, { title: "黒蘭の女", year: "1938" }, { title: "ピグマリオン", year: "1938" }, { title: "テスト・パイロット", year: "1938" },
      { title: "風と共に去りぬ", year: "1939" }, { title: "愛の勝利", year: "1939" }, { title: "チップス先生さようなら", year: "1939" }, { title: "邂逅", year: "1939" }, { title: "スミス都へ行く", year: "1939" }, { title: "ニノチカ", year: "1939" }, { title: "廿日鼠と人間", year: "1939" }, { title: "駅馬車", year: "1939" }, { title: "オズの魔法使", year: "1939" }, { title: "嵐が丘", year: "1939" },
      { title: "レベッカ", year: "1940" }, { title: "凡てこの世も天国も", year: "1940" }, { title: "海外特派員", year: "1940" }, { title: "怒りの葡萄", year: "1940" }, { title: "独裁者", year: "1940" }, { title: "恋愛手帖", year: "1940" }, { title: "月光の女", year: "1940" }, { title: "果てなき航路", year: "1940" }, { title: "我等の町", year: "1940" }, { title: "フィラデルフィア物語", year: "1940" },
      { title: "わが谷は緑なりき", year: "1941" }, { title: "塵に咲く花", year: "1941" }, { title: "市民ケーン", year: "1941" }, { title: "幽霊紐育を歩く", year: "1941" }, { title: "Hold Back the Dawn", year: "1941" }, { title: "偽りの花園", year: "1941" }, { title: "マルタの鷹", year: "1941" }, { title: "我が道は遠けれど", year: "1941" }, { title: "ヨーク軍曹", year: "1941" }, { title: "断崖", year: "1941" },
      { title: "ミニヴァー夫人", year: "1942" }, { title: "潜水艦轟沈す", year: "1942" }, { title: "嵐の青春", year: "1942" }, { title: "偉大なるアンバーソン家の人々", year: "1942" }, { title: "The Pied Piper", year: "1942" }, { title: "打撃王", year: "1942" }, { title: "心の旅路", year: "1942" }, { title: "希望の降る街", year: "1942" }, { title: "Wake Island", year: "1942" }, { title: "ヤンキー・ドゥードゥル・ダンディ", year: "1942" },
      { title: "カサブランカ", year: "1943" }, { title: "誰が為に鐘は鳴る", year: "1943" }, { title: "天国は待ってくれる", year: "1943" }, { title: "町の人気者", year: "1943" }, { title: "軍旗の下に", year: "1943" }, { title: "キュリー夫人", year: "1943" }, { title: "陽気なルームメイト", year: "1943" }, { title: "牛泥棒", year: "1943" }, { title: "聖処女", year: "1943" }, { title: "ラインの監視", year: "1943" },
      { title: "我が道を往く", year: "1944" }, { title: "深夜の告白", year: "1944" }, { title: "ガス燈", year: "1944" }, { title: "君去りし後", year: "1944" }, { title: "ウィルソン", year: "1944" },
      { title: "失われた週末", year: "1945" }, { title: "錨を上げて", year: "1945" }, { title: "聖メリーの鐘", year: "1945" }, { title: "ミルドレッド・ピアース", year: "1945" }, { title: "白い恐怖", year: "1945" },
      { title: "我等の生涯の最良の年", year: "1946" }, { title: "ヘンリィ五世", year: "1946" }, { title: "素晴らしき哉、人生!", year: "1946" }, { title: "剃刀の刃", year: "1946" }, { title: "子鹿物語", year: "1946" },
      { title: "紳士協定", year: "1947" }, { title: "気まぐれ天使", year: "1947" }, { title: "十字砲火", year: "1947" }, { title: "大いなる遺産", year: "1947" }, { title: "三十四丁目の奇蹟", year: "1947" },
      { title: "ハムレット", year: "1948" }, { title: "ジョニー・ベリンダ", year: "1948" }, { title: "赤い靴", year: "1948" }, { title: "蛇の穴", year: "1948" }, { title: "黄金", year: "1948" },
      { title: "オール・ザ・キングスメン", year: "1949" }, { title: "戦場", year: "1949" }, { title: "女相続人", year: "1949" }, { title: "三人の妻への手紙", year: "1949" }, { title: "頭上の敵機", year: "1949" },
      { title: "イヴの総て", year: "1950" }, { title: "ボーン・イエスタデイ", year: "1950" }, { title: "花嫁の父", year: "1950" }, { title: "キング・ソロモン", year: "1950" }, { title: "サンセット大通り", year: "1950" },
      { title: "巴里のアメリカ人", year: "1951" }, { title: "暁前の決断", year: "1951" }, { title: "陽のあたる場所", year: "1951" }, { title: "クォ・ヴァディス", year: "1951" }, { title: "欲望という名の電車", year: "1951" },
      { title: "地上最大のショウ", year: "1952" }, { title: "真昼の決闘", year: "1952" }, { title: "黒騎士", year: "1952" }, { title: "赤い風車", year: "1952" }, { title: "静かなる男", year: "1952" },
      { title: "地上より永遠に", year: "1953" }, { title: "ジュリアス・シーザー", year: "1953" }, { title: "聖衣", year: "1953" }, { title: "ローマの休日", year: "1953" }, { title: "シェーン", year: "1953" },
      { title: "波止場", year: "1954" }, { title: "ケイン号の叛乱", year: "1954" }, { title: "喝采", year: "1954" }, { title: "掠奪された七人の花嫁", year: "1954" }, { title: "愛の泉", year: "1954" },
      { title: "マーティ", year: "1955" }, { title: "慕情", year: "1955" }, { title: "ミスタア・ロバーツ", year: "1955" }, { title: "ピクニック", year: "1955" }, { title: "バラの刺青", year: "1955" },
      { title: "八十日間世界一周", year: "1956" }, { title: "友情ある説得", year: "1956" }, { title: "ジャイアンツ", year: "1956" }, { title: "王様と私", year: "1956" }, { title: "十戒", year: "1956" },
      { title: "戦場にかける橋", year: "1957" }, { title: "青春物語", year: "1957" }, { title: "サヨナラ", year: "1957" }, { title: "十二人の怒れる男", year: "1957" }, { title: "情婦", year: "1957" },
      { title: "恋の手ほどき", year: "1958" }, { title: "メイム叔母さん", year: "1958" }, { title: "熱いトタン屋根の猫", year: "1958" }, { title: "手錠のまゝの脱獄", year: "1958" }, { title: "旅路", year: "1958" },
      { title: "ベン・ハー", year: "1959" }, { title: "或る殺人", year: "1959" }, { title: "アンネの日記", year: "1959" }, { title: "尼僧物語", year: "1959" }, { title: "年上の女", year: "1959" },
      { title: "アパートの鍵貸します", year: "1960" }, { title: "アラモ", year: "1960" }, { title: "エルマー・ガントリー/魅せられた男", year: "1960" }, { title: "息子と恋人", year: "1960" }, { title: "サンダウナーズ", year: "1960" },
      { title: "ウエスト・サイド物語", year: "1961" }, { title: "ファニー", year: "1961" }, { title: "ナヴァロンの要塞", year: "1961" }, { title: "ハスラー", year: "1961" }, { title: "ニュールンベルグ裁判", year: "1961" },
      { title: "アラビアのロレンス", year: "1962" }, { title: "史上最大の作戦", year: "1962" }, { title: "The Music Man", year: "1962" }, { title: "戦艦バウンティ", year: "1962" }, { title: "アラバマ物語", year: "1962" },
      { title: "トム・ジョーンズの華麗な冒険", year: "1963" }, { title: "アメリカ アメリカ", year: "1963" }, { title: "クレオパトラ", year: "1963" }, { title: "西部開拓史", year: "1963" }, { title: "野のユリ", year: "1963" },
      { title: "マイ・フェア・レディ", year: "1964" }, { title: "ベケット", year: "1964" }, { title: "博士の異常な愛情 または私は如何にして心配するのを止めて水爆を愛するようになったか", year: "1964" }, { title: "メリー・ポピンズ", year: "1964" }, { title: "その男ゾルバ", year: "1964" },
      { title: "サウンド・オブ・ミュージック", year: "1965" }, { title: "ダーリング", year: "1965" }, { title: "ドクトル・ジバゴ", year: "1965" }, { title: "愚か者の船", year: "1965" }, { title: "裏街・太陽の天使", year: "1965" },
      { title: "わが命つきるとも", year: "1966" }, { title: "アルフィー", year: "1966" }, { title: "アメリカ上陸作戦", year: "1966" }, { title: "砲艦サンパブロ", year: "1966" }, { title: "バージニア・ウルフなんかこわくない", year: "1966" },
      { title: "夜の大捜査線", year: "1967" }, { title: "俺たちに明日はない", year: "1967" }, { title: "ドリトル先生不思議な旅", year: "1967" }, { title: "卒業", year: "1967" }, { title: "招かれざる客", year: "1967" },
      { title: "オリバー!", year: "1968" }, { title: "ファニー・ガール", year: "1968" }, { title: "冬のライオン", year: "1968" }, { title: "レーチェル レーチェル", year: "1968" }, { title: "ロミオとジュリエット", year: "1968" },
      { title: "真夜中のカーボーイ", year: "1969" }, { title: "1000日のアン", year: "1969" }, { title: "明日に向って撃て!", year: "1969" }, { title: "ハロー・ドーリー!", year: "1969" }, { title: "Z", year: "1969" },
      { title: "パットン大戦車軍団", year: "1970" }, { title: "大空港", year: "1970" }, { title: "ファイブ・イージー・ピーセス", year: "1970" }, { title: "ある愛の詩", year: "1970" }, { title: "M★A★S★H マッシュ", year: "1970" },
      { title: "フレンチ・コネクション", year: "1971" }, { title: "時計じかけのオレンジ", year: "1971" }, { title: "屋根の上のバイオリン弾き", year: "1971" }, { title: "ラスト・ショー", year: "1971" }, { title: "ニコライとアレクサンドラ", year: "1971" },
      { title: "ゴッドファーザー", year: "1972" }, { title: "キャバレー", year: "1972" }, { title: "脱出", year: "1972" }, { title: "移民者たち", year: "1972" }, { title: "サウンダー", year: "1972" },
      { title: "スティング", year: "1973" }, { title: "アメリカン・グラフィティ", year: "1973" }, { title: "叫びとささやき", year: "1973" }, { title: "エクソシスト", year: "1973" }, { title: "ウィークエンド・ラブ", year: "1973" },
      { title: "ゴッドファーザー PART II", year: "1974" }, { title: "チャイナタウン", year: "1974" }, { title: "カンバセーション…盗聴…", year: "1974" }, { title: "レニー・ブルース", year: "1974" }, { title: "タワーリング・インフェルノ", year: "1974" },
      { title: "カッコーの巣の上で", year: "1975" }, { title: "バリー・リンドン", year: "1975" }, { title: "狼たちの午後", year: "1975" }, { title: "ジョーズ", year: "1975" }, { title: "ナッシュビル", year: "1975" },
      { title: "ロッキー", year: "1976" }, { title: "大統領の陰謀", year: "1976" }, { title: "ウディ・ガスリー/わが心のふるさと", year: "1976" }, { title: "ネットワーク", year: "1976" }, { title: "タクシードライバー", year: "1976" },
      { title: "アニー・ホール", year: "1977" }, { title: "グッバイガール", year: "1977" }, { title: "ジュリア", year: "1977" }, { title: "スター・ウォーズ", year: "1977" }, { title: "愛と喝采の日々", year: "1977" },
      { title: "ディア・ハンター", year: "1978" }, { title: "帰郷", year: "1978" }, { title: "天国から来たチャンピオン", year: "1978" }, { title: "ミッドナイト・エクスプレス", year: "1978" }, { title: "結婚しない女", year: "1978" },
      { title: "クレイマー、クレイマー", year: "1979" }, { title: "オール・ザット・ジャズ", year: "1979" }, { title: "地獄の黙示録", year: "1979" }, { title: "ヤング・ゼネレーション", year: "1979" }, { title: "ノーマ・レイ", year: "1979" },
      { title: "普通の人々", year: "1980" }, { title: "歌え!ロレッタ愛のために", year: "1980" }, { title: "エレファント・マン", year: "1980" }, { title: "レイジング・ブル", year: "1980" }, { title: "テス", year: "1980" },
      { title: "炎のランナー", year: "1981" }, { title: "アトランティック・シティ", year: "1981" }, { title: "黄昏", year: "1981" }, { title: "レイダース/失われたアーク《聖櫃》", year: "1981" }, { title: "レッズ", year: "1981" },
      { title: "ガンジー", year: "1982" }, { title: "E.T.", year: "1982" }, { title: "ミッシング", year: "1982" }, { title: "トッツィー", year: "1982" }, { title: "評決", year: "1982" },
      { title: "愛と追憶の日々", year: "1983" }, { title: "再会の時", year: "1983" }, { title: "ドレッサー", year: "1983" }, { title: "ライトスタッフ", year: "1983" }, { title: "テンダー・マーシー", year: "1983" },
      { title: "アマデウス", year: "1984" }, { title: "キリング・フィールド", year: "1984" }, { title: "インドへの道", year: "1984" }, { title: "プレイス・イン・ザ・ハート", year: "1984" }, { title: "ソルジャー・ストーリー", year: "1984" },
      { title: "愛と哀しみの果て", year: "1985" }, { title: "カラーパープル", year: "1985" }, { title: "蜘蛛女のキス", year: "1985" }, { title: "女と男の名誉", year: "1985" }, { title: "刑事ジョン・ブック 目撃者", year: "1985" },
      { title: "プラトーン", year: "1986" }, { title: "愛は静けさの中に", year: "1986" }, { title: "ハンナとその姉妹", year: "1986" }, { title: "ミッション", year: "1986" }, { title: "眺めのいい部屋", year: "1986" },
      { title: "ラストエンペラー", year: "1987" }, { title: "ブロードキャスト・ニュース", year: "1987" }, { title: "危険な情事", year: "1987" }, { title: "戦場の小さな天使たち", year: "1987" }, { title: "月の輝く夜に", year: "1987" },
      { title: "レインマン", year: "1988" }, { title: "偶然の旅行者", year: "1988" }, { title: "危険な関係", year: "1988" }, { title: "ミシシッピー・バーニング", year: "1988" }, { title: "ワーキング・ガール", year: "1988" },
      { title: "ドライビング Miss デイジー", year: "1989" }, { title: "7月4日に生まれて", year: "1989" }, { title: "いまを生きる", year: "1989" }, { title: "フィールド・オブ・ドリームス", year: "1989" }, { title: "マイ・レフトフット", year: "1989" },
      { title: "ダンス・ウィズ・ウルブズ", year: "1990" }, { title: "レナードの朝", year: "1990" }, { title: "ゴースト/ニューヨークの幻", year: "1990" }, { title: "ゴッドファーザー PART III", year: "1990" }, { title: "グッドフェローズ", year: "1990" },
      { title: "羊たちの沈黙", year: "1991" }, { title: "美女と野獣", year: "1991" }, { title: "バグジー", year: "1991" }, { title: "JFK", year: "1991" }, { title: "サウス・キャロライナ/愛と追憶の彼方", year: "1991" },
      { title: "許されざる者", year: "1992" }, { title: "クライング・ゲーム", year: "1992" }, { title: "ア・フュー・グッドメン", year: "1992" }, { title: "ハワーズ・エンド", year: "1992" }, { title: "セント・オブ・ウーマン/夢の香り", year: "1992" },
      { title: "シンドラーのリスト", year: "1993" }, { title: "逃亡者", year: "1993" }, { title: "父の祈りを", year: "1993" }, { title: "ピアノ・レッスン", year: "1993" }, { title: "日の名残り", year: "1993" },
      { title: "フォレスト・ガンプ/一期一会", year: "1994" }, { title: "フォー・ウェディング", year: "1994" }, { title: "パルプ・フィクション", year: "1994" }, { title: "クイズ・ショウ", year: "1994" }, { title: "ショーシャンクの空に", year: "1994" },
      { title: "ブレイブハート", year: "1995" }, { title: "アポロ13", year: "1995" }, { title: "ベイブ", year: "1995" }, { title: "イル・ポスティーノ", year: "1995" }, { title: "いつか晴れた日に", year: "1995" },
      { title: "イングリッシュ・ペイシェント", year: "1996" }, { title: "ファーゴ", year: "1996" }, { title: "ザ・エージェント", year: "1996" }, { title: "秘密と嘘", year: "1996" }, { title: "シャイン", year: "1996" },
      { title: "タイタニック", year: "1997" }, { title: "恋愛小説家", year: "1997" }, { title: "フル・モンティ", year: "1997" }, { title: "グッド・ウィル・ハンティング/旅立ち", year: "1997" }, { title: "L.A.コンフィデンシャル", year: "1997" },
      { title: "恋におちたシェイクスピア", year: "1998" }, { title: "エリザベス", year: "1998" }, { title: "ライフ・イズ・ビューティフル", year: "1998" }, { title: "プライベート・ライアン", year: "1998" }, { title: "シン・レッド・ライン", year: "1998" },
      { title: "アメリカン・ビューティー", year: "1999" }, { title: "サイダーハウス・ルール", year: "1999" }, { title: "グリーンマイル", year: "1999" }, { title: "インサイダー", year: "1999" }, { title: "シックス・センス", year: "1999" },
      { title: "グラディエーター", year: "2000" }, { title: "ショコラ", year: "2000" }, { title: "グリーン・デスティニー", year: "2000" }, { title: "エリン・ブロコビッチ", year: "2000" }, { title: "トラフィック", year: "2000" },
      { title: "ビューティフル・マインド", year: "2001" }, { title: "ゴスフォード・パーク", year: "2001" }, { title: "イン・ザ・ベッドルーム", year: "2001" }, { title: "ロード・オブ・ザ・リング", year: "2001" }, { title: "ムーラン・ルージュ", year: "2001" },
      { title: "シカゴ", year: "2002" }, { title: "ギャング・オブ・ニューヨーク", year: "2002" }, { title: "めぐりあう時間たち", year: "2002" }, { title: "ロード・オブ・ザ・リング/二つの塔", year: "2002" }, { title: "戦場のピアニスト", year: "2002" },
      { title: "ロード・オブ・ザ・リング/王の帰還", year: "2003" }, { title: "ロスト・イン・トランスレーション", year: "2003" }, { title: "マスター・アンド・コマンダー", year: "2003" }, { title: "ミスティック・リバー", year: "2003" }, { title: "シービスケット", year: "2003" },
      { title: "ミリオンダラー・ベイビー", year: "2004" }, { title: "アビエイター", year: "2004" }, { title: "ネバーランド", year: "2004" }, { title: "Ray/レイ", year: "2004" }, { title: "サイドウェイ", year: "2004" },
      { title: "クラッシュ", year: "2005" }, { title: "ブロークバック・マウンテン", year: "2005" }, { title: "カポーティ", year: "2005" }, { title: "グッドナイト&グッドラック", year: "2005" }, { title: "ミュンヘン", year: "2005" },
      { title: "ディパーテッド", year: "2006" }, { title: "バベル", year: "2006" }, { title: "硫黄島からの手紙", year: "2006" }, { title: "リトル・ミス・サンシャイン", year: "2006" }, { title: "クィーン", year: "2006" },
      { title: "ノーカントリー", year: "2007" }, { title: "つぐない", year: "2007" }, { title: "JUNO/ジュノ", year: "2007" }, { title: "フィクサー", year: "2007" }, { title: "ゼア・ウィル・ビー・ブラッド", year: "2007" },
      { title: "スラムドッグ$ミリオネア", year: "2008" }, { title: "ベンジャミン・バトン 数奇な人生", year: "2008" }, { title: "フロスト×ニクソン", year: "2008" }, { title: "ミルク", year: "2008" }, { title: "愛を読むひと", year: "2008" },
      { title: "ハート・ロッカー", year: "2009" }, { title: "アバター", year: "2009" }, { title: "しあわせの隠れ場所", year: "2009" }, { title: "第9地区", year: "2009" }, { title: "17歳の肖像", year: "2009" }, { title: "イングロリアス・バスターズ", year: "2009" }, { title: "プレシャス", year: "2009" }, { title: "シリアスマン", year: "2009" }, { title: "カールじいさんの空飛ぶ家", year: "2009" }, { title: "マイレージ、マイライフ", year: "2009" },
      { title: "英国王のスピーチ", year: "2010" }, { title: "ブラック・スワン", year: "2010" }, { title: "ザ・ファイター", year: "2010" }, { title: "インセプション", year: "2010" }, { title: "キッズ・オールライト", year: "2010" }, { title: "127時間", year: "2010" }, { title: "ソーシャル・ネットワーク", year: "2010" }, { title: "トイ・ストーリー3", year: "2010" }, { title: "トゥルー・グリット", year: "2010" }, { title: "ウィンターズ・ボーン", year: "2010" },
      { title: "アーティスト", year: "2011" }, { title: "ファミリー・ツリー", year: "2011" }, { title: "ものすごくうるさくて、ありえないほど近い", year: "2011" }, { title: "ヘルプ 〜心がつなぐストーリー〜", year: "2011" }, { title: "ヒューゴの不思議な発明", year: "2011" }, { title: "ミッドナイト・イン・パリ", year: "2011" }, { title: "マネーボール", year: "2011" }, { title: "ツリー・オブ・ライフ", year: "2011" }, { title: "戦火の馬", year: "2011" },
      { title: "アルゴ", year: "2012" }, { title: "ジャンゴ 繋がれざる者", year: "2012" }, { title: "レ・ミゼラブル", year: "2012" }, { title: "ライフ・オブ・パイ/トラと漂流した227日", year: "2012" }, { title: "リンカーン", year: "2012" }, { title: "世界にひとつのプレイブック", year: "2012" }, { title: "ゼロ・ダーク・サーティ", year: "2012" }, { title: "愛、アムール", year: "2012" }, { title: "ハッシュパピー 〜バスタブ島の少女〜", year: "2012" },
      { title: "それでも夜は明ける", year: "2013" }, { title: "アメリカン・ハッスル", year: "2013" }, { title: "キャプテン・フィリップス", year: "2013" }, { title: "ダラス・バイヤーズクラブ", year: "2013" }, { title: "ゼロ・グラビティ", year: "2013" }, { title: "her/世界でひとつの彼女", year: "2013" }, { title: "ネブラスカ ふたつの心をつなぐ旅", year: "2013" }, { title: "あなたを抱きしめる日まで", year: "2013" }, { title: "ウルフ・オブ・ウォールストリート", year: "2013" },
      { title: "バードマン あるいは", year: "2014" }, { title: "アメリカン・スナイパー", year: "2014" }, { title: "6才のボクが、大人になるまで。", year: "2014" }, { title: "グランド・ブダペスト・ホテル", year: "2014" }, { title: "イミテーション・ゲーム/エニグマと天才数学者の秘密", year: "2014" }, { title: "グローリー/明日への行進", year: "2014" }, { title: "博士と彼女のセオリー", year: "2014" }, { title: "セッション", year: "2014" },
      { title: "スポットライト 世紀のスクープ", year: "2015" }, { title: "マネー・ショート 華麗なる大逆転", year: "2015" }, { title: "ブリッジ・オブ・スパイ", year: "2015" }, { title: "ブルックリン", year: "2015" }, { title: "マッドマックス 怒りのデス・ロード", year: "2015" }, { title: "オデッセイ", year: "2015" }, { title: "レヴェナント: 蘇えりし者", year: "2015" }, { title: "ルーム", year: "2015" },
      { title: "ムーンライト", year: "2016" }, { title: "メッセージ", year: "2016" }, { title: "フェンス", year: "2016" }, { title: "ハクソー・リッジ", year: "2016" }, { title: "最後の追跡", year: "2016" }, { title: "ドリーム", year: "2016" }, { title: "ラ・ラ・ランド", year: "2016" }, { title: "LION/ライオン 〜25年目のただいま〜", year: "2016" }, { title: "マンチェスター・バイ・ザ・シー", year: "2016" },
      { title: "シェイプ・オブ・ウォーター", year: "2017" }, { title: "君の名前で僕を呼んで", year: "2017" }, { title: "ウィンストン・チャーチル/ヒトラーから世界を救った男", year: "2017" }, { title: "ダンケルク", year: "2017" }, { title: "ゲット・アウト", year: "2017" }, { title: "レディ・バード", year: "2017" }, { title: "ファントム・スレッド", year: "2017" }, { title: "ペンタゴン・ペーパーズ/最高機密文書", year: "2017" }, { title: "スリー・ビルボード", year: "2017" },
      { title: "グリーンブック", year: "2018" }, { title: "ブラックパンサー", year: "2018" }, { title: "ブラック・クランズマン", year: "2018" }, { title: "ボヘミアン・ラプソディ", year: "2018" }, { title: "女王陛下のお気に入り", year: "2018" }, { title: "ROMA/ローマ", year: "2018" }, { title: "アリー/ スター誕生", year: "2018" }, { title: "バイス", year: "2018" },
      { title: "パラサイト 半地下の家族", year: "2019" }, { title: "フォードvsフェラーリ", year: "2019" }, { title: "アイリッシュマン", year: "2019" }, { title: "ジョジョ・ラビット", year: "2019" }, { title: "ジョーカー", year: "2019" }, { title: "ストーリー・オブ・マイライフ/わたしの若草物語", year: "2019" }, { title: "マリッジ・ストーリー", year: "2019" }, { title: "1917 命をかけた伝令", year: "2019" }, { title: "ワンス・アポン・ア・タイム・イン・ハリウッド", year: "2019" },
      { title: "ノマドランド", year: "2020" }, { title: "ファーザー", year: "2020" }, { title: "ユダ&ブラック・メシア 裏切りの代償", year: "2020" }, { title: "Mank/マンク", year: "2020" }, { title: "ミナリ", year: "2020" }, { title: "プロミシング・ヤング・ウーマン", year: "2020" }, { title: "サウンド・オブ・メタル -聞こえるということ-", year: "2020" }, { title: "シカゴ7裁判", year: "2020" },
      { title: "コーダ あいのうた", year: "2021" }, { title: "ベルファスト", year: "2021" }, { title: "ドント・ルック・アップ", year: "2021" }, { title: "ドライブ・マイ・カー", year: "2021" }, { title: "DUNE/デューン 砂の惑星", year: "2021" }, { title: "ドリームプラン", year: "2021" }, { title: "リコリス・ピザ", year: "2021" }, { title: "ナイトメア・アリー", year: "2021" }, { title: "パワー・オブ・ザ・ドッグ", year: "2021" }, { title: "ウエスト・サイド・ストーリー", year: "2021" },
      { title: "エブリシング・エブリウェア・オール・アット・ワンス", year: "2022" }, { title: "西部戦線異状なし", year: "2022" }, { title: "アバター:ウェイ・オブ・ウォーター", year: "2022" }, { title: "イニシェリン島の精霊", year: "2022" }, { title: "エルヴィス", year: "2022" }, { title: "フェイブルマンズ", year: "2022" }, { title: "TAR/ター", year: "2022" }, { title: "トップガン マーヴェリック", year: "2022" }, { title: "逆転のトライアングル", year: "2022" }, { title: "ウーマン・トーキング 私たちの選択", year: "2022" },
      { title: "オッペンハイマー", year: "2023" }, { title: "アメリカン・フィクション", year: "2023" }, { title: "落下の解剖学", year: "2023" }, { title: "バービー", year: "2023" }, { title: "ホールドオーバーズ 置いてけぼりのホリディ", year: "2023" }, { title: "キラーズ・オブ・ザ・フラワームーン", year: "2023" }, { title: "マエストロ: その音楽と愛と", year: "2023" }, { title: "パスト ライブス/再会", year: "2023" }, { title: "哀れなるものたち", year: "2023" }, { title: "関心領域", year: "2023" },
      { title: "ANORA アノーラ", year: "2024" }, { title: "ブルータリスト", year: "2024" }, { title: "名もなき者/A COMPLETE UNKNOWN", year: "2024" }, { title: "教皇選挙", year: "2024" }, { title: "デューン 砂の惑星PART2", year: "2024" }, { title: "エミリア・ペレス", year: "2024" }, { title: "アイム・スティル・ヒア", year: "2024" }, { title: "ニッケル・ボーイズ", year: "2024" }, { title: "サブスタンス", year: "2024" }, { title: "ウィキッド ふたりの魔女", year: "2024" },
      { title: "ワン・バトル・アフター・アナザー", year: "2025" }, { title: "ブゴニア", year: "2025" }, { title: "F1/エフワン", year: "2025" }, { title: "フランケンシュタイン", year: "2025" }, { title: "ハムネット", year: "2025" }, { title: "マーティ・シュプリーム 世界をつかめ", year: "2025" }, { title: "シークレット・エージェント", year: "2025" }, { title: "センチメンタル・バリュー", year: "2025" }, { title: "罪人たち", year: "2025" }, { title: "トレイン・ドリームズ", year: "2025" },
    ] },
    { id: "oscar_intl", label: "アカデミー賞 国際長編映画賞", emoji: "🌍", fmAward: "1/12" },
    { id: "oscar_anime", label: "アカデミー賞 長編アニメ賞", emoji: "🎨", fmAward: "1/17" },
    { id: "bafta", label: "英国アカデミー賞 作品賞", emoji: "🎭", fmAward: "35/83" },
    { id: "cannes", label: "カンヌ国際映画祭 パルム・ドール", emoji: "🌴", fmAward: "42/93" },
    { id: "venice", label: "ヴェネツィア国際映画祭 金獅子賞", emoji: "🦁", fmAward: "44/99" },
    { id: "berlin", label: "ベルリン国際映画祭 金熊賞", emoji: "🐻", fmAward: "43/96" },
    { id: "tiff", label: "トロント国際映画祭 観客賞", emoji: "🍁", fmAward: "62/114" },
    { id: "cesar", label: "セザール賞 作品賞", emoji: "🇫🇷", fmAward: "38/90" },
    { id: "sundance", label: "サンダンス映画祭 グランプリ", emoji: "⛰️", fmAward: "64/116" },
    { id: "japan_academy", label: "日本アカデミー賞 最優秀作品賞", emoji: "🎌", fmAward: "19/77" },
    { id: "japan_academy_excellent", label: "日本アカデミー賞 優秀作品賞", emoji: "🎌", titles: [
      { title: "幸福の黄色いハンカチ", year: "1977" }, { title: "青春の門・自立篇", year: "1977" }, { title: "竹山ひとり旅", year: "1977" }, { title: "八甲田山", year: "1977" }, { title: "はなれ瞽女おりん", year: "1977" },
      { title: "事件", year: "1978" }, { title: "愛の亡霊", year: "1978" }, { title: "鬼畜", year: "1978" }, { title: "サード", year: "1978" }, { title: "柳生一族の陰謀", year: "1978" },
      { title: "復讐するは我にあり", year: "1979" }, { title: "あゝ野麦峠", year: "1979" }, { title: "衝動殺人 息子よ", year: "1979" }, { title: "太陽を盗んだ男", year: "1979" }, { title: "もう頬づえはつかない", year: "1979" },
      { title: "ツィゴイネルワイゼン", year: "1980" }, { title: "父よ母よ!", year: "1980" }, { title: "動乱", year: "1980" }, { title: "二百三高地", year: "1980" }, { title: "遙かなる山の呼び声", year: "1980" },
      { title: "駅 STATION", year: "1981" }, { title: "ええじゃないか", year: "1981" }, { title: "遠雷", year: "1981" }, { title: "泥の河", year: "1981" }, { title: "日本の熱い日々 謀殺・下山事件", year: "1981" },
      { title: "蒲田行進曲", year: "1982" }, { title: "鬼龍院花子の生涯", year: "1982" }, { title: "疑惑", year: "1982" }, { title: "未完の対局", year: "1982" }, { title: "誘拐報道", year: "1982" },
      { title: "楢山節考", year: "1983" }, { title: "家族ゲーム", year: "1983" }, { title: "細雪", year: "1983" }, { title: "戦場のメリークリスマス", year: "1983" }, { title: "南極物語", year: "1983" },
      { title: "お葬式", year: "1984" }, { title: "おはん", year: "1984" }, { title: "瀬戸内少年野球団", year: "1984" }, { title: "天国の駅", year: "1984" }, { title: "麻雀放浪記", year: "1984" },
      { title: "花いちもんめ", year: "1985" }, { title: "恋文", year: "1985" }, { title: "それから", year: "1985" }, { title: "Wの悲劇", year: "1985" }, { title: "ビルマの竪琴", year: "1985" },
      { title: "火宅の人", year: "1986" }, { title: "植村直己物語", year: "1986" }, { title: "キネマの天地", year: "1986" }, { title: "新・喜びも悲しみも幾歳月", year: "1986" }, { title: "人間の約束", year: "1986" },
      { title: "マルサの女", year: "1987" }, { title: "竹取物語", year: "1987" }, { title: "ハチ公物語", year: "1987" }, { title: "夜汽車", year: "1987" }, { title: "吉原炎上", year: "1987" },
      { title: "敦煌", year: "1988" }, { title: "異人たちとの夏", year: "1988" }, { title: "ダウンタウンヒーローズ", year: "1988" }, { title: "華の乱", year: "1988" }, { title: "優駿", year: "1988" },
      { title: "黒い雨", year: "1989" }, { title: "あ・うん", year: "1989" }, { title: "社葬", year: "1989" }, { title: "本覺坊遺文 千利休", year: "1989" }, { title: "利休", year: "1989" },
      { title: "少年時代", year: "1990" }, { title: "櫻の園", year: "1990" }, { title: "死の棘", year: "1990" }, { title: "白い手", year: "1990" }, { title: "夢", year: "1990" },
      { title: "息子", year: "1991" }, { title: "あの夏、いちばん静かな海。", year: "1991" }, { title: "大誘拐 RAINBOW KIDS", year: "1991" }, { title: "八月の狂詩曲", year: "1991" }, { title: "無能の人", year: "1991" },
      { title: "シコふんじゃった。", year: "1992" }, { title: "いつかギラギラする日", year: "1992" }, { title: "青春デンデケデケデケ", year: "1992" }, { title: "遠き落日", year: "1992" }, { title: "ミンボーの女", year: "1992" },
      { title: "学校", year: "1993" }, { title: "月はどっちに出ている", year: "1993" }, { title: "虹の橋", year: "1993" }, { title: "僕らはみんな生きている", year: "1993" }, { title: "わが愛の譜 滝廉太郎物語", year: "1993" },
      { title: "忠臣蔵外伝 四谷怪談", year: "1994" }, { title: "居酒屋ゆうれい", year: "1994" }, { title: "119", year: "1994" }, { title: "四十七人の刺客", year: "1994" }, { title: "ラストソング", year: "1994" },
      { title: "午後の遺言状", year: "1995" }, { title: "きけ、わだつみの声", year: "1995" }, { title: "藏", year: "1995" }, { title: "写楽", year: "1995" }, { title: "Love Letter", year: "1995" },
      { title: "Shall we ダンス?", year: "1996" }, { title: "学校II", year: "1996" }, { title: "スーパーの女", year: "1996" }, { title: "スワロウテイル", year: "1996" }, { title: "わが心の銀河鉄道 宮沢賢治物語", year: "1996" },
      { title: "もののけ姫", year: "1997" }, { title: "うなぎ", year: "1997" }, { title: "東京日和", year: "1997" }, { title: "誘拐", year: "1997" }, { title: "ラヂオの時間", year: "1997" },
      { title: "愛を乞うひと", year: "1998" }, { title: "踊る大捜査線 THE MOVIE", year: "1998" }, { title: "学校III", year: "1998" }, { title: "カンゾー先生", year: "1998" }, { title: "HANA-BI", year: "1998" },
      { title: "鉄道員", year: "1999" }, { title: "菊次郎の夏", year: "1999" }, { title: "金融腐蝕列島 呪縛", year: "1999" }, { title: "御法度", year: "1999" }, { title: "梟の城", year: "1999" },
      { title: "雨あがる", year: "2000" }, { title: "顔", year: "2000" }, { title: "十五才 学校IV", year: "2000" }, { title: "バトル・ロワイアル", year: "2000" }, { title: "ホワイトアウト", year: "2000" },
      { title: "千と千尋の神隠し", year: "2001" }, { title: "ウォーターボーイズ", year: "2001" }, { title: "GO", year: "2001" }, { title: "千年の恋 ひかる源氏物語", year: "2001" }, { title: "ホタル", year: "2001" },
      { title: "たそがれ清兵衛", year: "2002" }, { title: "阿弥陀堂だより", year: "2002" }, { title: "突入せよ!『あさま山荘』事件", year: "2002" }, { title: "陽はまた昇る", year: "2002" }, { title: "ピンポン", year: "2002" },
      { title: "壬生義士伝", year: "2003" }, { title: "阿修羅のごとく", year: "2003" }, { title: "踊る大捜査線 THE MOVIE 2 レインボーブリッジを封鎖せよ!", year: "2003" }, { title: "座頭市", year: "2003" }, { title: "スパイ・ゾルゲ", year: "2003" },
      { title: "半落ち", year: "2004" }, { title: "隠し剣 鬼の爪", year: "2004" }, { title: "スウィングガールズ", year: "2004" }, { title: "世界の中心で、愛をさけぶ", year: "2004" }, { title: "血と骨", year: "2004" },
      { title: "ALWAYS 三丁目の夕日", year: "2005" }, { title: "北の零年", year: "2005" }, { title: "蟬しぐれ", year: "2005" }, { title: "パッチギ!", year: "2005" }, { title: "亡国のイージス", year: "2005" },
      { title: "フラガール", year: "2006" }, { title: "明日の記憶", year: "2006" }, { title: "男たちの大和/YAMATO", year: "2006" }, { title: "THE 有頂天ホテル", year: "2006" }, { title: "武士の一分", year: "2006" },
      { title: "東京タワー オカンとボクと、時々、オトン", year: "2007" }, { title: "ALWAYS 続・三丁目の夕日", year: "2007" }, { title: "キサラギ", year: "2007" }, { title: "それでもボクはやってない", year: "2007" }, { title: "眉山", year: "2007" },
      { title: "おくりびと", year: "2008" }, { title: "母べえ", year: "2008" }, { title: "クライマーズ・ハイ", year: "2008" }, { title: "ザ・マジックアワー", year: "2008" }, { title: "容疑者Xの献身", year: "2008" },
      { title: "沈まぬ太陽", year: "2009" }, { title: "ヴィヨンの妻 桜桃とタンポポ", year: "2009" }, { title: "ゼロの焦点", year: "2009" }, { title: "劔岳 点の記", year: "2009" }, { title: "ディア・ドクター", year: "2009" },
      { title: "告白", year: "2010" }, { title: "悪人", year: "2010" }, { title: "おとうと", year: "2010" }, { title: "孤高のメス", year: "2010" }, { title: "十三人の刺客", year: "2010" },
      { title: "八日目の蝉", year: "2011" }, { title: "大鹿村騒動記", year: "2011" }, { title: "最後の忠臣蔵", year: "2011" }, { title: "ステキな金縛り", year: "2011" }, { title: "探偵はBARにいる", year: "2011" },
      { title: "桐島、部活やめるってよ", year: "2012" }, { title: "あなたへ", year: "2012" }, { title: "北のカナリアたち", year: "2012" }, { title: "のぼうの城", year: "2012" }, { title: "わが母の記", year: "2012" },
      { title: "舟を編む", year: "2013" }, { title: "凶悪", year: "2013" }, { title: "少年H", year: "2013" }, { title: "そして父になる", year: "2013" }, { title: "東京家族", year: "2013" }, { title: "利休にたずねよ", year: "2013" },
      { title: "永遠の0", year: "2014" }, { title: "紙の月", year: "2014" }, { title: "小さいおうち", year: "2014" }, { title: "蜩ノ記", year: "2014" }, { title: "ふしぎな岬の物語", year: "2014" },
      { title: "海街diary", year: "2015" }, { title: "海難1890", year: "2015" }, { title: "日本のいちばん長い日", year: "2015" }, { title: "母と暮せば", year: "2015" }, { title: "百円の恋", year: "2015" },
      { title: "シン・ゴジラ", year: "2016" }, { title: "怒り", year: "2016" }, { title: "家族はつらいよ", year: "2016" }, { title: "湯を沸かすほどの熱い愛", year: "2016" }, { title: "64-ロクヨン- 前編", year: "2016" },
      { title: "三度目の殺人", year: "2017" }, { title: "君の膵臓をたべたい", year: "2017" }, { title: "関ヶ原", year: "2017" }, { title: "ナミヤ雑貨店の奇蹟", year: "2017" }, { title: "花戦さ", year: "2017" },
      { title: "万引き家族", year: "2018" }, { title: "カメラを止めるな!", year: "2018" }, { title: "北の桜守", year: "2018" }, { title: "孤狼の血", year: "2018" }, { title: "空飛ぶタイヤ", year: "2018" },
      { title: "新聞記者", year: "2019" }, { title: "キングダム", year: "2019" }, { title: "翔んで埼玉", year: "2019" }, { title: "閉鎖病棟 それぞれの朝", year: "2019" }, { title: "蜜蜂と遠雷", year: "2019" },
      { title: "ミッドナイトスワン", year: "2020" }, { title: "浅田家!", year: "2020" }, { title: "男はつらいよ お帰り 寅さん", year: "2020" }, { title: "罪の声", year: "2020" }, { title: "Fukushima 50", year: "2020" },
      { title: "ドライブ・マイ・カー", year: "2021" }, { title: "キネマの神様", year: "2021" }, { title: "孤狼の血 LEVEL2", year: "2021" }, { title: "すばらしき世界", year: "2021" }, { title: "護られなかった者たちへ", year: "2021" },
      { title: "ある男", year: "2022" }, { title: "シン・ウルトラマン", year: "2022" }, { title: "月の満ち欠け", year: "2022" }, { title: "ハケンアニメ!", year: "2022" }, { title: "流浪の月", year: "2022" },
      { title: "ゴジラ-1.0", year: "2023" }, { title: "怪物", year: "2023" }, { title: "こんにちは、母さん", year: "2023" }, { title: "福田村事件", year: "2023" }, { title: "PERFECT DAYS", year: "2023" },
      { title: "侍タイムスリッパー", year: "2024" }, { title: "キングダム 大将軍の帰還", year: "2024" }, { title: "正体", year: "2024" }, { title: "夜明けのすべて", year: "2024" }, { title: "ラストマイル", year: "2024" },
      { title: "国宝", year: "2025" }, { title: "宝島", year: "2025" }, { title: "爆弾", year: "2025" }, { title: "ファーストキス 1ST KISS", year: "2025" }, { title: "TOKYOタクシー", year: "2025" },
    ] },
    { id: "kinejun", label: "キネマ旬報ベスト・テン（邦画1位）", emoji: "📖", titles: [
      { title: "足にさはつた女", year: "1926" }, { title: "忠次旅日記 信州血笑篇", year: "1927" }, { title: "浪人街 第一話 美しき獲物", year: "1928" }, { title: "首の座", year: "1929" }, { title: "マダムと女房", year: "1931" }, { title: "生れてはみたけれど", year: "1932" }, { title: "出来ごころ", year: "1933" }, { title: "浮草物語", year: "1934" }, { title: "妻よ薔薇のやうに", year: "1935" }, { title: "祇園の姉妹", year: "1936" }, { title: "限りなき前進", year: "1937" }, { title: "五人の斥候兵", year: "1938" }, { title: "土", year: "1939" }, { title: "小島の春", year: "1940" }, { title: "戸田家の兄妹", year: "1941" }, { title: "ハワイ・マレー沖海戦", year: "1942" }, { title: "大曾根家の朝", year: "1946" }, { title: "安城家の舞踏會", year: "1947" }, { title: "醉いどれ天使", year: "1948" }, { title: "晩春", year: "1949" }, { title: "また逢う日まで", year: "1950" }, { title: "麦秋", year: "1951" }, { title: "生きる", year: "1952" }, { title: "にごりえ", year: "1953" }, { title: "二十四の瞳", year: "1954" }, { title: "浮雲", year: "1955" }, { title: "真昼の暗黒", year: "1956" }, { title: "米", year: "1957" }, { title: "楢山節考", year: "1958" }, { title: "キクとイサム", year: "1959" }, { title: "おとうと", year: "1960" }, { title: "不良少年", year: "1961" }, { title: "私は二歳", year: "1962" }, { title: "にっぽん昆虫記", year: "1963" }, { title: "砂の女", year: "1964" }, { title: "赤ひげ", year: "1965" }, { title: "白い巨塔", year: "1966" }, { title: "上意討ち 拝領妻始末", year: "1967" }, { title: "神々の深き欲望", year: "1968" }, { title: "心中天網島", year: "1969" }, { title: "家族", year: "1970" }, { title: "儀式", year: "1971" }, { title: "忍ぶ川", year: "1972" }, { title: "津軽じょんがら節", year: "1973" }, { title: "サンダカン八番娼館 望郷", year: "1974" }, { title: "ある映画監督の生涯 溝口健二の記録", year: "1975" }, { title: "青春の殺人者", year: "1976" }, { title: "幸福の黄色いハンカチ", year: "1977" }, { title: "サード", year: "1978" }, { title: "復讐するは我にあり", year: "1979" }, { title: "ツィゴイネルワイゼン", year: "1980" }, { title: "泥の河", year: "1981" }, { title: "蒲田行進曲", year: "1982" }, { title: "家族ゲーム", year: "1983" }, { title: "お葬式", year: "1984" }, { title: "それから", year: "1985" }, { title: "海と毒薬", year: "1986" }, { title: "マルサの女", year: "1987" }, { title: "となりのトトロ", year: "1988" }, { title: "黒い雨", year: "1989" }, { title: "櫻の園", year: "1990" }, { title: "息子", year: "1991" }, { title: "シコふんじゃった。", year: "1992" }, { title: "月はどっちに出ている", year: "1993" }, { title: "全身小説家", year: "1994" }, { title: "午後の遺言状", year: "1995" }, { title: "Shall we ダンス?", year: "1996" }, { title: "うなぎ", year: "1997" }, { title: "HANA-BI", year: "1998" }, { title: "あ、春", year: "1999" }, { title: "顔", year: "2000" }, { title: "GO", year: "2001" }, { title: "たそがれ清兵衛", year: "2002" }, { title: "美しい夏キリシマ", year: "2003" }, { title: "誰も知らない", year: "2004" }, { title: "パッチギ!", year: "2005" }, { title: "フラガール", year: "2006" }, { title: "それでもボクはやってない", year: "2007" }, { title: "おくりびと", year: "2008" }, { title: "ディア・ドクター", year: "2009" }, { title: "悪人", year: "2010" }, { title: "一枚のハガキ", year: "2011" }, { title: "かぞくのくに", year: "2012" }, { title: "ペコロスの母に会いに行く", year: "2013" }, { title: "そこのみにて光輝く", year: "2014" }, { title: "恋人たち", year: "2015" }, { title: "この世界の片隅に", year: "2016" }, { title: "映画 夜空はいつでも最高密度の青色だ", year: "2017" }, { title: "万引き家族", year: "2018" }, { title: "火口のふたり", year: "2019" }, { title: "スパイの妻〈劇場版〉", year: "2020" }, { title: "ドライブ・マイ・カー", year: "2021" }, { title: "ケイコ 目を澄ませて", year: "2022" }, { title: "せかいのおきく", year: "2023" }, { title: "夜明けのすべて", year: "2024" }, { title: "旅と日々", year: "2025" },
    ] },
    { id: "golden_globe", label: "ゴールデングローブ賞 作品賞（ドラマ）", emoji: "🌐", fmAward: "2/21" },
    { id: "golden_globe_mc", label: "ゴールデングローブ賞 作品賞（ミュージカル・コメディ）", emoji: "🎪", fmAward: "2/22" },
  ];
  let collectionFilms = [];

  // 正規化タイトル → 所属コレクション名（複数可）の対応表（初回に一度だけ構築）
  let _collMap = null;
  function collMap() {
    if (_collMap) return _collMap;
    _collMap = new Map();
    [...COLLECTIONS, ...AWARDS].forEach((col) => {
      (col.titles || []).forEach((t) => {
        const k = normTitle(typeof t === "string" ? t : t.title);
        if (!_collMap.has(k)) _collMap.set(k, []);
        if (!_collMap.get(k).includes(col.label)) _collMap.get(k).push(col.label);
      });
    });
    return _collMap;
  }

  // その作品が属するコレクション名の一覧（タイトル一致＋コレクション追加時のタグ）
  function movieCollections(movie) {
    const set = new Set(collMap().get(normTitle(movie.title)) || []);
    if (movie.collection) set.add(movie.collection);
    return [...set];
  }

  // 配列からランダムに n 件を取り出す（Fisher–Yates）
  function pickRandom(arr, n) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  }

  // コレクション用と映画賞・映画祭用でUIの描画先を切り替えるためのコンテキスト
  const COLLECTION_BATCH = 48; // 一度に照合・表示する作品数
  const COLLECTION_CTX = {
    panel: "collection", listId: "collectionList", statusId: "collectionStatus",
    gridId: "collectionGrid", actionsId: "collectionActions", addBtnId: "collectionAddBtn",
    moreWrapId: "collectionMoreWrap", moreBtnId: "collectionMoreBtn", films: [], queue: [], col: null,
  };
  const AWARD_CTX = {
    panel: "award", listId: "awardList", statusId: "awardStatus",
    gridId: "awardGrid", actionsId: "awardActions", addBtnId: "awardAddBtn",
    moreWrapId: "awardMoreWrap", moreBtnId: "awardMoreBtn", films: [], queue: [], col: null,
  };
  function initCollectionUI() {
    renderCollectionChips();
  }

  function initAwardUI() {
    renderAwardChips();
  }

  function initGenreUI() {
    renderGenreChips();
  }

  function renderCollectionChips() {
    const wrap = document.getElementById("collectionList");
    const input = document.getElementById("collectionSearchInput");
    const q = input ? input.value.trim().toLowerCase() : "";
    const shuffleBtn = document.getElementById("collectionShuffleBtn");
    const label = document.querySelector('[data-panel="collection"] .suggest-label');
    wrap.innerHTML = "";
    // 検索中は一致する全コレクションを表示。未入力時はおすすめ10件をランダム表示。
    const cols = q
      ? COLLECTIONS.filter((c) => c.label.toLowerCase().includes(q))
      : pickRandom(COLLECTIONS, 10);
    if (shuffleBtn) shuffleBtn.style.display = q ? "none" : "";
    if (label) label.textContent = q ? `「${input.value.trim()}」の検索結果（${cols.length}件）` : "おすすめのコレクション";
    if (q && !cols.length) {
      const p = document.createElement("p");
      p.className = "search-status";
      p.textContent = "該当するコレクションが見つかりませんでした。";
      wrap.appendChild(p);
      return;
    }
    cols.forEach((col) => {
      const b = document.createElement("button");
      b.className = "collection-chip";
      b.dataset.col = col.id;
      b.textContent = `${col.emoji} ${col.label}`;
      b.addEventListener("click", () => loadCollection(col, COLLECTION_CTX));
      wrap.appendChild(b);
    });
  }

  // 映画賞・映画祭は独立タブ。シャッフルせず常に全件を並べる
  function renderAwardChips() {
    const wrap = document.getElementById("awardList");
    if (!wrap || wrap.children.length) return;
    AWARDS.forEach((col) => {
      const b = document.createElement("button");
      b.className = "collection-chip";
      b.dataset.col = col.id;
      b.textContent = `${col.emoji} ${col.label}`;
      b.addEventListener("click", () => loadAward(col));
      wrap.appendChild(b);
    });
  }

  // ジャンルは独立タブ。シャッフルせず常に全件のチップを並べる
  function renderGenreChips() {
    const wrap = document.getElementById("genreList");
    if (!wrap || wrap.children.length) return;
    GENRES.forEach((col) => {
      const b = document.createElement("button");
      b.className = "collection-chip";
      b.dataset.col = col.id;
      b.textContent = `${col.emoji} ${col.label}`;
      b.addEventListener("click", () => fmLoad(genreCtrl, col));
      wrap.appendChild(b);
    });
  }

  // ---- Filmarks 一覧（ジャンル・映画賞）を人気順・ページ送りで取得する汎用処理 ----
  // ジャンルタブと映画賞タブで共通利用する。col から取得URLを組み立てる buildUrl を
  // コントローラごとに差し替えるだけで、同じロジックを使い回せる。
  const FM_TARGET = 48;      // 1回に表示する本数
  const FM_POOL_MIN = 96;    // 1回のロードで確保する候補プールの最小サイズ
  const FM_BATCH_PAGES = 3;  // 1リクエストで取得するページ数（1ページ約36件）

  function newFmSession() {
    return { col: null, nextPage: 1, hasMore: false, skipped: 0, seen: new Set(), queue: [] };
  }

  const genreCtrl = {
    panel: "genre", gridId: "genreGrid", statusId: "genreStatus", actionsId: "genreActions",
    addBtnId: "genreAddBtn", moreWrapId: "genreMoreWrap", moreBtnId: "genreMoreBtn",
    hint: "ジャンル別の取得にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。",
    buildUrl: (col, from, pages) => `/api/filmarks/genre?genre=${col.fmGenre}&from=${from}&pages=${pages}`,
    films: [], session: newFmSession(),
  };
  const awardCtrl = {
    panel: "award", gridId: "awardGrid", statusId: "awardStatus", actionsId: "awardActions",
    addBtnId: "awardAddBtn", moreWrapId: "awardMoreWrap", moreBtnId: "awardMoreBtn",
    hint: "映画賞の取得にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。",
    buildUrl: (col, from, pages) => `/api/filmarks/award?path=${encodeURIComponent(col.fmAward)}&from=${from}&pages=${pages}`,
    films: [], session: newFmSession(),
  };

  async function fmFetchRange(ctrl, col, from, pages) {
    let res;
    try {
      res = await fetch(ctrl.buildUrl(col, from, pages));
    } catch (e) {
      throw new Error("NO_SERVER");
    }
    if (!res.ok) throw new Error("HTTP_" + res.status);
    const data = await res.json();
    return { results: data.results || [], hasMore: !!data.hasMore };
  }

  // 未登録・重複なしの候補が minSize 件になるまでページを辿って集める（人気順を維持）
  // 同じセッションへの補充は直列化（先読みと「もっと見る」が同じページを取り合わないように）
  function fmFillQueue(ctrl, minSize) {
    const s = ctrl.session;
    const run = (s.busy || Promise.resolve()).then(() => fmFillQueueNow(s, ctrl, minSize));
    s.busy = run.catch(() => {});
    return run;
  }

  async function fmFillQueueNow(s, ctrl, minSize) {
    const added = [];
    while (s.queue.length + added.length < minSize && s.hasMore) {
      const data = await fmFetchRange(ctrl, s.col, s.nextPage, FM_BATCH_PAGES);
      s.nextPage += FM_BATCH_PAGES;
      s.hasMore = data.hasMore;
      for (const b of data.results) {
        const key = normTitle(b.title);
        if (key && s.seen.has(key)) continue;
        if (key) s.seen.add(key);
        if (isRegisteredByTitle(b.title)) { s.skipped++; continue; }
        added.push({ title: b.title, year: b.year || "", poster: b.poster || "", filmarksId: b.id, collection: s.col.label });
      }
    }
    s.queue.push(...added);
  }

  function fmUpdateStatus(ctrl) {
    const status = document.getElementById(ctrl.statusId);
    const s = ctrl.session;
    if (!ctrl.films.length) {
      status.textContent = s.skipped
        ? `「${s.col.label}」の作品はすべて登録済みでした。`
        : `「${s.col.label}」の作品が見つかりませんでした。`;
      return;
    }
    let msg = `「${s.col.label}」から ${ctrl.films.length}件を表示中。観た作品をタップして選び、まとめて追加できます。`;
    if (s.skipped) msg += `（登録済み ${s.skipped}件は除外）`;
    if (!s.queue.length && !s.hasMore) msg += ` ※未登録作はこれで全て表示しました。`;
    status.textContent = msg;
  }

  function fmUpdateMoreBtn(ctrl) {
    const wrap = document.getElementById(ctrl.moreWrapId);
    if (!wrap) return;
    const s = ctrl.session;
    const more = s.queue.length > 0 || s.hasMore;
    wrap.style.display = (ctrl.films.length && more) ? "flex" : "none";
  }

  async function fmLoad(ctrl, col) {
    const status = document.getElementById(ctrl.statusId);
    const grid = document.getElementById(ctrl.gridId);
    const actions = document.getElementById(ctrl.actionsId);
    grid.innerHTML = "";
    actions.style.display = "none";
    ctrl.films = [];
    ctrl.session = newFmSession();
    ctrl.session.col = col;
    ctrl.session.hasMore = true;
    document.querySelectorAll(`[data-panel="${ctrl.panel}"] .collection-chip`).forEach((x) =>
      x.classList.toggle("active", x.dataset.col === col.id)
    );
    fmUpdateMoreBtn(ctrl);
    status.textContent = `「${col.label}」の作品を取得中…`;
    const session = ctrl.session;
    try {
      await fmFillQueue(ctrl, FM_TARGET);
    } catch (e) {
      status.innerHTML = e.message === "NO_SERVER" ? ctrl.hint : "取得に失敗しました: " + e.message;
      return;
    }
    if (ctrl.session !== session) return;
    ctrl.films = session.queue.splice(0, FM_TARGET);
    fmUpdateStatus(ctrl);
    fmRender(ctrl, 0);
    fmUpdateMoreBtn(ctrl);
    // 「もっと見る」用の続きは表示後に裏で先読みしておく
    fmFillQueue(ctrl, FM_TARGET).then(() => { if (ctrl.session === session) fmUpdateMoreBtn(ctrl); }, () => {});
  }

  async function fmLoadMore(ctrl) {
    const btn = document.getElementById(ctrl.moreBtnId);
    const prev = ctrl.films.length;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "読み込み中…";
    try {
      if (ctrl.session.queue.length < FM_TARGET && ctrl.session.hasMore) {
        await fmFillQueue(ctrl, FM_POOL_MIN);
      }
    } catch (e) {
      document.getElementById(ctrl.statusId).innerHTML =
        e.message === "NO_SERVER" ? ctrl.hint : "取得に失敗しました: " + e.message;
      btn.disabled = false;
      btn.textContent = label;
      return;
    }
    ctrl.films.push(...ctrl.session.queue.splice(0, FM_TARGET));
    fmRender(ctrl, prev);
    fmUpdateStatus(ctrl);
    btn.disabled = false;
    btn.textContent = label;
    fmUpdateMoreBtn(ctrl);
  }

  function fmRender(ctrl, startIndex = 0) {
    const grid = document.getElementById(ctrl.gridId);
    const actions = document.getElementById(ctrl.actionsId);
    if (startIndex === 0) grid.innerHTML = "";
    if (!ctrl.films.length) {
      actions.style.display = "none";
      return;
    }
    for (let i = startIndex; i < ctrl.films.length; i++) {
      grid.appendChild(
        makePickCard(ctrl.films[i], { onToggle: () => setPickBtn(ctrl.addBtnId, ctrl.gridId) })
      );
    }
    actions.style.display = "flex";
    setPickBtn(ctrl.addBtnId, ctrl.gridId);
  }

  function fmBulkAdd(ctrl) {
    const picked = collectPicked(document.getElementById(ctrl.gridId));
    const c = addFilms(picked);
    if (c) {
      const added = new Set(picked.map((p) => normTitle(p.title)));
      ctrl.films = ctrl.films.filter((f) => !added.has(normTitle(f.title)));
      fmRender(ctrl, 0);
      fmUpdateStatus(ctrl);
      fmUpdateMoreBtn(ctrl);
      notifyBulkAdded(ctrl.addBtnId, ctrl.gridId, c);
    }
  }

  // 映画賞は Filmarks 由来（fmAward）と、Filmarks に無いものを curated titles で持つものがある。
  // クリックされた賞の種類に応じてローダーを切り替える。
  let awardMode = "fm";
  function loadAward(col) {
    if (col.fmAward) { awardMode = "fm"; fmLoad(awardCtrl, col); }
    else { awardMode = "coll"; loadCollection(col, AWARD_CTX); }
  }

  async function loadCollection(col, ctx = COLLECTION_CTX) {
    const grid = document.getElementById(ctx.gridId);
    const actions = document.getElementById(ctx.actionsId);
    grid.innerHTML = "";
    actions.style.display = "none";
    ctx.col = col;
    ctx.films = [];
    ctx.queue = col.titles.slice();
    document.querySelectorAll(`[data-panel="${ctx.panel}"] .collection-chip`).forEach((x) =>
      x.classList.toggle("active", x.dataset.col === col.id)
    );
    updateCollectionMoreBtn(ctx);
    await loadMoreCollection(ctx);
  }

  function updateCollectionMoreBtn(ctx) {
    const wrap = document.getElementById(ctx.moreWrapId);
    if (wrap) wrap.style.display = ctx.queue && ctx.queue.length ? "flex" : "none";
  }

  // 次のバッチ（COLLECTION_BATCH件）を照合してグリッドに追記する
  async function loadMoreCollection(ctx) {
    const status = document.getElementById(ctx.statusId);
    const grid = document.getElementById(ctx.gridId);
    const actions = document.getElementById(ctx.actionsId);
    const moreBtn = document.getElementById(ctx.moreBtnId);
    const col = ctx.col;
    if (!col || !ctx.queue.length) return;
    if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = "読み込み中…"; }
    const total = col.titles.length;
    const batch = ctx.queue.splice(0, COLLECTION_BATCH);
    let serverDown = false;
    // 6件ずつ並列に照合し、リスト順を保ったまま揃った分から表示する
    const found = new Array(batch.length);
    let shown = 0, next = 0;
    const flush = () => {
      while (shown < batch.length && found[shown]) {
        const film = found[shown++];
        ctx.films.push(film);
        grid.appendChild(
          makePickCard(film, {
            subtitle: film.year || "",
            onToggle: () => setPickBtn(ctx.addBtnId, ctx.gridId),
          })
        );
      }
      status.textContent = `「${col.label}」を照合中… ${ctx.films.length}/${total}`;
    };
    const worker = async () => {
      while (next < batch.length && !serverDown) {
        const i = next++;
        const t = batch[i];
        const title = typeof t === "string" ? t : t.title;
        const year = typeof t === "object" ? t.year : "";
        let results = [];
        try {
          results = await searchFilmarks(title);
        } catch (e) {
          if (e.message === "NO_SERVER") { serverDown = true; return; }
        }
        if (ctx.col !== col) return;
        let m = pickPosterMatch(results, title, year);
        if (!m && results[0]) m = results[0];
        // 年が指定されている作品（受賞作リストなど）は、日本公開年やリメイク版に
        // 引きずられないよう、指定された製作年を優先して表示する
        found[i] = m
          ? { title: m.title || title, poster: m.poster || "", year: year || m.year || "", filmarksId: m.filmarksId, collection: col.label }
          : { title, poster: "", year: year || "", collection: col.label };
        flush();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (ctx.col !== col) return;
    if (serverDown) {
      status.innerHTML =
        "照合にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行してください。";
      if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = "もっと見る"; }
      return;
    }
    actions.style.display = ctx.films.length ? "flex" : "none";
    setPickBtn(ctx.addBtnId, ctx.gridId);
    status.textContent = ctx.queue.length
      ? `「${col.label}」${ctx.films.length}/${total}作品を表示中。観た作品をタップして選べます。「もっと見る」で残りを表示。`
      : `「${col.label}」${ctx.films.length}作品。観た作品をタップして選び、まとめて追加できます。`;
    updateCollectionMoreBtn(ctx);
    if (moreBtn) { moreBtn.disabled = false; moreBtn.textContent = "もっと見る"; }
  }

  function renderCollectionGrid(ctx = COLLECTION_CTX) {
    const grid = document.getElementById(ctx.gridId);
    const actions = document.getElementById(ctx.actionsId);
    grid.innerHTML = "";
    if (!ctx.films.length) {
      actions.style.display = "none";
      return;
    }
    ctx.films.forEach((f) =>
      grid.appendChild(
        makePickCard(f, {
          subtitle: f.year || "",
          onToggle: () => setPickBtn(ctx.addBtnId, ctx.gridId),
        })
      )
    );
    actions.style.display = "flex";
    setPickBtn(ctx.addBtnId, ctx.gridId);
  }

  function bulkAddCollection(ctx = COLLECTION_CTX) {
    const c = addFilms(collectPicked(document.getElementById(ctx.gridId)));
    if (c) {
      renderCollectionGrid(ctx);
      notifyBulkAdded(ctx.addBtnId, ctx.gridId, c);
    }
  }

  // =======================================================================
  // PNG Export
  // =======================================================================
  async function exportPng() {
    if (!window.htmlToImage) {
      toast("画像ライブラリの読み込みに失敗しました（ネット接続を確認）");
      return;
    }
    const title = currentName();
    el.tierExportTitle.textContent = title || "Pickture";
    el.tierExportTitle.style.display = "block";
    try {
      toast("画像を生成中…");
      const dataUrl = await window.htmlToImage.toPng(el.tierBoard, {
        pixelRatio: 2,
        backgroundColor: "#171a21",
        cacheBust: true,
        includeQueryParams: true,
      });
      const a = document.createElement("a");
      a.download = (title || "cinema-tier-list") + ".png";
      a.href = dataUrl;
      a.click();
      toast("画像を保存しました");
    } catch (e) {
      console.error(e);
      toast("画像化に失敗しました。外部URLのポスターはCORSで失敗する場合があります。");
    } finally {
      el.tierExportTitle.style.display = "none";
    }
  }

  // =======================================================================
  // SNS共有カード（テーマごとに「ベストN」「ティア表」の画像を作る）
  // =======================================================================
  const SHARE_SIZES = {
    story: { w: 540, h: 960, out: 1080 },
    post: { w: 540, h: 675, out: 1080 },
    wide: { w: 800, h: 450, out: 1200 },
  };
  const share = {
    mode: "best",
    count: 5,
    size: "story",
    style: "cream",
    title: "",
    rankIds: null, // ランキング画面から開いたときの暫定順位
    blob: null,
    seq: 0,
  };

  function loadShareSettings() {
    try {
      const s = JSON.parse(localStorage.getItem("pickture-share") || "{}");
      ["mode", "size", "style"].forEach((k) => { if (typeof s[k] === "string") share[k] = s[k]; });
      if ([3, 5, 10].includes(s.count)) share.count = s.count;
    } catch (_) {}
  }
  function saveShareSettings() {
    try {
      localStorage.setItem("pickture-share", JSON.stringify(
        { mode: share.mode, count: share.count, size: share.size, style: share.style }));
    } catch (_) {}
  }

  function shareThemeName() {
    return themeFilterName() || currentName() || "わたしの映画";
  }

  // ベスト用の並び：保存済みランキング → ティア上位順（未分類は除く）
  function shareBestIds() {
    if (share.rankIds) return share.rankIds.slice();
    const tierIds = [];
    state.tiers.forEach((t) => (t.items || []).forEach((m) => { if (matchesFilter(m)) tierIds.push(m.id); }));
    const key = rankKey();
    const saved = key && state.rankings && Array.isArray(state.rankings[key]) ? state.rankings[key] : [];
    const valid = new Set(allMovies().filter(matchesFilter).map((m) => m.id));
    const ids = saved.filter((id) => valid.has(id));
    const seen = new Set(ids);
    tierIds.forEach((id) => { if (!seen.has(id)) ids.push(id); });
    return ids;
  }

  function shareTierRows() {
    return state.tiers
      .map((t) => ({ tier: t, items: (t.items || []).filter(matchesFilter) }))
      .filter((r) => r.items.length);
  }

  function sharePosterSrc(src) {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
    try {
      const u = new URL(src, location.href);
      if (u.origin === location.origin) return src;
    } catch (_) { return src; }
    // 書き出し時にキャンバスが汚染されないよう、同一オリジンのプロキシ経由で読む
    return /^https?:/.test(location.protocol) ? "/api/img?u=" + encodeURIComponent(src) : src;
  }

  function sharePoster(m, cls) {
    const box = document.createElement("div");
    box.className = "sc-poster " + (cls || "");
    const src = sharePosterSrc(m.poster);
    if (src) {
      const img = document.createElement("img");
      img.crossOrigin = "anonymous";
      img.alt = "";
      img.addEventListener("error", () => {
        if (!img.dataset.retried && m.poster && img.src.includes("/api/img")) {
          img.dataset.retried = "1";
          img.src = m.poster;
          return;
        }
        img.remove();
        box.classList.add("sc-poster-fb");
        box.textContent = m.title || "";
      });
      img.src = src;
      box.appendChild(img);
    } else {
      box.classList.add("sc-poster-fb");
      box.textContent = m.title || "";
    }
    return box;
  }

  function textColorOn(hex) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return "#fff";
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1d1a16" : "#fff";
  }

  function shareDateStr() {
    const d = new Date();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  }

  function buildShareCard() {
    const sz = SHARE_SIZES[share.size] || SHARE_SIZES.story;
    const card = document.createElement("div");
    card.className = `sc sc-${share.size} sc-${share.style}`;
    card.style.width = sz.w + "px";
    card.style.height = sz.h + "px";

    const isBest = share.mode === "best";
    const ids = isBest ? shareBestIds() : [];
    const rows = isBest ? [] : shareTierRows();
    const total = isBest ? ids.length : rows.reduce((a, r) => a + r.items.length, 0);
    const n = Math.min(share.count, ids.length);
    const kicker = isBest ? `MY BEST ${n || share.count}` : "MY TIER LIST";
    const sub = isBest
      ? (total > n ? `${total}本の中から選んだベスト${n}` : `ベスト${n}`)
      : `${total}本をランク付け`;

    card.innerHTML =
      `<div class="sc-head">` +
        `<div class="sc-kicker">${kicker}</div>` +
        `<div class="sc-title">${escapeHtml(share.title || shareThemeName())}</div>` +
        `<div class="sc-sub">${escapeHtml(sub)}</div>` +
      `</div>` +
      `<div class="sc-body"></div>` +
      `<div class="sc-foot">` +
        `<span class="sc-brand"><img src="icon.svg" alt="" /><span><b>Pick</b>ture</span></span>` +
        `<span class="sc-date">${shareDateStr()}</span>` +
      `</div>`;
    return { card, ids: ids.slice(0, n), rows, total };
  }

  // 幅w・高さh に n 枚（ポスター＋下にタイトル）を最大サイズで敷き詰める
  function fitGrid(w, h, n, gap, extraH) {
    let best = { p: 20, cols: n };
    for (let p = 20; p <= 400; p++) {
      const cols = Math.max(1, Math.floor((w + gap) / (p + gap)));
      const lines = Math.ceil(n / cols);
      if (lines * (p * 1.5 + extraH + gap) - gap > h) break;
      best = { p, cols };
    }
    return best;
  }

  function renderShareBest(body, ids) {
    body.classList.add("sc-best");
    if (!ids.length) {
      body.innerHTML = `<div class="sc-empty">ティアに振り分けた作品がありません</div>`;
      return;
    }
    const W = body.clientWidth, H = body.clientHeight;
    const wide = share.size === "wide";
    const movies = ids.map((id) => (findMovie(id) || {}).movie).filter(Boolean);
    const [first, ...rest] = movies;

    const hero = document.createElement("div");
    hero.className = "sc-hero";
    const restArea = document.createElement("div");
    restArea.className = "sc-rest";
    body.appendChild(hero);
    if (rest.length) body.appendChild(restArea);

    const gap = 10, titleH = 30;
    let heroW, heroH, posterW, restW, restH;
    if (wide) {
      heroW = rest.length ? Math.round(W * 0.42) : W;
      heroH = H;
      posterW = Math.min(Math.round(H / 1.5), Math.round(heroW * 0.55));
      restW = W - heroW - 18; restH = H;
      body.style.flexDirection = "row";
    } else {
      // 1位はできるだけ大きく、2位以下が小さくなりすぎない範囲で決める
      const minP = share.size === "post" ? 64 : rest.length > 4 ? 78 : 100;
      restW = W;
      posterW = Math.round(W * 0.56);
      for (; posterW > 80; posterW -= 4) {
        if (!rest.length) { if (posterW * 1.5 <= H) break; continue; }
        const rh = H - posterW * 1.5 - 18;
        if (rh > 0 && fitGrid(restW, rh, rest.length, gap, titleH).p >= minP) break;
      }
      heroW = W;
      heroH = Math.round(posterW * 1.5);
      restH = rest.length ? H - heroH - 18 : 0;
      body.style.justifyContent = "center";
    }
    hero.style.width = heroW + "px";
    hero.style.height = heroH + "px";
    const hp = sharePoster(first, "sc-hero-poster");
    hp.style.width = posterW + "px";
    hp.style.height = Math.round(posterW * 1.5) + "px";
    hero.appendChild(hp);
    const info = document.createElement("div");
    info.className = "sc-hero-info";
    info.innerHTML =
      `<div class="sc-rank1">1<small>st</small></div>` +
      `<div class="sc-hero-title">${escapeHtml(first.title || "")}</div>` +
      (first.year ? `<div class="sc-hero-year">${escapeHtml(String(first.year))}</div>` : "");
    hero.appendChild(info);

    if (!rest.length) return;
    restArea.style.width = restW + "px";
    restArea.style.height = restH + "px";
    const { p, cols } = fitGrid(restW, restH, rest.length, gap, titleH);
    if (!wide) restArea.style.height = Math.ceil(rest.length / cols) * (p * 1.5 + titleH + gap) - gap + "px";
    restArea.style.gridTemplateColumns = `repeat(${cols}, ${p}px)`;
    restArea.style.gap = gap + "px";
    rest.forEach((m, i) => {
      const it = document.createElement("div");
      it.className = "sc-item";
      const ps = sharePoster(m);
      ps.style.width = p + "px";
      ps.style.height = Math.round(p * 1.5) + "px";
      const badge = document.createElement("span");
      badge.className = "sc-rank" + (i < 2 ? " sc-rank-top" : "");
      badge.textContent = String(i + 2);
      ps.appendChild(badge);
      const t = document.createElement("div");
      t.className = "sc-item-title";
      t.textContent = m.title || "";
      it.appendChild(ps);
      it.appendChild(t);
      restArea.appendChild(it);
    });
  }

  function renderShareTier(body, rows) {
    body.classList.add("sc-tiers");
    if (!rows.length) {
      body.innerHTML = `<div class="sc-empty">ティアに振り分けた作品がありません</div>`;
      return;
    }
    const W = body.clientWidth, H = body.clientHeight;
    // 横長はティアを列として横に並べる（縦に積むとポスターが小さくなりすぎるため）
    const cols = share.size === "wide";
    if (cols) body.classList.add("sc-tiers-cols");
    const gap = 4, rowGap = 6, pad = 6;
    const labelW = 48, labelH = 30;
    const colW = (W - rowGap * (rows.length - 1)) / rows.length;
    const areaW = cols ? colW - pad * 2 - 2 : W - labelW - pad * 2 - 2;
    const perLine = (p) => Math.max(1, Math.floor((areaW + gap) / (p + gap)));
    const blockH = (p, c) => Math.max(1, Math.ceil(c / perLine(p))) * (p * 1.5 + gap) - gap + pad * 2 + 2;
    const heightFor = (p, counts) => cols
      ? Math.max(...counts.map((c) => blockH(p, c) + labelH))
      : counts.reduce((a, c) => a + Math.max(blockH(p, c), 40), 0) + rowGap * (counts.length - 1);
    const full = rows.map((r) => r.items.length);
    let p = 24;
    for (let q = 24; q <= 160; q++) {
      if (q > areaW) break;
      if (heightFor(q, full) > H) break;
      p = q;
    }
    // 最小サイズでも入らなければ、本数の多い段から1行ずつ削って「+N」にまとめる
    const shown = full.slice();
    const k = perLine(p);
    let guard = 500;
    while (heightFor(p, shown) > H && guard--) {
      let idx = 0;
      shown.forEach((c, i) => { if (c > shown[idx]) idx = i; });
      if (shown[idx] <= k) break;
      shown[idx] = (Math.ceil(shown[idx] / k) - 1) * k;
    }
    rows.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "sc-trow";
      if (cols) row.style.width = colW + "px";
      const lab = document.createElement("div");
      lab.className = "sc-tlabel";
      if (cols) lab.style.height = labelH + "px";
      else lab.style.width = labelW + "px";
      lab.style.background = r.tier.color;
      lab.style.color = textColorOn(r.tier.color);
      lab.textContent = r.tier.label;
      const zone = document.createElement("div");
      zone.className = "sc-tzone";
      zone.style.gap = gap + "px";
      zone.style.padding = pad + "px";
      const cut = shown[i] < r.items.length;
      const visible = cut ? r.items.slice(0, shown[i] - 1) : r.items;
      visible.forEach((m) => {
        const ps = sharePoster(m);
        ps.style.width = p + "px";
        ps.style.height = Math.round(p * 1.5) + "px";
        zone.appendChild(ps);
      });
      if (cut) {
        const more = document.createElement("div");
        more.className = "sc-poster sc-more";
        more.style.width = p + "px";
        more.style.height = Math.round(p * 1.5) + "px";
        more.textContent = `+${r.items.length - visible.length}`;
        zone.appendChild(more);
      }
      row.appendChild(lab);
      row.appendChild(zone);
      body.appendChild(row);
    });
  }

  // html-to-image 標準のWebフォント埋め込みは Google Fonts を読めず数秒かかるだけなので、
  // 英字部分（Montserrat）だけ必要な文字に絞って自前で埋め込む。和文は端末のフォント。
  let shareFontPromise = null;
  function shareFontCSS() {
    if (shareFontPromise) return shareFontPromise;
    const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    const toData = (url) => fetch(url).then((r) => r.blob()).then((b) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    }));
    shareFontPromise = fetch("https://fonts.googleapis.com/css2?family=Montserrat:wght@500;700&text=" + encodeURIComponent(chars))
      .then((r) => r.text())
      .then(async (css) => {
        const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/["']/g, "")))];
        const datas = await Promise.all(urls.map(toData));
        urls.forEach((u, i) => { css = css.split(u).join(datas[i]); });
        return css;
      })
      .catch(() => "");
    return shareFontPromise;
  }

  function waitImages(root) {
    const imgs = [...root.querySelectorAll("img")];
    return Promise.all(imgs.map((img) => (img.complete && img.naturalWidth) ? null : new Promise((res) => {
      const done = () => { img.removeEventListener("load", done); img.removeEventListener("error", done); res(); };
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      setTimeout(res, 8000);
    }))).then(() => new Promise((r) => setTimeout(r, 60)));
  }

  function defaultShareText(ids, rows) {
    const theme = share.title || shareThemeName();
    const tags = "#Pickture #映画好きと繋がりたい";
    if (share.mode === "best") {
      const marks = ["🥇", "🥈", "🥉"];
      const lines = ids.slice(0, 5).map((id, i) => {
        const m = (findMovie(id) || {}).movie;
        return m ? `${marks[i] || i + 1 + "."} ${m.title}` : "";
      }).filter(Boolean);
      const more = ids.length > 5 ? `\n…ほか${ids.length - 5}本` : "";
      return `「${theme}」わたしのベスト${ids.length}🎬\n${lines.join("\n")}${more}\n${tags}`;
    }
    const top = rows[0];
    const topLine = top
      ? `\n${top.tier.label}：${top.items.slice(0, 3).map((m) => m.title).join("、")}${top.items.length > 3 ? " ほか" : ""}`
      : "";
    const total = rows.reduce((a, r) => a + r.items.length, 0);
    return `「${theme}」${total}本をティア表でランク付けしました🎬${topLine}\n${tags}`;
  }

  let shareTextTouched = false;

  async function renderSharePreview() {
    const seq = ++share.seq;
    share.blob = null;
    setShareBusy(true);
    syncShareControls();
    const wrap = document.getElementById("sharePreview");
    const sz = SHARE_SIZES[share.size] || SHARE_SIZES.story;
    const { card, ids, rows } = buildShareCard();
    wrap.innerHTML = "";
    const scaler = document.createElement("div");
    scaler.className = "share-scaler";
    scaler.appendChild(card);
    wrap.appendChild(scaler);
    const scale = Math.min(1, (wrap.clientWidth || sz.w) / sz.w, (wrap.clientHeight || sz.h) / sz.h);
    scaler.style.transform = `translate(-50%, -50%) scale(${scale})`;
    scaler.style.width = sz.w + "px";
    scaler.style.height = sz.h + "px";
    const body = card.querySelector(".sc-body");
    if (share.mode === "best") renderShareBest(body, ids);
    else renderShareTier(body, rows);

    if (!shareTextTouched) document.getElementById("shareText").value = defaultShareText(ids, rows);

    await waitImages(card);
    if (seq !== share.seq) return;
    if (!window.htmlToImage) { setShareBusy(false, "画像ライブラリを読み込めませんでした（ネット接続を確認）"); return; }
    try {
      const fontEmbedCSS = await shareFontCSS();
      if (seq !== share.seq) return;
      const blob = await window.htmlToImage.toBlob(card, {
        pixelRatio: sz.out / sz.w,
        cacheBust: false,
        includeQueryParams: true,
        fontEmbedCSS,
        backgroundColor: share.style === "dark" ? "#141210" : "#f4eee2",
      });
      if (seq !== share.seq) return;
      share.blob = blob;
      setShareBusy(false);
    } catch (e) {
      console.error(e);
      if (seq === share.seq) setShareBusy(false, "画像化に失敗しました。外部URLのポスターが読めない場合があります。");
    }
  }

  function setShareBusy(busy, err) {
    ["shareNativeBtn", "shareXBtn", "shareSaveBtn"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = busy || !!err;
    });
    const hint = document.getElementById("shareHint");
    if (!hint) return;
    if (err) hint.textContent = err;
    else if (busy) hint.textContent = "画像を準備中…";
    else hint.textContent = canShareFiles()
      ? "「アプリで共有」から X・Instagram・LINE などへ画像付きで送れます。"
      : "「𝕏 でポスト」は画像を保存してから投稿画面を開きます。画像を添付して投稿してください。";
  }

  function canShareFiles() {
    try {
      const f = new File([new Blob(["x"], { type: "image/png" })], "x.png", { type: "image/png" });
      return !!(navigator.canShare && navigator.canShare({ files: [f] }));
    } catch (_) { return false; }
  }

  function syncShareControls() {
    document.querySelectorAll("#shareModal .share-seg").forEach((seg) => {
      const key = seg.dataset.opt;
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", String(share[key]) === b.dataset.v));
    });
    const countOpt = document.getElementById("shareCountOpt");
    if (countOpt) countOpt.classList.toggle("hidden", share.mode !== "best");
    const native = document.getElementById("shareNativeBtn");
    if (native) native.classList.toggle("hidden", !canShareFiles());
  }

  function shareFileName() {
    const base = (share.title || shareThemeName()).replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || "pickture";
    return `${base}-${share.mode === "best" ? "best" : "tier"}.png`;
  }

  function downloadShareImage() {
    if (!share.blob) return false;
    const url = URL.createObjectURL(share.blob);
    const a = document.createElement("a");
    a.download = shareFileName();
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  async function shareNative() {
    if (!share.blob) return;
    const file = new File([share.blob], shareFileName(), { type: "image/png" });
    try {
      await navigator.share({ files: [file], text: document.getElementById("shareText").value });
    } catch (e) {
      if (e && e.name !== "AbortError") { console.error(e); toast("共有できませんでした。画像を保存して投稿してください"); }
    }
  }

  function shareToX() {
    downloadShareImage();
    const text = document.getElementById("shareText").value;
    window.open("https://x.com/intent/post?text=" + encodeURIComponent(text), "_blank", "noopener");
    toast("画像を保存しました。投稿画面で画像を添付してください");
  }

  async function copyShareText() {
    const text = document.getElementById("shareText").value;
    try {
      await navigator.clipboard.writeText(text);
      toast("投稿文をコピーしました");
    } catch (_) {
      const ta = document.getElementById("shareText");
      ta.select();
      document.execCommand("copy");
      toast("投稿文をコピーしました");
    }
  }

  function openShareModal(opts = {}) {
    loadShareSettings();
    share.rankIds = opts.rankIds || null;
    if (opts.mode) share.mode = opts.mode;
    share.title = shareThemeName();
    shareTextTouched = false;
    const input = document.getElementById("shareTitleInput");
    if (input) input.value = share.title;
    const note = document.getElementById("shareThemeNote");
    if (note) {
      note.innerHTML = hasFilter()
        ? `テーマ：<b>${escapeHtml(themeFilterName())}</b>`
        : `テーマ：<b>すべての作品</b><span>（「テーマで絞り込み」で選ぶと、そのテーマの画像になります）</span>`;
    }
    openModal("shareModal");
    renderSharePreview();
  }

  function wireShare() {
    const btn = document.getElementById("shareThemeBtn");
    if (btn) btn.addEventListener("click", () => openShareModal());
    const rankBtn = document.getElementById("rankShareBtn");
    if (rankBtn) rankBtn.addEventListener("click", () => openShareModal({ mode: "best", rankIds: rankOrder.slice() }));
    document.querySelectorAll("#shareModal .share-seg").forEach((seg) => {
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        const key = seg.dataset.opt;
        share[key] = key === "count" ? Number(b.dataset.v) : b.dataset.v;
        saveShareSettings();
        renderSharePreview();
      });
    });
    const input = document.getElementById("shareTitleInput");
    let t = null;
    if (input) input.addEventListener("input", () => {
      share.title = input.value.trim();
      clearTimeout(t);
      t = setTimeout(renderSharePreview, 350);
    });
    const ta = document.getElementById("shareText");
    if (ta) ta.addEventListener("input", () => { shareTextTouched = true; });
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
    on("shareNativeBtn", shareNative);
    on("shareXBtn", shareToX);
    on("shareSaveBtn", () => { if (downloadShareImage()) toast("画像を保存しました"); });
    on("shareCopyBtn", copyShareText);
    let rt = null;
    window.addEventListener("resize", () => {
      const m = document.getElementById("shareModal");
      if (!m || m.classList.contains("hidden")) return;
      clearTimeout(rt);
      rt = setTimeout(renderSharePreview, 250);
    });
  }


  // =======================================================================
  // Data import / export
  // =======================================================================
  function downloadJson(json, name) {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/\.json$/i, "") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 保存したファイル名（拡張子なし）をヘッダー表示名として反映
  function setFileName(name) {
    const clean = (name || "").replace(/\.json$/i, "").trim();
    if (!clean) return;
    state.fileName = clean;
    saveState();
    updateTitleDisplay();
  }

  async function exportData() {
    const json = JSON.stringify(state, null, 2);
    const defaultName = currentName() || "cinema-tier-list";

    // 対応ブラウザ(Chrome/Edge等)ではネイティブの保存ダイアログでファイル名を指定
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName + ".json",
          types: [{
            description: "Tier List データ",
            accept: { "application/json": [".json"] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        setFileName(handle.name || defaultName);
        toast("ファイルを保存しました（後から「開く」で再編集できます）");
      } catch (e) {
        if (e && e.name === "AbortError") return; // ユーザーがキャンセル
        downloadJson(json, defaultName); // 失敗時はダウンロードにフォールバック
        toast("ファイルを保存しました（後から「開く」で再編集できます）");
      }
      return;
    }

    // 非対応ブラウザ(Firefox/Safari等)は入力プロンプトでファイル名を指定
    const name = window.prompt("保存するファイル名を入力してください", defaultName);
    if (name === null) return; // キャンセル
    const finalName = name.trim() || defaultName;
    downloadJson(json, finalName);
    setFileName(finalName);
    toast("ファイルを保存しました（後から「開く」で再編集できます）");
  }

  // 「保存」ボタンのドロップダウン（.json / PNG を1つのボタンに集約）
  let currentSaveMenu = null;
  function closeSaveMenu() {
    if (!currentSaveMenu) return;
    currentSaveMenu.remove();
    currentSaveMenu = null;
    document.removeEventListener("mousedown", onDocClickForSaveMenu, true);
  }
  function onDocClickForSaveMenu(e) {
    if (currentSaveMenu && !currentSaveMenu.contains(e.target) && e.target.id !== "saveMenuBtn") {
      closeSaveMenu();
    }
  }
  function openSaveMenu(anchorEl) {
    if (currentSaveMenu) {
      closeSaveMenu();
      return;
    }
    const pop = document.createElement("div");
    pop.className = "save-menu";
    pop.innerHTML =
      `<button class="save-menu-item" data-act="json"><span class="smi-ic">💾</span>` +
      `<span class="smi-t"><b>ファイルとして保存</b><small>後から再編集できる .json ファイル</small></span></button>` +
      `<button class="save-menu-item" data-act="png"><span class="smi-ic">📷</span>` +
      `<span class="smi-t"><b>画像として保存</b><small>共有しやすい PNG 画像</small></span></button>`;
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    let left = r.left;
    const top = r.bottom + 6;
    if (left + pop.offsetWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pop.offsetWidth - 8);
    }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.querySelectorAll(".save-menu-item").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        closeSaveMenu();
        if (act === "json") exportData();
        else exportPng();
      });
    });
    currentSaveMenu = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocClickForSaveMenu, true), 0);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.tiers)) throw new Error("invalid");
        state = parsed;
        if (!Array.isArray(state.pool)) state.pool = [];
        if (!Array.isArray(state.watchlist)) state.watchlist = [];
        // 開いたファイル名（拡張子なし）をヘッダー表示名として保持
        state.fileName = (file.name || "").replace(/\.json$/i, "").trim();
        saveState();
        render();
        toast("データを読み込みました");
        closeModal("settingsModal");
      } catch (e) {
        toast("読み込みに失敗しました（JSON形式を確認）");
      }
    };
    reader.readAsText(file);
  }

  // =======================================================================
  // Modals & UI wiring
  // =======================================================================
  // =======================================================================
  // 統計ダッシュボード
  // =======================================================================
  function computeStats() {
    const movies = allMovies();
    const total = movies.length;
    const ranked = state.tiers.reduce((n, t) => n + t.items.length, 0);
    const unranked = state.pool.length;

    const dirCount = new Map();
    const actCount = new Map();
    const decadeCount = new Map();
    const kindCount = new Map();
    const genreCount = new Map();
    const genreSet = new Set(GENRES.map((g) => g.label));
    const currentYear = new Date().getFullYear();
    let withYear = 0;
    let minYear = Infinity;
    let maxYear = -Infinity;
    let yearSum = 0;
    let recentCount = 0; // 直近10年
    let classicCount = 0; // 2000年より前
    let pre1970Count = 0; // 1970年より前
    let pre1950Count = 0; // 1950年より前
    let posterMissing = 0;

    movies.forEach((m) => {
      if (m.meta) {
        (m.meta.directors || []).forEach((d) => dirCount.set(d, (dirCount.get(d) || 0) + 1));
        (m.meta.cast || []).forEach((c) => actCount.set(c, (actCount.get(c) || 0) + 1));
      }
      const y = parseInt(m.year, 10);
      if (y) {
        withYear++;
        yearSum += y;
        if (y < minYear) minYear = y;
        if (y > maxYear) maxYear = y;
        if (y >= currentYear - 9) recentCount++;
        if (y < 2000) classicCount++;
        if (y < 1970) pre1970Count++;
        if (y < 1950) pre1950Count++;
        const dec = Math.floor(y / 10) * 10;
        decadeCount.set(dec, (decadeCount.get(dec) || 0) + 1);
      }
      if (m.kind) kindCount.set(m.kind, (kindCount.get(m.kind) || 0) + 1);
      const gset = new Set(m.genres || []);
      movieCollections(m).forEach((l) => { if (genreSet.has(l)) gset.add(l); });
      gset.forEach((l) => genreCount.set(l, (genreCount.get(l) || 0) + 1));
      if (!m.poster || !String(m.poster).trim()) posterMissing++;
    });

    const kc = (k) => kindCount.get(k) || 0;
    const jpCount = kc("jp_live") + kc("jp_anime");
    const foreignCount = kc("foreign_live") + kc("foreign_anime");
    const liveCount = kc("jp_live") + kc("foreign_live");
    const animeCount = kc("jp_anime") + kc("foreign_anime");
    const classifiedKind = jpCount + foreignCount;
    const minKindCount = Math.min(kc("jp_live"), kc("foreign_live"), kc("jp_anime"), kc("foreign_anime"));

    const dirVals = [...dirCount.values()];
    const actVals = [...actCount.values()];
    const genreVals = [...genreCount.values()];
    const decVals = [...decadeCount.values()];
    const maxOf = (arr) => (arr.length ? Math.max.apply(null, arr) : 0);
    const dirMax = maxOf(dirVals);
    const actMax = maxOf(actVals);
    const dirGe3 = dirVals.filter((v) => v >= 3).length;
    const dirGe5 = dirVals.filter((v) => v >= 5).length;
    const actGe3 = actVals.filter((v) => v >= 3).length;
    const actGe5 = actVals.filter((v) => v >= 5).length;
    const maxGenreCount = maxOf(genreVals);
    const maxDecadeCount = maxOf(decVals);

    // ティア分布（定義順）＋ 未分類
    const tierDist = state.tiers.map((t) => ({
      label: t.label, count: t.items.length, color: t.color,
    }));
    tierDist.push({ label: "未分類", count: unranked, color: "#5b6272" });

    const decades = [...decadeCount.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dec, n]) => ({ label: `${dec}年代`, count: n }));

    const KIND_COLORS = {
      jp_live: "#5b8cff", foreign_live: "#ff9f5b",
      jp_anime: "#57d9a3", foreign_anime: "#c78bff",
    };
    const kinds = KIND_DEFS
      .filter(([k]) => kindCount.get(k))
      .map(([k, label]) => ({ label, count: kindCount.get(k), color: KIND_COLORS[k] }));

    const topGenres = [...genreCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([label, n]) => ({ label, count: n }));

    const rankPersons = (counts) =>
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([label, n]) => ({ label, count: n }));

    return {
      total, ranked, unranked, posterMissing, withYear,
      dirTotal: dirCount.size, actTotal: actCount.size,
      minYear: withYear ? minYear : null,
      maxYear: withYear ? maxYear : null,
      avgYear: withYear ? Math.round(yearSum / withYear) : null,
      recentCount, classicCount, pre1970Count, pre1950Count, currentYear,
      jpCount, foreignCount, liveCount, animeCount, classifiedKind, minKindCount,
      genreTotal: genreCount.size,
      maxGenreCount, maxDecadeCount,
      dirMax, actMax, dirGe3, dirGe5, actGe3, actGe5,
      tierDist, decades, kinds, topGenres,
      topDirectors: rankPersons(dirCount),
      topActors: rankPersons(actCount),
    };
  }

  // 登録傾向・ティア分類の傾向を自然文で組み立てる
  function buildInsights(s) {
    const out = [];
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

    // ランク付けの進み具合
    out.push({
      icon: "🗂️",
      text: `登録 ${s.total} 本のうち ${s.ranked} 本（${pct(s.ranked, s.total)}%）をランク付け済み。` +
        (s.unranked ? `未分類が ${s.unranked} 本（${pct(s.unranked, s.total)}%）残っています。` : "すべて分類済みです。"),
    });

    // 最上位ティアへの集中度（評価の甘さ/厳しさ）
    const top = state.tiers[0];
    const topCount = top ? top.items.length : 0;
    if (s.ranked && top) {
      const share = pct(topCount, s.ranked);
      out.push({
        icon: "🏆",
        text: `最上位「${top.label}」ティアは ${topCount} 本（ランク付けの ${share}%）。` +
          (share >= 40 ? "高評価に寄せる“甘め”の傾向です。"
            : share <= 15 ? "トップを絞る“辛口”の傾向です。"
            : "上下バランスよく分類できています。"),
      });
    }

    // 好みのジャンル
    if (s.topGenres.length) {
      const g = s.topGenres[0];
      const others = s.topGenres.slice(1, 3).map((x) => x.label).join("・");
      out.push({
        icon: "🎬",
        text: `最も多いジャンルは「${g.label}」で ${g.count} 本（全体の ${pct(g.count, s.total)}%）。` +
          (others ? `次いで ${others} が続きます。` : ""),
      });
    }

    // 邦画 / 洋画 の比率
    if (s.classifiedKind) {
      const jpP = pct(s.jpCount, s.classifiedKind);
      const foP = pct(s.foreignCount, s.classifiedKind);
      const lean = jpP > foP ? `邦画寄り（邦画 ${jpP}% / 洋画 ${foP}%）`
        : foP > jpP ? `洋画寄り（洋画 ${foP}% / 邦画 ${jpP}%）`
        : `邦画・洋画が半々（各 ${jpP}%）`;
      let animePart = "";
      if (s.animeCount) {
        animePart = `アニメは ${s.animeCount} 本（種別判明分の ${pct(s.animeCount, s.classifiedKind)}%）。`;
      }
      out.push({ icon: "🌏", text: `種別が判明している ${s.classifiedKind} 本は${lean}。${animePart}` });
    }

    // 年代の傾向
    if (s.withYear) {
      out.push({
        icon: "🗓️",
        text: `平均公開年は ${s.avgYear} 年。直近10年の作品が ${pct(s.recentCount, s.withYear)}%、` +
          `2000年より前の作品が ${pct(s.classicCount, s.withYear)}%。` +
          (s.minYear ? `${s.minYear}〜${s.maxYear}年（${s.maxYear - s.minYear + 1}年分）をカバーしています。` : ""),
      });
    }

    // 偏愛の監督・俳優
    if (s.topDirectors[0] && s.topDirectors[0].count >= 2) {
      const d = s.topDirectors[0];
      out.push({ icon: "🎥", text: `よく登録している監督は「${d.label}」（${d.count}本）。作家性で選ぶ傾向がうかがえます。` });
    }
    if (s.topActors[0] && s.topActors[0].count >= 2) {
      const a = s.topActors[0];
      out.push({ icon: "⭐", text: `よく登録している出演者は「${a.label}」（${a.count}本）。` });
    }

    // 最上位ティアの中身の傾向（高評価作の特徴）
    if (top && top.items.length) {
      const gc = new Map();
      const gset0 = new Set(GENRES.map((g) => g.label));
      let ys = 0, yn = 0;
      top.items.forEach((m) => {
        const gs = new Set(m.genres || []);
        movieCollections(m).forEach((l) => { if (gset0.has(l)) gs.add(l); });
        gs.forEach((l) => gc.set(l, (gc.get(l) || 0) + 1));
        const y = parseInt(m.year, 10);
        if (y) { ys += y; yn++; }
      });
      const topG = [...gc.entries()].sort((a, b) => b[1] - a[1])[0];
      const tAvg = yn ? Math.round(ys / yn) : null;
      let text = `高評価（${top.label}ティア）に多いのは`;
      text += topG ? `「${topG[0]}」ジャンル。` : "特定ジャンルへの偏りは小さめ。";
      if (tAvg && s.avgYear) {
        const diff = tAvg - s.avgYear;
        text += `平均公開年は ${tAvg} 年で、全体（${s.avgYear}年）より` +
          (Math.abs(diff) <= 1 ? "ほぼ同水準です。" : diff > 0 ? `${diff}年新しめです。` : `${-diff}年古めです。`);
      }
      out.push({ icon: "💎", text });
    }

    return out;
  }

  // =======================================================================
  // 実績・マイルストーン
  // =======================================================================
  const prog = (goal, key) => (a) => ({ cur: a[key], goal });
  const ACHIEVEMENTS = [
    // --- 登録数（ボリューム） ---
    { id: "first", icon: "🎬", title: "はじめの一歩", desc: "最初の1本を登録", check: (a) => a.total >= 1, progress: prog(1, "total") },
    { id: "c500", icon: "📀", title: "コレクター", desc: "500本を登録", check: (a) => a.total >= 500, progress: prog(500, "total") },
    { id: "c1000", icon: "🍿", title: "愛好家", desc: "1000本を登録", check: (a) => a.total >= 1000, progress: prog(1000, "total") },
    { id: "c2000", icon: "💯", title: "二千本の頂", desc: "2000本を登録", check: (a) => a.total >= 2000, progress: prog(2000, "total") },
    { id: "c3000", icon: "📚", title: "ライブラリアン", desc: "3000本を登録", check: (a) => a.total >= 3000, progress: prog(3000, "total") },
    { id: "c5000", icon: "🗄️", title: "アーカイブ", desc: "5000本を登録", check: (a) => a.total >= 5000, progress: prog(5000, "total") },
    { id: "c7500", icon: "🏛️", title: "シネマテーク", desc: "7500本を登録", check: (a) => a.total >= 7500, progress: prog(7500, "total") },
    { id: "c10000", icon: "👑", title: "シネフィル", desc: "1万本を登録", check: (a) => a.total >= 10000, progress: prog(10000, "total") },
    { id: "c15000", icon: "🌟", title: "レジェンド", desc: "1万5千本を登録", check: (a) => a.total >= 15000, progress: prog(15000, "total") },
    { id: "c20000", icon: "🪐", title: "生ける映画事典", desc: "2万本を登録", check: (a) => a.total >= 20000, progress: prog(20000, "total") },
    { id: "c30000", icon: "🌌", title: "映画の神", desc: "3万本を登録", check: (a) => a.total >= 30000, progress: prog(30000, "total") },

    // --- 整理・キュレーション ---
    { id: "ranked1000", icon: "✅", title: "整理整頓", desc: "1000本以上を、未分類ゼロに", check: (a) => a.total >= 1000 && a.unranked === 0 },
    { id: "ranked3000", icon: "🧹", title: "完全整理", desc: "3000本以上を、未分類ゼロに", check: (a) => a.total >= 3000 && a.unranked === 0 },
    { id: "toptier400", icon: "⭐", title: "推し充実", desc: "最上位ティアに400本", check: (a) => a.topTierCount >= 400, progress: prog(400, "topTierCount") },
    { id: "alltiers150", icon: "🌈", title: "満遍なく", desc: "すべてのティアに150本以上", check: (a) => a.tierCount >= 3 && a.minTierCount >= 150, progress: prog(150, "minTierCount") },

    // --- ジャンル ---
    { id: "genre15", icon: "🎭", title: "多趣味", desc: "15ジャンルを制覇", check: (a) => a.genreTotal >= 15, progress: prog(15, "genreTotal") },
    { id: "genre25", icon: "🎨", title: "ジャンルハンター", desc: "25ジャンルを制覇", check: (a) => a.genreTotal >= 25, progress: prog(25, "genreTotal") },
    { id: "genreMaster", icon: "🏵️", title: "ジャンルマスター", desc: "すべてのジャンルを制覇", check: (a) => a.genreDefTotal > 0 && a.genreTotal >= a.genreDefTotal, progress: (a) => ({ cur: a.genreTotal, goal: a.genreDefTotal }) },
    { id: "depth750", icon: "🏔️", title: "一点集中", desc: "同一ジャンルを750本", check: (a) => a.maxGenreCount >= 750, progress: prog(750, "maxGenreCount") },

    // --- 種別（邦画/洋画・実写/アニメ） ---
    { id: "allkinds", icon: "🌏", title: "オールラウンダー", desc: "4種別（邦洋×実写アニメ）をすべて登録", check: (a) => a.kindsAll, progress: (a) => ({ cur: a.s.kinds.length, goal: 4 }) },
    { id: "allkinds250", icon: "🗺️", title: "均整のとれた目", desc: "4種別すべてを250本以上", check: (a) => a.minKindCount >= 250, progress: prog(250, "minKindCount") },
    { id: "anime750", icon: "🎌", title: "アニメ通", desc: "アニメ作品を750本", check: (a) => a.animeCount >= 750, progress: prog(750, "animeCount") },
    { id: "jp1500", icon: "🏯", title: "邦画の守り手", desc: "邦画を1500本", check: (a) => a.jpCount >= 1500, progress: prog(1500, "jpCount") },
    { id: "foreign1500", icon: "🌐", title: "洋画コネクター", desc: "洋画を1500本", check: (a) => a.foreignCount >= 1500, progress: prog(1500, "foreignCount") },
    { id: "balance1000", icon: "🧭", title: "バランス派", desc: "邦画・洋画をそれぞれ1000本以上", check: (a) => a.jpCount >= 1000 && a.foreignCount >= 1000 },

    // --- 年代 ---
    { id: "decade6", icon: "🕰️", title: "時代を超えて", desc: "6つの年代をカバー", check: (a) => a.decadeTotal >= 6, progress: prog(6, "decadeTotal") },
    { id: "decade8", icon: "⏳", title: "時空の旅人", desc: "8つの年代をカバー", check: (a) => a.decadeTotal >= 8, progress: prog(8, "decadeTotal") },
    { id: "decade11", icon: "🌀", title: "一世紀の証人", desc: "11の年代をカバー", check: (a) => a.decadeTotal >= 11, progress: prog(11, "decadeTotal") },
    { id: "classic500", icon: "🎩", title: "クラシック愛好家", desc: "2000年より前を500本", check: (a) => a.classicCount >= 500, progress: prog(500, "classicCount") },
    { id: "pre1970x200", icon: "🎞️", title: "黄金期の探求者", desc: "1970年より前を200本", check: (a) => a.pre1970Count >= 200, progress: prog(200, "pre1970Count") },
    { id: "pre1950x100", icon: "📽️", title: "戦前・サイレント愛", desc: "1950年より前を100本", check: (a) => a.pre1950Count >= 100, progress: prog(100, "pre1950Count") },
    { id: "recent1000", icon: "🆕", title: "新作ハンター", desc: "直近10年の作品を1000本", check: (a) => a.recentCount >= 1000, progress: prog(1000, "recentCount") },
    { id: "decadeDepth750", icon: "🗓️", title: "年代の主", desc: "同一年代を750本", check: (a) => a.maxDecadeCount >= 750, progress: prog(750, "maxDecadeCount") },

    // --- 人物（監督・俳優） ---
    { id: "auteur25", icon: "🎥", title: "作家主義", desc: "同じ監督を25本", check: (a) => a.dirMax >= 25, progress: prog(25, "dirMax") },
    { id: "auteur50", icon: "🎬", title: "監督フリーク", desc: "同じ監督を50本", check: (a) => a.dirMax >= 50, progress: prog(50, "dirMax") },
    { id: "star25", icon: "💫", title: "推し俳優", desc: "同じ俳優を25本", check: (a) => a.actMax >= 25, progress: prog(25, "actMax") },
    { id: "star50", icon: "🌠", title: "俳優オタク", desc: "同じ俳優を50本", check: (a) => a.actMax >= 50, progress: prog(50, "actMax") },
    { id: "dirGe3x100", icon: "🎟️", title: "監督コレクター", desc: "3本以上の監督を100人", check: (a) => a.dirGe3 >= 100, progress: prog(100, "dirGe3") },
    { id: "actGe3x100", icon: "👥", title: "俳優コレクター", desc: "3本以上の俳優を100人", check: (a) => a.actGe3 >= 100, progress: prog(100, "actGe3") },
    { id: "dirGe5x50", icon: "🏅", title: "名匠巡り", desc: "5本以上の監督を50人", check: (a) => a.dirGe5 >= 50, progress: prog(50, "dirGe5") },

    // --- 複合・高難度 ---
    { id: "completionist", icon: "🧩", title: "コンプリート魂", desc: "4種別250本＋15ジャンル＋6年代を達成", check: (a) => a.minKindCount >= 250 && a.genreTotal >= 15 && a.decadeTotal >= 6 },
    { id: "grandmaster", icon: "🏆", title: "グランドマスター", desc: "1万本・未分類ゼロ・25ジャンル・10年代を達成", check: (a) => a.total >= 10000 && a.unranked === 0 && a.genreTotal >= 25 && a.decadeTotal >= 10 },
    { id: "perfectionist", icon: "💠", title: "パーフェクショニスト", desc: "全ジャンル制覇＋4種別500本ずつ＋11年代", check: (a) => a.genreDefTotal > 0 && a.genreTotal >= a.genreDefTotal && a.minKindCount >= 500 && a.decadeTotal >= 11 },
  ];

  function achvContextFromStats(s) {
    const tierItems = state.tiers.map((t) => t.items.length);
    return {
      s,
      total: s.total,
      ranked: s.ranked,
      unranked: s.unranked,
      topTierCount: s.tierDist[0] ? s.tierDist[0].count : 0,
      tiersUsed: state.tiers.filter((t) => t.items.length).length,
      tierCount: state.tiers.length,
      minTierCount: tierItems.length ? Math.min.apply(null, tierItems) : 0,
      allTiersUsed: state.tiers.length >= 3 && state.tiers.every((t) => t.items.length >= 1),
      genreTotal: s.genreTotal,
      genreDefTotal: (typeof GENRES !== "undefined" && GENRES.length) || 20,
      maxGenreCount: s.maxGenreCount,
      kindsAll: s.kinds.length === 4,
      minKindCount: s.minKindCount,
      jpCount: s.jpCount,
      foreignCount: s.foreignCount,
      liveCount: s.liveCount,
      animeCount: s.animeCount,
      decadeTotal: s.decades.length,
      maxDecadeCount: s.maxDecadeCount,
      classicCount: s.classicCount,
      pre1970Count: s.pre1970Count,
      pre1950Count: s.pre1950Count,
      recentCount: s.recentCount,
      maxYear: s.maxYear,
      currentYear: s.currentYear,
      dirMax: s.dirMax,
      actMax: s.actMax,
      dirGe3: s.dirGe3,
      dirGe5: s.dirGe5,
      actGe3: s.actGe3,
      actGe5: s.actGe5,
    };
  }

  function achvContext() {
    return achvContextFromStats(computeStats());
  }

  // 実績の解除判定。silent=true なら通知しない（起動時の既存解除の取り込み用）。
  function evaluateAchievements(opts) {
    opts = opts || {};
    const a = achvContext();
    const newly = [];
    ACHIEVEMENTS.forEach((def) => {
      if (achievements.unlocked[def.id]) return;
      let ok = false;
      try { ok = !!def.check(a); } catch (e) {}
      if (ok) {
        achievements.unlocked[def.id] = Date.now();
        newly.push(def);
      }
    });
    if (newly.length) {
      saveAchievements();
      if (!opts.silent) showAchvToast(newly);
    }
    return newly;
  }

  // 実績解除の専用ポップアップ（汎用トーストとは別要素なので上書きされない）
  let achvToastQueue = [];
  let achvToastTimer = null;

  function ensureAchvToastEl() {
    let el = document.getElementById("achvToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "achvToast";
      el.className = "achv-toast";
      document.body.appendChild(el);
    }
    return el;
  }

  function showAchvToast(list) {
    achvToastQueue.push.apply(achvToastQueue, list);
    if (!achvToastTimer) nextAchvToast();
  }

  function nextAchvToast() {
    const el = ensureAchvToastEl();
    if (!achvToastQueue.length) {
      el.classList.remove("show");
      achvToastTimer = null;
      return;
    }
    const def = achvToastQueue.shift();
    el.innerHTML =
      `<span class="achv-toast-icon">${def.icon}</span>` +
      `<span class="achv-toast-body">` +
      `<span class="achv-toast-label">🏅 実績解除</span>` +
      `<span class="achv-toast-title">${escapeHtml(def.title)}</span>` +
      `<span class="achv-toast-desc">${escapeHtml(def.desc)}</span>` +
      `</span>`;
    // いったん消してから付け直してアニメーションを再生
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    achvToastTimer = setTimeout(nextAchvToast, 3400);
  }

  function renderAchievements(a) {
    const unlockedCount = ACHIEVEMENTS.filter((d) => achievements.unlocked[d.id]).length;
    const badges = ACHIEVEMENTS.map((def) => {
      const unlocked = !!achievements.unlocked[def.id];
      let prog = "";
      if (!unlocked && def.progress) {
        let p = null;
        try { p = def.progress(a); } catch (e) {}
        if (p && p.goal) {
          const w = Math.min(100, Math.round((p.cur / p.goal) * 100));
          prog =
            `<div class="achv-prog"><span class="achv-prog-fill" style="width:${w}%"></span></div>` +
            `<span class="achv-prog-txt">${Math.min(p.cur, p.goal)} / ${p.goal}</span>`;
        }
      }
      return (
        `<div class="achv-badge ${unlocked ? "is-unlocked" : "is-locked"}">` +
        (unlocked ? `<span class="achv-check">✓</span>` : "") +
        `<span class="achv-icon">${def.icon}</span>` +
        `<span class="achv-title">${escapeHtml(def.title)}</span>` +
        `<span class="achv-desc">${escapeHtml(def.desc)}</span>` +
        prog +
        `</div>`
      );
    }).join("");
    return { unlockedCount, total: ACHIEVEMENTS.length, html: `<div class="achv-grid">${badges}</div>` };
  }

  function statBarRows(entries, denom) {
    if (!entries.length) return `<p class="stat-empty">データがありません。</p>`;
    const max = Math.max(1, ...entries.map((e) => e.count));
    const d = denom || entries.reduce((n, e) => n + e.count, 0) || 1;
    return entries.map((e) => {
      const width = (e.count / max) * 100;
      const share = Math.round((e.count / d) * 100);
      const bg = e.color ? `background:${e.color};` : "";
      return (
        `<div class="stat-bar-row">` +
        `<span class="stat-bar-label" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</span>` +
        `<span class="stat-bar-track"><span class="stat-bar-fill" style="width:${width.toFixed(1)}%;${bg}"></span></span>` +
        `<span class="stat-bar-val">${e.count}<span class="stat-bar-pct">${share}%</span></span>` +
        `</div>`
      );
    }).join("");
  }

  function statRankRows(entries, denom) {
    if (!entries.length) {
      return `<p class="stat-empty">まだ十分なデータがありません。作品を追加すると集計されます。</p>`;
    }
    const max = Math.max(1, ...entries.map((e) => e.count));
    return entries.map((e, i) => {
      const share = denom ? `<span class="stat-rank-pct">${Math.round((e.count / denom) * 100)}%</span>` : "";
      const w = (e.count / max) * 100;
      return (
        `<div class="stat-rank-row">` +
        `<span class="stat-rank-no">${i + 1}</span>` +
        `<span class="stat-rank-main">` +
        `<span class="stat-rank-name" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</span>` +
        `<span class="stat-rank-bar"><span class="stat-rank-fill" style="width:${w.toFixed(1)}%"></span></span>` +
        `</span>` +
        `<span class="stat-rank-count">${e.count}本${share}</span>` +
        `</div>`
      );
    }).join("");
  }

  // 積み上げ横バー（全体を100%として色分け）＋凡例
  function statSegBar(entries) {
    const total = entries.reduce((n, e) => n + e.count, 0);
    if (!total) return `<p class="stat-empty">まだ分類がありません。</p>`;
    const seg = entries.filter((e) => e.count > 0).map((e) => {
      const p = (e.count / total) * 100;
      return `<span class="seg" style="width:${p.toFixed(2)}%;background:${e.color}" title="${escapeHtml(e.label)} ${e.count}本 (${Math.round(p)}%)"></span>`;
    }).join("");
    const legend = entries.map((e) =>
      `<div class="seg-leg">` +
      `<span class="seg-dot" style="background:${e.color}"></span>` +
      `<span class="seg-leg-label">${escapeHtml(e.label)}</span>` +
      `<span class="seg-leg-val">${e.count}<span class="seg-leg-pct">${Math.round((e.count / total) * 100)}%</span></span>` +
      `</div>`
    ).join("");
    return `<div class="seg-bar">${seg}</div><div class="seg-legend">${legend}</div>`;
  }

  // ドーナツ（conic-gradient）＋凡例
  function statDonut(entries) {
    const total = entries.reduce((n, e) => n + e.count, 0);
    if (!total) return `<p class="stat-empty">種別が判明した作品がまだありません。</p>`;
    let acc = 0;
    const stops = entries.map((e) => {
      const from = (acc / total) * 100;
      acc += e.count;
      const to = (acc / total) * 100;
      return `${e.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
    }).join(", ");
    const legend = entries.map((e) =>
      `<div class="donut-leg">` +
      `<span class="donut-dot" style="background:${e.color}"></span>` +
      `<span class="donut-leg-label">${escapeHtml(e.label)}</span>` +
      `<span class="donut-leg-val">${e.count}<span class="donut-leg-pct">${Math.round((e.count / total) * 100)}%</span></span>` +
      `</div>`
    ).join("");
    return (
      `<div class="donut-wrap">` +
      `<div class="donut" style="background:conic-gradient(${stops})">` +
      `<div class="donut-hole"><span class="donut-total">${total}</span><span class="donut-sub">本</span></div>` +
      `</div>` +
      `<div class="donut-legend">${legend}</div>` +
      `</div>`
    );
  }

  function renderStats() {
    const body = document.getElementById("statsBody");
    if (!body) return;
    const s = computeStats();

    if (s.total === 0) {
      body.innerHTML =
        `<p class="stat-empty">まだ映画が登録されていません。「＋ 映画を追加」から登録すると、ここに統計が表示されます。</p>`;
      return;
    }

    const rankPct = s.total ? Math.round((s.ranked / s.total) * 100) : 0;
    const yearSpan = s.minYear ? `${s.minYear}–${s.maxYear}` : "—";
    const kpis = [
      { value: s.total, cap: "総登録", unit: "本" },
      { value: `${rankPct}%`, cap: "ランク付け率" },
      { value: yearSpan, cap: "収録年代" },
      { value: s.dirTotal, cap: "監督", unit: "人" },
      { value: s.actTotal, cap: "出演者", unit: "人" },
    ];
    const kpiHtml = kpis.map((k) =>
      `<div class="hero-kpi">` +
      `<span class="hero-num">${escapeHtml(String(k.value))}${k.unit ? `<span class="hero-unit">${k.unit}</span>` : ""}</span>` +
      `<span class="hero-cap">${escapeHtml(k.cap)}</span>` +
      `</div>`
    ).join('<span class="hero-div"></span>');

    const panel = (title, inner, cls) =>
      `<section class="stat-panel ${cls || ""}">` +
      `<h4 class="stat-panel-title">${title}</h4>` +
      `<div class="stat-panel-body">${inner}</div>` +
      `</section>`;

    const insights = buildInsights(s);
    const insightsHtml = insights.map((it) =>
      `<div class="stat-insight">` +
      `<span class="stat-insight-icon">${it.icon}</span>` +
      `<span class="stat-insight-text">${escapeHtml(it.text)}</span>` +
      `</div>`
    ).join("");

    body.innerHTML =
      `<div class="stats-hero">${kpiHtml}</div>` +
      panel("🔍 あなたの傾向", `<div class="stat-insights">${insightsHtml}</div>`, "stat-panel-wide") +
      `<div class="stat-grid">` +
      panel("🏆 ティア分布", statSegBar(s.tierDist), "stat-panel-wide") +
      panel("🎞️ 種別", statDonut(s.kinds)) +
      panel("🎬 ジャンル TOP", `<div class="stat-bars">${statBarRows(s.topGenres, s.total)}</div>`) +
      panel("🗓️ 年代分布", `<div class="stat-bars">${statBarRows(s.decades, s.total)}</div>`) +
      panel("🎥 よく登録している監督", `<div class="stat-rank-list">${statRankRows(s.topDirectors, s.total)}</div>`) +
      panel("⭐ よく登録している出演者", `<div class="stat-rank-list">${statRankRows(s.topActors, s.total)}</div>`) +
      `</div>` +
      `<p class="stat-note">数値は「本数」と「全登録数(${s.total}本)に占める割合」です。ジャンルは1作品が複数に該当するため合計が100%を超えることがあります。種別・監督・出演者・ジャンルは <code>python3 server.py</code> 起動中に自動補完されます。</p>`;
  }

  function openStatsModal() {
    renderStats();
    openModal("statsModal");
  }

  function renderAchvPage() {
    const body = document.getElementById("achvBody");
    if (!body) return;
    const achv = renderAchievements(achvContextFromStats(computeStats()));
    const pct = achv.total ? Math.round((achv.unlockedCount / achv.total) * 100) : 0;
    body.innerHTML =
      `<div class="achv-hero">` +
      `<div class="achv-hero-ring" style="--pct:${pct}">` +
      `<span class="achv-hero-pct">${pct}<small>%</small></span>` +
      `</div>` +
      `<div class="achv-hero-info">` +
      `<div class="achv-hero-count">${achv.unlockedCount} <span>/ ${achv.total}</span></div>` +
      `<div class="achv-hero-label">解除した実績</div>` +
      `<p class="achv-hero-note">条件を満たすと自動で解除されます。より多く・より幅広く登録して、すべての実績の解除を目指しましょう。</p>` +
      `</div>` +
      `</div>` +
      achv.html;
  }

  function openAchvModal() {
    renderAchvPage();
    openModal("achvModal");
  }

  // =======================================================================
  // 二択モード（2作品を見比べて「どっちが好き？」→ Elo でランク付け）
  // =======================================================================
  const battle = {
    items: [],
    rating: new Map(),
    plays: new Map(),
    votes: new Map(),
    origin: new Map(),
    count: 0,
    cur: null,
    lastKey: "",
    keyHandler: null,

    teardown() {
      if (this.keyHandler) {
        document.removeEventListener("keydown", this.keyHandler);
        this.keyHandler = null;
      }
    },

    open() {
      this.teardown();
      this.renderStart();
      openModal("battleModal");
    },

    renderStart() {
      const body = document.getElementById("battleBody");
      if (!body) return;
      const poolN = state.pool.filter((m) => !m.unseen).length;
      const tieredN = allMovies().length - state.pool.length;
      const marked = nitakuMarked().length;
      const flow = poolN && tieredN
        ? `まず<b>未分類の${poolN}本</b>を出題してティアに振り分け、そのあと<b>今のティア分けの見直し</b>に進みます。`
        : poolN
          ? `<b>未分類の${poolN}本</b>を出題して、好きな順にティアへ振り分けます。`
          : `<b>今のティア分けの見直し</b>をします。はっきり差がついた作品だけが入れ替わります。`;
      body.innerHTML =
        `<p class="battle-lead">2作品が表示されるので、<b>好きな方をタップ</b>するだけ。${flow}</p>` +
        `<p class="hint">※ いつやめても、それまでの結果だけで反映できます。二択に出ていない作品は動きません。各ティアの本数も今のまま保ちます。</p>` +
        (marked ? `<div class="nitaku-note">これまでに二択で動いて、まだ確認していない作品が <b>${marked}本</b> あります。` +
          `<button id="nitakuShowBtn2" class="btn btn-ghost btn-sm">表示する</button>` +
          `<button id="nitakuClearBtn" class="btn btn-ghost btn-sm">目印をすべて消す</button></div>` : "") +
        `<div class="settings-actions">` +
        `<button id="battleStartBtn" class="btn btn-primary">二択を始める</button>` +
        `<button class="btn btn-ghost" data-close="battleModal">閉じる</button>` +
        `</div>`;
      const startBtn = document.getElementById("battleStartBtn");
      const show2 = document.getElementById("nitakuShowBtn2");
      if (show2) show2.addEventListener("click", () => { closeModal("battleModal"); showNitakuOnly(); });
      const clr = document.getElementById("nitakuClearBtn");
      if (clr) clr.addEventListener("click", () => {
        if (!window.confirm(`${marked}本の「二択」の目印を消します。ティアは変わりません。よろしいですか？`)) return;
        clearNitakuMarks();
        this.renderStart();
      });
      if (startBtn) startBtn.addEventListener("click", () => {
        this.start();
      });
      body.querySelectorAll("[data-close]").forEach((b) =>
        b.addEventListener("click", () => closeModal(b.dataset.close))
      );
    },

    start() {
      const src = allMovies().filter((m) => !m.unseen);
      if (src.length < 2) { toast("二択をするには2本以上必要です"); return; }
      this.items = src.slice();
      this.rating = new Map();
      this.plays = new Map();
      this.votes = new Map();
      this.origin = new Map();
      this.count = 0;
      this.lastKey = "";
      // 今のティアを出発点にする（上のティアほど高い点。1段の差＝100点）
      const T = state.tiers.length;
      state.tiers.forEach((t, i) => t.items.forEach((m) => this.origin.set(m, i)));
      this.items.forEach((m) => {
        const o = this.origin.has(m) ? this.origin.get(m) : -1;
        this.rating.set(m.id, o >= 0 ? 1000 + ((T - 1) / 2 - o) * 100 : 1000);
        this.plays.set(m.id, 0);
        this.votes.set(m.id, 0);
      });
      this.keyHandler = (e) => {
        if (document.getElementById("battleModal").classList.contains("hidden")) return;
        if (!this.cur) return;
        if (e.key === "ArrowLeft") { e.preventDefault(); this.vote(this.cur.a.id); }
        else if (e.key === "ArrowRight") { e.preventDefault(); this.vote(this.cur.b.id); }
        else if (e.key === " ") { e.preventDefault(); this.vote("skip"); }
      };
      document.addEventListener("keydown", this.keyHandler);
      this.nextPair();
    },

    nextPair() {
      // 振り分けが済んでいない未分類作品を優先して出題し、ティアの作品を物差しにして比べる
      const unplaced = this.unplaced();
      const items = unplaced.length ? unplaced : this.items;
      let minPlays = Infinity;
      items.forEach((m) => { const p = this.plays.get(m.id); if (p < minPlays) minPlays = p; });
      const pool = items.filter((m) => this.plays.get(m.id) === minPlays);
      // 未分類は1本ずつ順番に（途中の作品があればそれを続ける）
      const a = unplaced.length
        ? unplaced.reduce((x, y) => (this.plays.get(y.id) > this.plays.get(x.id) ? y : x))
        : pool[Math.floor(Math.random() * pool.length)];
      const anchors = this.items.filter((m) => m.id !== a.id && this.origin.has(m));
      const others = unplaced.length && anchors.length ? anchors : this.items.filter((m) => m.id !== a.id);
      others.sort((x, y) =>
        Math.abs(this.rating.get(x.id) - this.rating.get(a.id)) -
        Math.abs(this.rating.get(y.id) - this.rating.get(a.id))
      );
      const near = others.slice(0, Math.min(4, others.length));
      let b = near[Math.floor(Math.random() * near.length)];
      // 直前と同じ組み合わせは避ける
      const key = [a.id, b.id].sort().join("|");
      if (key === this.lastKey && others.length > 1) {
        b = near[(near.indexOf(b) + 1) % near.length] || b;
      }
      this.lastKey = [a.id, b.id].sort().join("|");
      this.cur = { a, b };
      this.renderPlay();
    },

    unplaced() {
      return this.items.filter((m) => !this.origin.has(m) && this.plays.get(m.id) < this.PLACE_PLAYS);
    },
    PLACE_PLAYS: 8,

    // 未分類の作品は最初の数回だけ点数を大きく動かし、早く居場所が決まるようにする
    kOf(m) {
      return this.origin.has(m) ? 32 : Math.max(32, 200 / (1 + this.votes.get(m.id)));
    },

    vote(choice) {
      if (!this.cur) return;
      const { a, b } = this.cur;
      if (choice === "skip") {
        this.plays.set(a.id, this.plays.get(a.id) + 1);
        this.plays.set(b.id, this.plays.get(b.id) + 1);
        this.nextPair();
        return;
      }
      const Ra = this.rating.get(a.id), Rb = this.rating.get(b.id);
      const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
      const Eb = 1 - Ea;
      let Sa;
      if (choice === "tie") Sa = 0.5;
      else Sa = choice === a.id ? 1 : 0;
      this.rating.set(a.id, Ra + this.kOf(a) * (Sa - Ea));
      this.rating.set(b.id, Rb + this.kOf(b) * ((1 - Sa) - Eb));
      this.plays.set(a.id, this.plays.get(a.id) + 1);
      this.plays.set(b.id, this.plays.get(b.id) + 1);
      this.votes.set(a.id, this.votes.get(a.id) + 1);
      this.votes.set(b.id, this.votes.get(b.id) + 1);
      this.count++;
      this.nextPair();
    },

    buildCard(movie, side) {
      const card = document.createElement("button");
      card.className = "battle-card";
      card.setAttribute("aria-label", movie.title);
      if (movie.poster) {
        const img = document.createElement("img");
        img.className = "battle-poster";
        img.src = movie.poster;
        img.alt = movie.title;
        img.crossOrigin = "anonymous";
        img.addEventListener("error", () => {
          const src = img.getAttribute("src") || "";
          if (!img.dataset.proxied && src && !src.startsWith("data:") && !src.includes("/api/img")) {
            img.dataset.proxied = "1";
            img.src = "/api/img?u=" + encodeURIComponent(src);
            return;
          }
          const fb = buildFallback(movie.title);
          fb.classList.add("battle-poster");
          img.replaceWith(fb);
        });
        card.appendChild(img);
      } else {
        const fb = buildFallback(movie.title);
        fb.classList.add("battle-poster");
        card.appendChild(fb);
      }
      const t = document.createElement("div");
      t.className = "battle-card-title";
      t.textContent = movie.title + (movie.year ? `（${movie.year}）` : "");
      card.appendChild(t);
      const hint = document.createElement("div");
      hint.className = "battle-card-key";
      hint.textContent = side === "a" ? "← 左キー" : "右キー →";
      card.appendChild(hint);
      card.addEventListener("click", () => this.vote(movie.id));
      return card;
    },

    // 未鑑賞の作品を二択から外す。toWatchlist なら「観たい」へ、そうでなければ未分類に置いて目印を付ける
    unwatched(m, toWatchlist) {
      this.items = this.items.filter((x) => x !== m);
      this.origin.delete(m);
      if (toWatchlist) {
        moveMovie(m.id, "watchlist");
        toast(`「${m.title}」を 🔖 観たい に移動しました`);
      } else {
        if (!state.pool.includes(m)) moveMovie(m.id, "pool");
        m.unseen = true;
        render();
        toast(`「${m.title}」を未鑑賞として未分類に置きました`);
      }
      if (this.items.length >= 2) { this.nextPair(); return; }
      if (this.count > 0) this.finish();
      else { this.teardown(); closeModal("battleModal"); }
    },

    stageText() {
      const left = this.unplaced().length;
      return left ? `未分類を振り分け中（残り <b>${left}</b> 本）` : "ティア分けを見直し中";
    },

    renderPlay() {
      const body = document.getElementById("battleBody");
      if (!body || !this.cur) return;
      body.innerHTML =
        `<div class="battle-progress">${this.stageText()} ・ これまで <b>${this.count}</b> 回 ・ 好きな方をタップ（キーボードの ←/→、スキップは Space）</div>` +
        `<div class="battle-arena">` +
        `<div id="battleSlotA"></div>` +
        `<div class="battle-vs">VS</div>` +
        `<div id="battleSlotB"></div>` +
        `</div>` +
        `<div class="battle-actions">` +
        `<button id="battleTie" class="btn btn-ghost btn-sm">引き分け</button>` +
        `<button id="battleSkip" class="btn btn-ghost btn-sm">スキップ</button>` +
        `</div>` +
        `<div class="settings-actions">` +
        `<button id="battleFinish" class="btn btn-primary">終了してティアに反映</button>` +
        `<button class="btn btn-ghost" data-close="battleModal">やめる</button>` +
        `</div>`;
      [["battleSlotA", this.cur.a, "a"], ["battleSlotB", this.cur.b, "b"]].forEach(([id, m, side]) => {
        const slot = document.getElementById(id);
        slot.appendChild(this.buildCard(m, side));
        const row = document.createElement("div");
        row.className = "battle-unwatched-row";
        const nw = document.createElement("button");
        nw.className = "battle-unwatched";
        nw.textContent = "まだ観ていない";
        nw.title = "未分類に置いたまま、二択に出さないようにします";
        nw.addEventListener("click", () => this.unwatched(m, false));
        const wl = document.createElement("button");
        wl.className = "battle-unwatched";
        wl.textContent = "🔖 観たい";
        wl.title = "「観たい」に移して、二択から外します";
        wl.addEventListener("click", () => this.unwatched(m, true));
        row.append(nw, wl);
        slot.appendChild(row);
      });
      document.getElementById("battleTie").addEventListener("click", () => this.vote("tie"));
      document.getElementById("battleSkip").addEventListener("click", () => this.vote("skip"));
      document.getElementById("battleFinish").addEventListener("click", () => this.finish());
      body.querySelectorAll("[data-close]").forEach((b) =>
        b.addEventListener("click", () => closeModal(b.dataset.close))
      );
    },

    finish() {
      // 実際に対戦した作品だけを対象にする（対戦していない作品は今の場所のまま動かさない）。
      // こうしないと、少数だけ対戦して終了したときに、初期値レーティングのままの
      // 大量の作品まで均等割りされてしまい、既存のティア分けが崩れてしまう。
      const played = this.items.filter((m) => (this.votes.get(m.id) || 0) > 0);
      if (this.count === 0 || played.length === 0) {
        toast("まだ1回も選んでいません。好きな方を選んでみてください");
        return;
      }
      const ranked = played.slice().sort((x, y) => this.rating.get(y.id) - this.rating.get(x.id));
      const n = ranked.length;
      const tiers = state.tiers;
      const T = tiers.length;
      if (!T) { toast("ティアがありません"); return; }
      // 行き先を決める：ティアにあった作品は、各ティアの本数を保ったまま点数順に詰め直す。
      // 未分類から来た作品は、点数がすぐ上の作品と同じティアへ入れる。
      // すべて未分類から来た場合だけ、点数順に均等割りする。
      const dest = new Map();
      const tiered = ranked.filter((m) => this.origin.has(m));
      if (tiered.length) {
        const quota = tiers.map(() => 0);
        tiered.forEach((m) => quota[Math.min(T - 1, this.origin.get(m))]++);
        let t = 0;
        tiered.forEach((m) => { while (quota[t] === 0) t++; quota[t]--; dest.set(m, t); });
        let last = dest.get(tiered[0]);
        ranked.forEach((m) => { if (dest.has(m)) last = dest.get(m); else dest.set(m, last); });
      } else {
        ranked.forEach((m, i) => dest.set(m, Math.min(T - 1, Math.floor((i * T) / n))));
      }
      const moved = ranked.filter((m) => this.origin.get(m) !== dest.get(m)).length;
      if (!window.confirm(`二択に出た ${n}本のうち ${moved}本のティアが変わります。出ていない作品はそのままです。反映しますか？`)) return;
      // 参照で正確に取り除く（同一IDが混在していても取り違えない）
      const removeByRef = (m) => {
        for (const t of state.tiers) {
          const i = t.items.indexOf(m);
          if (i >= 0) { t.items.splice(i, 1); return; }
        }
        const pi = state.pool.indexOf(m);
        if (pi >= 0) state.pool.splice(pi, 1);
      };
      // まず対象作品をすべて現在地から取り除いてから、ランク順に配分する
      ranked.forEach(removeByRef);
      ranked.forEach((m) => tiers[dest.get(m)].items.push(m));
      // ティアが変わった作品に目印を付ける（手で動かすまで残る）。もとのティアに戻ったら目印を外す
      const changes = [];
      ranked.forEach((m) => {
        const o = this.origin.has(m) ? this.origin.get(m) : -1;
        const d = dest.get(m);
        if (o === d) return;
        const fromLabel = o >= 0 ? tiers[o].label : "未分類";
        const first = m.nitaku ? m.nitaku.from : fromLabel;
        if (first === tiers[d].label) delete m.nitaku;
        else m.nitaku = { from: first, at: Date.now() };
        changes.push({ m, from: fromLabel, to: d });
      });
      this.teardown();
      updateThemeButton();
      updateFilterInfo();
      render();
      this.renderResult(changes);
    },

    renderResult(changes) {
      const body = document.getElementById("battleBody");
      if (!body) return;
      const rows = state.tiers.map((t, i) => {
        const list = changes.filter((c) => c.to === i);
        if (!list.length) return "";
        return `<div class="nitaku-res-row"><span class="nitaku-res-tier" style="background:${t.color}">${escapeHtml(t.label)}</span>` +
          `<div class="nitaku-res-items">${list.map((c) =>
            `<span class="nitaku-res-item">${escapeHtml(c.m.title)}<small>${escapeHtml(c.from)}から</small></span>`).join("")}</div></div>`;
      }).join("");
      body.innerHTML =
        `<p class="battle-lead">${this.count}回の二択の結果、<b>${changes.length}本</b>のティアが変わりました。</p>` +
        (changes.length
          ? `<div class="nitaku-res">${rows}</div>` +
            `<p class="hint">※ 動いた作品には「二択」の目印が付きます。手でティアを動かすと目印は消えます。</p>`
          : "") +
        `<div class="settings-actions">` +
        (changes.length ? `<button id="nitakuShowBtn" class="btn btn-primary">二択で動いた作品だけ表示</button>` : "") +
        `<button class="btn btn-ghost" data-close="battleModal">閉じる</button>` +
        `</div>`;
      const show = document.getElementById("nitakuShowBtn");
      if (show) show.addEventListener("click", () => { closeModal("battleModal"); showNitakuOnly(); });
      body.querySelectorAll("[data-close]").forEach((b) =>
        b.addEventListener("click", () => closeModal(b.dataset.close))
      );
    },
  };

  function openBattleModal() {
    battle.open();
  }

  function nitakuMarked() { return allMovies().filter((m) => m.nitaku); }

  function showNitakuOnly() {
    if (!hasFilterVal("nitaku", "1")) applyThemeFilter("nitaku:1");
  }

  function clearNitakuMarks() {
    nitakuMarked().forEach((m) => delete m.nitaku);
    if (hasFilterVal("nitaku", "1")) applyThemeFilter("nitaku:1");
    else render();
  }

  function openModal(id) {
    document.getElementById(id).classList.remove("hidden");
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add("hidden");
    if (id === "addMovieModal") resetAddCandidates();
    if (id === "battleModal") battle.teardown();
  }

  // 「映画を追加」を閉じたら、各タブの候補作一覧・選択状態・読み込みセッションを消して
  // 次に開いたときはまっさらな状態にする。
  function resetAddCandidates() {
    const clearHtml = (ids) => ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = "";
    });
    const clearText = (ids) => ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = "";
    });
    const hide = (ids) => ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    // 候補グリッド・人物一覧をクリア
    clearHtml(["searchResults", "recallGrid", "recommendGrid", "collectionGrid",
      "genreGrid", "awardGrid", "filmGrid", "personResults"]);
    clearText(["searchStatus", "recallStatus", "recommendStatus", "collectionStatus",
      "genreStatus", "awardStatus", "personStatus"]);
    // 「もっと見る」・下部の追加アクションバーを隠す
    hide(["recallMoreWrap", "collectionMoreWrap", "genreMoreWrap", "awardMoreWrap",
      "recallActions", "recommendActions", "collectionActions", "genreActions", "awardActions", "personActions"]);
    personPicked.clear();
    // 人物のフィルモグラフィ表示を閉じる
    const pf = document.getElementById("personFilmography");
    if (pf) pf.classList.add("hidden");
    // 検索入力もクリア
    const si = document.getElementById("movieSearchInput");
    if (si) si.value = "";
    // 読み込みセッション・キャッシュをリセット（次回開いたら再取得させる）
    recallSession = { year: null, nextPage: 1, hasMore: false, skipped: 0, seen: new Set(), pool: [] };
    recommendFilms = [];
    recShown = new Set();
    [COLLECTION_CTX, AWARD_CTX].forEach((ctx) => { ctx.films = []; ctx.queue = []; ctx.col = null; });
    genreCtrl.films = []; genreCtrl.session = newFmSession();
    awardCtrl.films = []; awardCtrl.session = newFmSession();
    // 追加先を既定（未分類）に戻す
    addTarget = "pool";
    // 既定タブ（検索）に戻して次回はまっさらな状態で開くようにする
    switchTab("search");
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === name));
    // フッターの追加バーは共有なので、アクティブなタブの分だけ（かつ候補がある場合のみ）表示する
    ["recall", "recommend", "collection", "genre", "award", "person"].forEach((t) => {
      const actions = document.getElementById(t + "Actions");
      const grid = document.getElementById(t === "person" ? "filmGrid" : t + "Grid");
      if (!actions) return;
      const hasCards = grid && grid.querySelector(".pick-card");
      actions.style.display = name === t && hasCards ? "flex" : "none";
    });
    if (name === "recall") initRecallUI();
    else if (name === "collection") initCollectionUI();
    else if (name === "genre") initGenreUI();
    else if (name === "award") initAwardUI();
    else if (name === "person") { if (!document.getElementById("personSuggest").children.length) renderPersonSuggest(); }
    else if (name === "recommend" && !recommendFilms.length && !recBuilding) buildRecommendations();
  }

  function renderSearchResults(results) {
    const wrap = document.getElementById("searchResults");
    wrap.innerHTML = "";
    if (!results.length) {
      document.getElementById("searchStatus").textContent = "該当する映画が見つかりませんでした。";
      return;
    }
    results.forEach((r) => {
      const card = document.createElement("div");
      card.className = "result-card";
      card.innerHTML =
        (r.poster
          ? `<img src="${r.poster}" alt="" loading="lazy" crossorigin="anonymous" />`
          : `<div class="result-fallback">🎬</div>`) +
        `<div class="result-meta">
           <div class="result-title">${escapeHtml(r.title)}</div>
           <div class="result-year">${escapeHtml(r.year || "")}</div>
         </div>`;
      card.addEventListener("click", () => {
        const movie = { title: r.title, poster: r.poster || "", year: r.year || "" };
        if (r.tmdbId) movie.tmdbId = r.tmdbId;
        if (r.eigaId) movie.eigaId = r.eigaId;
        if (r.filmarksId) movie.filmarksId = r.filmarksId;
        const ok = addMovie(movie);
        if (ok) {
          card.classList.add("result-added");
          toast(addTarget === "watchlist" ? `🔖 「${r.title}」を観たいリストに追加しました` : `「${r.title}」を追加しました`);
        }
      });
      wrap.appendChild(card);
    });
  }

  async function doSearch() {
    const q = document.getElementById("movieSearchInput").value.trim();
    const status = document.getElementById("searchStatus");
    if (!q) return;
    status.textContent = "検索中…";
    document.getElementById("searchResults").innerHTML = "";
    try {
      const results = await searchFilmarks(q);
      status.textContent = results.length
        ? `${results.length}件見つかりました（クリックで追加）`
        : "該当する映画が見つかりませんでした。";
      renderSearchResults(results);
    } catch (e) {
      if (e.message === "NO_SERVER") {
        status.innerHTML =
          "検索にはローカルサーバーが必要です。ターミナルで <code>python3 server.py</code> を実行し、http://localhost:8000 を開いてください。それ以外は「手動で追加」をご利用ください。";
      } else if (e.message === "FETCH_FAILED") {
        status.textContent = "検索元への接続に失敗しました。ネット接続を確認してください。";
      } else {
        status.textContent = "検索に失敗しました: " + e.message;
      }
    }
  }

  // Manual add preview
  let manualPosterData = "";
  function wireManual() {
    const urlInput = document.getElementById("manualPosterUrl");
    const fileInput = document.getElementById("manualPosterFile");
    const previewImg = document.getElementById("manualPreviewImg");

    urlInput.addEventListener("input", () => {
      manualPosterData = urlInput.value.trim();
      previewImg.src = manualPosterData;
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        manualPosterData = reader.result;
        previewImg.src = manualPosterData;
        urlInput.value = "";
      };
      reader.readAsDataURL(f);
    });

    document.getElementById("manualAddBtn").addEventListener("click", () => {
      const title = document.getElementById("manualTitle").value.trim();
      if (!title) {
        toast("タイトルを入力してください");
        return;
      }
      const ok = addMovie({ title, poster: manualPosterData || "" });
      if (!ok) return; // 重複時は addMovie 側のトーストを尊重（入力は残す）
      toast(addTarget === "watchlist" ? `🔖 「${title}」を観たいリストに追加しました` : `「${title}」を追加しました`);
      document.getElementById("manualTitle").value = "";
      urlInput.value = "";
      fileInput.value = "";
      previewImg.removeAttribute("src");
      manualPosterData = "";
    });
  }

  // 作品情報エディタのポスターアップロード・保存を配線
  function wireMovieInfo() {
    const urlInput = document.getElementById("infoPosterUrl");
    const fileInput = document.getElementById("infoPosterFile");
    urlInput.addEventListener("input", () => {
      infoPosterData = null;
      setInfoPreview(urlInput.value.trim());
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        infoPosterData = reader.result;
        setInfoPreview(infoPosterData);
        urlInput.value = "";
      };
      reader.readAsDataURL(f);
    });
    document.getElementById("infoSaveBtn").addEventListener("click", saveMovieInfo);
    const themeSave = document.getElementById("themeSaveBtn");
    if (themeSave) themeSave.addEventListener("click", saveThemeEdit);
    const themeDel = document.getElementById("themeDeleteBtn");
    if (themeDel) themeDel.addEventListener("click", deleteThemeEdit);
    const rankBtn = document.getElementById("rankThemeBtn");
    if (rankBtn) rankBtn.addEventListener("click", openRankingModal);
    const rankSave = document.getElementById("rankingSaveBtn");
    if (rankSave) rankSave.addEventListener("click", saveRanking);
    const rankShuffle = document.getElementById("rankShuffleBtn");
    if (rankShuffle) rankShuffle.addEventListener("click", shuffleRanking);
    const rankTier = document.getElementById("rankByTierBtn");
    if (rankTier) rankTier.addEventListener("click", rankByTier);
    const rankExport = document.getElementById("rankExportBtn");
    if (rankExport) rankExport.addEventListener("click", exportRankingPng);
    wireShare();
    const chBtn = document.getElementById("challengeCreateBtn");
    if (chBtn) chBtn.addEventListener("click", openChallengeCreate);
    document.querySelectorAll(".tp-sort-btn").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.sort === themePickSort) {
          // 同じ基準を再クリック → 昇順・降順をトグル
          themePickDir = themePickDir === "asc" ? "desc" : "asc";
        } else {
          themePickSort = b.dataset.sort;
          themePickDir = "asc";
        }
        updateThemePickSortBtns();
        renderThemePickList();
      }));
  }

  // =======================================================================
  // Event bindings
  // =======================================================================
  function bindEvents() {
    document.getElementById("addTierBtn").addEventListener("click", addTier);
    document.getElementById("resetTiersBtn").addEventListener("click", resetTiers);

    // theme filter (panel)
    document.getElementById("themeFilterBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      openThemePanel(e.currentTarget);
    });
    document.getElementById("clearThemeBtn").addEventListener("click", () => {
      applyThemeFilter("");
      closeThemePanel();
    });

    // 登録作品のタイトル検索（テーマ絞り込みと併用可）
    const searchInput = document.getElementById("listSearchInput");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        searchQuery = normTitle(e.target.value);
        zoneLimits.clear();
        render();
      });
    }

    // compact display toggle (設定に集約)
    applyCompact();
    document.getElementById("compactCheck").addEventListener("change", (e) => {
      settings.compact = e.target.checked;
      saveSettings();
      applyCompact();
    });

    // design / layout theme (設定に集約)
    applyTheme();
    document.getElementById("themeSelect").addEventListener("change", (e) => {
      settings.theme = e.target.value;
      saveSettings();
      applyTheme();
    });

    // pool collapse
    document.getElementById("poolCollapse").addEventListener("click", () => {
      state.poolCollapsed = !state.poolCollapsed;
      render();
    });

    document.getElementById("addMovieBtn").addEventListener("click", () => openAddModal());
    document.getElementById("fabAdd").addEventListener("click", () => openAddModal());
    document.getElementById("quickAddForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("quickAddInput");
      const q = input.value.trim();
      openAddModal();
      switchTab("search");
      if (q) {
        document.getElementById("movieSearchInput").value = q;
        input.value = "";
        doSearch();
      }
    });
    document.querySelectorAll("[data-open-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        openAddModal();
        switchTab(b.dataset.openTab);
      })
    );
    if ("IntersectionObserver" in window) {
      const fab = document.getElementById("fabAdd");
      new IntersectionObserver(([en]) => fab.classList.toggle("show", !en.isIntersecting)).observe(
        document.getElementById("quickAddForm")
      );
    }
    document.getElementById("clearPoolBtn").addEventListener("click", () => {
      if (!state.pool.length) return;
      if (confirm("未分類の映画をすべて削除しますか？")) {
        state.pool = [];
        render();
      }
    });

    document.getElementById("statsBtn").addEventListener("click", openStatsModal);
    document.getElementById("socialBtn").addEventListener("click", () => openSocial());
    document.querySelectorAll(".soc-tab").forEach((t) =>
      t.addEventListener("click", () => switchSocTab(t.dataset.socTab)));
    document.getElementById("achvBtn").addEventListener("click", openAchvModal);
    document.getElementById("battleBtn").addEventListener("click", openBattleModal);
    document.getElementById("authBtn").addEventListener("click", openMyPage);
    document.getElementById("helpBtn").addEventListener("click", () => openModal("helpModal"));
    setupMobileShell();
    const helpStart = document.getElementById("helpStartBtn");
    if (helpStart) helpStart.addEventListener("click", () => {
      closeModal("helpModal");
      openAddModal();
    });
    document.getElementById("exportDataBtn").addEventListener("click", exportData);
    document.getElementById("importDataBtn").addEventListener("click", () =>
      document.getElementById("importDataFile").click()
    );
    document.getElementById("importDataFile").addEventListener("change", (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = "";
    });

    // modal close buttons + overlay click
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => closeModal(b.dataset.close))
    );
    document.querySelectorAll(".modal-overlay").forEach((ov) =>
      ov.addEventListener("click", (e) => {
        if (e.target === ov) closeModal(ov.id);
      })
    );

    // tabs
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchTab(t.dataset.tab))
    );

    // search
    document.getElementById("movieSearchBtn").addEventListener("click", doSearch);
    document.getElementById("movieSearchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

    // person (bulk add)
    document.getElementById("personShuffleBtn").addEventListener("click", renderPersonSuggest);
    document.getElementById("personSearchBtn").addEventListener("click", searchPerson);
    document.getElementById("personSearchInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchPerson();
    });
    document.getElementById("personBackBtn").addEventListener("click", () => {
      document.getElementById("personFilmography").classList.add("hidden");
      document.getElementById("personActions").style.display = "none";
      personPicked.clear();
      document.getElementById("personStatus").textContent = "";
      searchPerson();
    });
    document.getElementById("personAddBtn").addEventListener("click", bulkAddPerson);
    document.getElementById("personSelectAllBtn").addEventListener("click", togglePersonSelectAll);

    // 公開年
    document.getElementById("recallShowBtn").addEventListener("click", loadRecall);
    document.getElementById("recallAddBtn").addEventListener("click", bulkAddRecall);
    document.getElementById("recallMoreBtn").addEventListener("click", loadMoreRecall);

    // おすすめ
    document.getElementById("recommendRefreshBtn").addEventListener("click", buildRecommendations);
    document.getElementById("recommendAddBtn").addEventListener("click", bulkAddRecommend);
    document.getElementById("upcomingBtn").addEventListener("click", openUpcomingModal);
    document.getElementById("upcomingRefreshBtn").addEventListener("click", buildUpcoming);

    // コレクション
    document.getElementById("collectionShuffleBtn").addEventListener("click", renderCollectionChips);
    document.getElementById("collectionSearchInput").addEventListener("input", renderCollectionChips);
    document.getElementById("collectionAddBtn").addEventListener("click", () => bulkAddCollection(COLLECTION_CTX));
    document.getElementById("awardAddBtn").addEventListener("click", () => awardMode === "fm" ? fmBulkAdd(awardCtrl) : bulkAddCollection(AWARD_CTX));
    document.getElementById("genreAddBtn").addEventListener("click", () => fmBulkAdd(genreCtrl));
    document.getElementById("collectionMoreBtn").addEventListener("click", () => loadMoreCollection(COLLECTION_CTX));
    document.getElementById("awardMoreBtn").addEventListener("click", () => awardMode === "fm" ? fmLoadMore(awardCtrl) : loadMoreCollection(AWARD_CTX));
    document.getElementById("genreMoreBtn").addEventListener("click", () => fmLoadMore(genreCtrl));

    wireManual();
    wireMovieInfo();

    // close popovers on scroll（ただしポップオーバー内部のスクロールでは閉じない）
    window.addEventListener("scroll", (e) => {
      const t = e.target;
      // テーマパネル内のリストをスクロールしているときは閉じない
      if (currentThemePanel && t && t.nodeType === 1 &&
          (currentThemePanel === t || currentThemePanel.contains(t))) {
        return;
      }
      closeTierEditor();
      closeMoveMenu();
      if (currentThemePanel && currentThemePanel.classList.contains("theme-panel-sheet")) return;
      closeThemePanel();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeTierEditor();
        closeMoveMenu();
        closeThemePanel();
        closeSaveMenu();
        document.querySelectorAll(".modal-overlay:not(.hidden)").forEach((m) => closeModal(m.id));
      }
    });
  }

  // =======================================================================
  // Backup / restore UI
  // =======================================================================
  function formatBackupTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function restoreFromBackup(index) {
    const backups = loadBackups();
    const entry = backups[index];
    if (!entry) return;
    try {
      const parsed = JSON.parse(entry.data);
      if (!parsed || !Array.isArray(parsed.tiers)) throw new Error("invalid");
      state = parsed;
      state.tiers.forEach((t) => {
        if (typeof t.collapsed !== "boolean") t.collapsed = false;
      });
      if (typeof state.poolCollapsed !== "boolean") state.poolCollapsed = false;
      zoneLimits.clear();
      activeFilters = [];
      skipBackupMerge = true;
      restoredFromTs = entry.ts;
      try { render(); } finally { skipBackupMerge = false; restoredFromTs = 0; }
      toast(`${friendlyTime(entry.ts)} の状態に戻しました（${entry.count} 本）`);
      const banner = document.getElementById("recoveryBanner");
      if (banner) banner.classList.add("hidden");
      renderBackupList();
    } catch (e) {
      toast("復元に失敗しました");
    }
  }

  function relativeTime(ts) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return "たった今";
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}分前`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}時間前`;
    const day = Math.round(hr / 24);
    return day < 30 ? `${day}日前` : formatBackupTime(ts);
  }

  function friendlyTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const dayDiff = Math.round(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
        new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (dayDiff === 0) return `今日 ${hm}`;
    if (dayDiff === 1) return `昨日 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  // 作品ID → { title, place }（place はティア名 or 未分類）
  function placementMap(st) {
    const map = new Map();
    if (!st || !Array.isArray(st.tiers)) return map;
    st.tiers.forEach((t) => (t.items || []).forEach((m) =>
      map.set(m.id, { title: m.title || "（無題）", place: t.label || "?" })));
    (st.pool || []).forEach((m) => map.set(m.id, { title: m.title || "（無題）", place: "未分類" }));
    return map;
  }

  // 1つ前の記録と比べて、何が変わったかを短い文で返す
  function describeChange(prev, cur) {
    if (!prev) return { kind: "start", text: "記録の始まり" };
    const added = [], removed = [], moved = [];
    cur.forEach((v, id) => {
      const o = prev.get(id);
      if (!o) added.push(v);
      else if (o.place !== v.place) moved.push({ ...v, from: o.place });
    });
    prev.forEach((v, id) => { if (!cur.has(id)) removed.push(v); });
    const q = (t) => `『${t.length > 18 ? t.slice(0, 17) + "…" : t}』`;
    const parts = [];
    if (added.length) parts.push(added.length === 1 ? `${q(added[0].title)}を追加` : `${added.length}本を追加`);
    if (removed.length) parts.push(removed.length === 1 ? `${q(removed[0].title)}を削除` : `${removed.length}本を削除`);
    if (moved.length) parts.push(moved.length === 1
      ? `${q(moved[0].title)}を ${moved[0].from}→${moved[0].place}`
      : `${moved.length}本のランクを変更`);
    if (!parts.length) return { kind: "edit", text: "並び順・情報の編集" };
    const kind = removed.length ? "remove" : added.length ? "add" : "move";
    return { kind, text: parts.join(" ／ ") };
  }

  function renderMyStatus() {
    const box = document.getElementById("mpStatus");
    if (!box) return;
    const where = currentUser ? `この端末＋アカウント ${escapeHtml(currentUser.username)}` : "この端末";
    box.innerHTML =
      `<span>✅ <b>自動で保存中</b><small>${where}・${totalMovies(state)} 本</small></span>` +
      (currentUser ? "" : `<button type="button" id="mpLoginHint" class="mp-link">ほかの端末でも使う</button>`);
    const hint = document.getElementById("mpLoginHint");
    if (hint) hint.addEventListener("click", () => {
      const acc = document.getElementById("mpAccount");
      acc.open = true;
      acc.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setTimeout(() => { const u = document.getElementById("authUser"); if (u) u.focus(); }, 300);
    });
    const badge = document.getElementById("mpAccountBadge");
    if (badge) {
      badge.textContent = currentUser ? "ログイン中" : "未ログイン";
      badge.classList.toggle("is-on", !!currentUser);
    }
  }

  function renderBackupList() {
    renderMyStatus();
    const wrap = document.getElementById("backupList");
    if (!wrap) return;
    const backups = loadBackups();
    if (!backups.length) {
      wrap.innerHTML = `<p class="hint" style="margin:0">まだ記録はありません。映画を登録すると自動で記録されます。</p>`;
      return;
    }
    const maps = backups.map((b) => {
      try { return placementMap(JSON.parse(b.data)); } catch (e) { return null; }
    });
    const currentLean = JSON.stringify(stripHeavy(state));
    let currentShown = false;
    wrap.innerHTML = "";
    const SHOW = 3;
    let shown = 0;
    for (let i = backups.length - 1; i >= 0; i--) {
      const b = backups[i];
      const isCurrent = !currentShown && b.data === currentLean;
      if (isCurrent) currentShown = true;
      const change = b.restoredFrom
        ? { kind: "restore", text: `${friendlyTime(b.restoredFrom)} に戻した` }
        : maps[i] ? describeChange(i > 0 ? maps[i - 1] : null, maps[i]) : { kind: "edit", text: "" };
      const row = document.createElement("div");
      row.className = "backup-row" + (isCurrent ? " is-current" : "") + (shown >= SHOW ? " is-more hidden" : "");
      row.title = `${formatBackupTime(b.ts)}（${relativeTime(b.ts)}）・合計 ${b.count} 本`;
      row.innerHTML =
        `<span class="backup-when">${friendlyTime(b.ts)}</span>` +
        `<span class="backup-change chg-${change.kind}">${escapeHtml(change.text)}</span>`;
      if (isCurrent) {
        const tag = document.createElement("span");
        tag.className = "backup-now";
        tag.textContent = "いま";
        row.appendChild(tag);
      } else {
        const btn = document.createElement("button");
        btn.className = "btn btn-ghost btn-sm";
        btn.textContent = "戻す";
        btn.addEventListener("click", () => {
          if (totalMovies(state) > 0 &&
            !confirm(`${friendlyTime(b.ts)} の状態（${b.count} 本）に戻しますか？\nいまの状態も一覧に残るので、あとでやり直せます。`)) return;
          pushBackup();
          restoreFromBackup(loadBackups().findIndex((x) => x.ts === b.ts && x.data === b.data));
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
      shown++;
    }
    if (shown > SHOW) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "mp-link backup-more";
      more.textContent = `もっと見る（あと ${shown - SHOW} 件）`;
      more.addEventListener("click", () => {
        wrap.querySelectorAll(".is-more").forEach((r) => r.classList.remove("hidden"));
        more.remove();
      });
      wrap.appendChild(more);
    }
  }

  // 読み込み時、現在のデータが空なのに復元ポイントがあれば復旧を案内する
  function checkForLostData() {
    if (totalMovies(state) > 0) return;
    const backups = loadBackups();
    const latest = backups[backups.length - 1];
    if (!latest || !latest.count) return;
    const banner = document.getElementById("recoveryBanner");
    if (!banner) return;
    document.getElementById("recoveryText").textContent =
      `以前のTier List（${latest.count} 本 / ${formatBackupTime(latest.ts)}）が見つかりました。復元しますか？`;
    banner.classList.remove("hidden");
    document.getElementById("recoveryRestoreBtn").onclick = () =>
      restoreFromBackup(backups.length - 1);
    document.getElementById("recoveryDismissBtn").onclick = () =>
      banner.classList.add("hidden");
  }

  // =======================================================================
  // Init
  // =======================================================================
  lastMovieCount = allMovies().length; // 起動時の演出を抑止
  try { evaluateAchievements({ silent: true }); } catch (e) {} // 既存の解除済み実績を通知なしで取り込む
  // 個々の処理が失敗しても、登録済みリストの表示だけは死守する
  try { bindEvents(); } catch (e) { console.error("bindEvents failed", e); }
  try { render(); } catch (e) { console.error("render failed", e); }
  // まず耐久ストア(IndexedDB)から復旧を試み、無ければ localStorage のバックアップを案内。
  // その後、ログイン済みならサーバーの内容と同期する。
  reconcileFromIdb()
    .then((recovered) => { if (!recovered) checkForLostData(); })
    .catch(() => { try { checkForLostData(); } catch (e) {} })
    .then(() => { try { return checkAuth(); } catch (e) {} })
    .then(() => { try { handleCompareLink(); } catch (e) {} })
    .then(() => { try { handleChallengeLink(); } catch (e) {} })
    .catch(() => {});

  // PWA: Service Worker を登録（HTTPS または localhost のみ有効）。
  // オフラインでも直近の画面を開けるようにし、ホーム画面追加でアプリ化できる。
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
