(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const LS_TOKEN = "spng_owner_token";

  function jwtPayload(token){
    try{
      const p = String(token||"").split(".")[1] || "";
      const json = atob(p.replace(/-/g,'+').replace(/_/g,'/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    }catch(_e){ return {}; }
  }
  function isAdminUser(){
    const t = localStorage.getItem(LS_TOKEN) || "";
    const p = jwtPayload(t);
    // owner dashboard: treat owner role as admin
    return (p && (p.role === "owner" || p.role === "admin")) ? true : false;
  }


  const loginCard = $("loginCard");
  const meCard = $("meCard");
  const shopCard = $("shopCard");

  const loginErr = $("loginErr");
  const shopErr = $("shopErr");

  const btnLogin = $("btnLogin");
  const btnLogout = $("btnLogout");

  const meEmail = $("meEmail");
  const shopsWrap = $("shops");

  const shopTitle = $("shopTitle");
  const shopMeta = $("shopMeta");
  const alertBar = $("alertBar");
  const btnViewExpired = $("btnViewExpired");
  const btnViewSoon = $("btnViewSoon");
  const expiryModalOverlay = $("expiryModalOverlay");
    if (expiryModalOverlay) { expiryModalOverlay.style.display = "none"; expiryModalOverlay.setAttribute("aria-hidden","true"); }
const btnCloseExpiryModal = $("btnCloseExpiryModal");
  const expiryModalTitle = $("expiryModalTitle");
  const expiryModalSub = $("expiryModalSub");
  const expirySearch = $("expirySearch");
  const expiryCountPill = $("expiryCountPill");
  const expiryTbody = $("expiryTbody");
  const btnExportExpiryCsv = $("btnExportExpiryCsv");
  const exportMsg = $("exportMsg");
  const soonDaysSelect = $("soonDaysSelect");
  const soonDaysCustom = $("soonDaysCustom");
  const btnSaveSoonDays = $("btnSaveSoonDays");
  const soonDaysMsg = $("soonDaysMsg");
  const kpisWrap = $("kpis");
  const trendMeta = $("trendMeta");
  const trendBarsEl = $("trendBars");
  const topProductsListEl = $("topProductsList");
  const profitMeta = $("profitMeta");
  const profitToday = $("profitToday");
  const profit7d = $("profit7d");
  const profit30d = $("profit30d");
  const profitTableBody = $("profitTableBody");
  const profitNote = $("profitNote");
  const bestSellersWrap = $("bestSellers");
  const slowMovingWrap = $("slowMoving");
  const rangeChips = Array.from(document.querySelectorAll(".chip[data-range]"));

  function setExpiryOverlayVisible(visible){
    if(!expiryModalOverlay) return;
    expiryModalOverlay.classList.toggle("hidden", !visible);
    // Hard-enforce display so even if CSS is cached/broken the modal won't block UI
    expiryModalOverlay.style.display = visible ? "flex" : "none";
    document.body.style.overflow = visible ? "hidden" : "";
  }

  // Always start hidden (prevents accidental blocking on login page)
  setExpiryOverlayVisible(false);

  // Close handlers
  if(btnCloseExpiryModal){
    btnCloseExpiryModal.addEventListener("click", (e) => {
      e.preventDefault();
      closeExpiryModal();
    });
  }
  if(expiryModalOverlay){
    expiryModalOverlay.addEventListener("click", (e) => {
      if(e.target === expiryModalOverlay) closeExpiryModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if(e.key === "Escape") closeExpiryModal();
  });

  // Open handlers (only when user clicks)
  if(btnViewExpired){
    btnViewExpired.addEventListener("click", (e) => {
      e.preventDefault();
      openExpiryModal("expired");
    });
  }
  if(btnViewSoon){
    btnViewSoon.addEventListener("click", (e) => {
      e.preventDefault();
      openExpiryModal("soon");
    });
  }
  if (btnExportExpiryCsv) {
    btnExportExpiryCsv.addEventListener("click", async (e) => {
      e.preventDefault();
      const shopId = selectedShopId;
      if (!shopId) return;
      const type = currentExpiryType || "expired";
      try {
        if (exportMsg) exportMsg.textContent = "Exporting...";
        const url = `/api/owner/shop/${encodeURIComponent(shopId)}/expiry/export?type=${encodeURIComponent(type)}`;
        const token = localStorage.getItem(LS_TOKEN) || "";
        const res = await fetch(url, { headers: token ? { "Authorization": "Bearer " + token } : {} });
        if (!res.ok) throw new Error("Export failed");
        const blob = await res.blob();
        const a = document.createElement("a");
        const dt = new Date();
        const stamp = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
        a.href = URL.createObjectURL(blob);
        a.download = `superposng_${type}_${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        if (exportMsg) exportMsg.textContent = "Downloaded.";
      } catch (err) {
        if (exportMsg) exportMsg.textContent = "Export failed.";
      }
    });
  }




  const qProducts = $("qProducts");
  const qSales = $("qSales");
  const qDebtors = $("qDebtors");
  const productsBody = $("productsBody");
  const salesBody = $("salesBody");
  const debtorsBody = $("debtorsBody");

  const btnReloadSales = $("btnReloadSales");
  const btnReloadDebtors = $("btnReloadDebtors");
  const btnBack = $("btnBack");

  const tabBtns = Array.from(document.querySelectorAll(".tab[data-tab]"));
  const panels = {
    products: $("tab_products"),
    sales: $("tab_sales"),
    debtors: $("tab_debtors"),
  };

  let selectedShopId = "";
  let currentExpiryType = "expired";
  let salesCache = [];
  let currentRangeDays = 30;

  let debtorsCache = [];

  function showLoginErr(msg) {
    loginErr.textContent = msg || "";
    loginErr.classList.toggle("hidden", !msg);
  }

  function showShopErr(msg) {
    shopErr.textContent = msg || "";
    shopErr.classList.toggle("hidden", !msg);
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0.00";
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }


  function playExpiredBlockSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      // quick beep pattern
      const t0 = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      g.gain.exponentialRampToValueAtTime(0.6, t0 + 0.24);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.40);
      o.stop(t0 + 0.45);
      o.onended = () => ctx.close().catch(() => {});
    } catch (_e) {}
  }

  function setAlert(kind, html) {
    if (!alertBar) return;
    if (!html) {
      alertBar.classList.add("hidden");
      alertBar.innerHTML = "";
      return;
    }
    alertBar.classList.remove("hidden");
    alertBar.classList.remove("warn");
    if (kind === "warn") alertBar.classList.add("warn");
    alertBar.innerHTML = html;
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
    );
  }


  // -----------------------------
  // Expiry list modal (Expired / Expiring Soon)
  // -----------------------------
  let __expiryItems = [];
  let __expiryType = "expired";

  function showExpiryButtons(expiredCount, soonCount) {
    const ex = Number(expiredCount) || 0;
    const so = Number(soonCount) || 0;

    if (btnViewExpired) {
      btnViewExpired.classList.remove("hidden");
      btnViewExpired.disabled = ex <= 0;
      btnViewExpired.title = ex > 0 ? "View Expired List" : "No expired items / Babu expired";
    }
    if (btnViewSoon) {
      btnViewSoon.classList.remove("hidden");
      btnViewSoon.disabled = so <= 0;
      btnViewSoon.title = so > 0 ? "View Expiring Soon List" : "No expiring-soon items / Babu expiring soon";
    }
  }

  function closeExpiryModal() {
    setExpiryOverlayVisible(false);
    __expiryItems = [];
    if (expirySearch) expirySearch.value = "";
    if (expiryTbody) expiryTbody.innerHTML = "";
    if (expiryCountPill) expiryCountPill.textContent = "0 items";
  }

  function matchesExpirySearch(it, q) {
    if (!q) return true;
    const s = (q || "").toLowerCase().trim();
    const hay = [
      it?.name, it?.barcode, it?.sku, it?.productId
    ].map(v => String(v || "").toLowerCase()).join(" ");
    return hay.includes(s);
  }

  function renderExpiryTable() {
    if (!expiryTbody) return;
    const q = (expirySearch?.value || "").trim();
    const rows = __expiryItems.filter(it => matchesExpirySearch(it, q));
    expiryTbody.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "muted";
      td.style.padding = "14px 10px";
      td.textContent = q ? "No matching results / Babu sakamakon da ya dace" : "No data / Babu bayanai";
      tr.appendChild(td);
      expiryTbody.appendChild(tr);
    } else {
      for (const it of rows) {
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.innerHTML = `<div style="font-weight:700">${escapeHtml(it.name || "—")}</div>
          <div class="muted tiny">${escapeHtml(it.productId || "")}</div>`;
        tr.appendChild(tdName);

        const tdBar = document.createElement("td");
        tdBar.textContent = it.barcode || "—";
        tr.appendChild(tdBar);

        const tdSku = document.createElement("td");
        tdSku.textContent = it.sku || "—";
        tr.appendChild(tdSku);

        const tdExp = document.createElement("td");
        const dl = Number(it.daysLeft ?? 0);
        tdExp.innerHTML = `<div style="font-weight:700">${escapeHtml(it.expiryDate || "—")}</div>
          <div class="muted tiny">${dl < 0 ? (Math.abs(dl) + " days ago") : (dl + " days left")}</div>`;
        tr.appendChild(tdExp);

        const tdQty = document.createElement("td");
        tdQty.style.textAlign = "right";
        tdQty.textContent = String(it.stock ?? 0);
        tr.appendChild(tdQty);

        expiryTbody.appendChild(tr);
      }
    }

    if (expiryCountPill) {
      const n = rows.length;
      expiryCountPill.textContent = `${n} item${n === 1 ? "" : "s"}`;
    }
  }

  async function openExpiryModal(type) {
    currentExpiryType = (type || "expired");

    __expiryType = (type || "expired").toLowerCase();
    const shopId = String(window.__spng_shopId || "").trim();
    if (!shopId) return;

    const isExpired = (__expiryType === "expired");
    if (expiryModalTitle) {
      expiryModalTitle.textContent = isExpired ? "Expired Products / Kayayyakin da suka expired" : "Expiring Soon / Kayayyaki na kusa karewa";
    }
    if (expiryModalSub) expiryModalSub.textContent = "Loading…";

    setExpiryOverlayVisible(true);

    try {
      const data = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/expiry?type=${encodeURIComponent(isExpired ? "expired" : "soon")}`);
      __expiryItems = Array.isArray(data.items) ? data.items : [];
      const shopName = (data.shop && (data.shop.shopName || data.shop.name)) || "";
      const soonDays = Number(data.soonDays || 90);
      const count = Number(data.count || __expiryItems.length || 0);
      if (expiryModalSub) {
        expiryModalSub.textContent = isExpired
          ? `Shop: ${shopName || shopId} • ${count} items`
          : `Shop: ${shopName || shopId} • ${count} items • Soon window: ${soonDays} days`;
      }
      renderExpiryTable();
      if (expirySearch) expirySearch.focus();
    } catch (e) {
      if (expiryModalSub) expiryModalSub.textContent = String(e?.message || "Failed to load");
      __expiryItems = [];
      renderExpiryTable();
    }
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function api(path, opts = {}) {
    const token = localStorage.getItem(LS_TOKEN) || "";
    const headers = { ...(opts.headers || {}) };

    // Add JSON content-type only when body is present and caller didn't set it.
    const hasBody = Object.prototype.hasOwnProperty.call(opts, "body") && opts.body != null;
    if (hasBody && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    // Attach owner token automatically for owner APIs (except login)
    if (!headers["Authorization"] && token && String(path).startsWith("/api/owner/") && !String(path).startsWith("/api/owner/auth/")) {
      headers["Authorization"] = "Bearer " + token;
    }

    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.error || data.message || ("HTTP " + res.status);
      throw new Error(msg);
    }
    return data;
  }

  function setTab(tab) {
    tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle("hidden", k !== tab);
    });
  }

  function clearTable(tbody, cols, emptyText = "No data") {
    if (!tbody) return;
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = cols;
    td.className = "muted";
    td.textContent = emptyText;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // ------------------------------
  // Modal helper (Debtor Payments)
  // ------------------------------
  function openModal(contentHtml) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <button class="modal-close" type="button" aria-label="Close">×</button>
        <div class="modal-title">Record Debtor Payment</div>
        <div class="modal-content">${contentHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".modal-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return { overlay, close };
  }

  function setKpis(kpi) {
    if (!kpisWrap) return;
    kpisWrap.innerHTML = "";

    const items = [
      { k: "Products", v: kpi?.products ?? 0 },
      { k: "Sales", v: kpi?.sales ?? 0 },
      { k: "Debtors", v: kpi?.debtors ?? 0 },
      { k: "Revenue", v: money(kpi?.totalSales ?? 0) },
      { k: "Paid", v: money(kpi?.totalPaid ?? 0) },
      { k: "Balance", v: money(kpi?.totalRemaining ?? 0) },
      { k: "Low Stock", v: kpi?.lowStock ?? 0, tone: "warn" },
      { k: "Expiring Soon", v: kpi?.expiringSoon ?? 0, tone: "warn" },
      { k: "Expired", v: kpi?.expired ?? 0, tone: "danger" },
    ];

    // Bilingual alert bar + sound for expired
    const expired = Number(kpi?.expired ?? 0);
    const soon = Number(kpi?.expiringSoon ?? 0);
    showExpiryButtons(expired, soon);
    const shopKey = (window.__spng_shopId || "shop") + "";
    const lastExpired = Number(sessionStorage.getItem("spng_lastExpired_" + shopKey) || "0");

    if (expired > 0) {
      setAlert("danger",
        `<div style="font-weight:800;margin-bottom:4px">⚠️ Expired products detected</div>
         <div class="muted">Sale blocked for expired items. Please remove expired stock before selling.</div>
         <div style="height:6px"></div>
         <div style="font-weight:800;margin-bottom:4px">⚠️ An gano kayayyakin da suka expired</div>
         <div class="muted">An hana sayar da expired items. Ka cire expired stock kafin ka sayar.</div>`
      );
      if (expired > lastExpired && isAdminUser()) playExpiredBlockSound();
      sessionStorage.setItem("spng_lastExpired_" + shopKey, String(expired));
    } else if (soon > 0) {
      setAlert("warn",
        `<div style="font-weight:800;margin-bottom:4px">⏳ Products expiring soon</div>
         <div class="muted">Some items will expire soon. Please discount or prioritize selling them.</div>
         <div style="height:6px"></div>
         <div style="font-weight:800;margin-bottom:4px">⏳ Kayayyaki na kusa karewa</div>
         <div class="muted">Wasu kaya suna kusa karewa. Ka fifita sayar da su ko ka yi rangwame.</div>`
      );
    } else {
      setAlert("", "");
      sessionStorage.setItem("spng_lastExpired_" + shopKey, "0");
    }



    // Keep it neat: 6 KPI cards (2 rows on desktop)
    items.forEach((it) => {
      const d = document.createElement("div");
      d.className = "kpi";
      d.innerHTML = `<div class="muted">${escapeHtml(it.k)}</div><div class="v">${escapeHtml(it.v)}</div>${it.tone ? `<div class="badge ${it.tone}">${it.tone === "danger" ? "Critical" : "Alert"}</div>` : ""}`;
      kpisWrap.appendChild(d);
    });
  }

  function rowCells(values) {
    const tr = document.createElement("tr");
    values.forEach((v) => {
      const td = document.createElement("td");
      td.textContent = v == null ? "" : String(v);
      tr.appendChild(td);
    });
    return tr;
  }

  async function doLogin() {
    showLoginErr("");
    btnLogin.disabled = true;
    try {
      const email = $("email").value.trim();
      const password = $("password").value.trim();
      const data = await api("/api/owner/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem(LS_TOKEN, data.token || "");
      await loadMe();
    } catch (e) {
      showLoginErr(e.message || String(e));
    } finally {
      btnLogin.disabled = false;
    }
  }

  function showLogin() {
    shopCard.classList.add("hidden");
    meCard.classList.add("hidden");
    loginCard.classList.remove("hidden");
  }

  function showMe() {
    shopCard.classList.add("hidden");
    loginCard.classList.add("hidden");
    meCard.classList.remove("hidden");
  }

  function showShop() {
    loginCard.classList.add("hidden");
    meCard.classList.add("hidden");
    shopCard.classList.remove("hidden");
  }

  async function loadMe() {
    showLoginErr("");
    showShopErr("");

    const token = localStorage.getItem(LS_TOKEN) || "";
    if (!token) return showLogin();

    try {
      const data = await api("/api/owner/me");
      meEmail.textContent = data.owner?.email || "";

      const shops = Array.isArray(data.owner?.shops) ? data.owner.shops : [];
      shopsWrap.innerHTML = "";
      shopsWrap.className = "shopsList";

      if (!shops.length) {
        const p = document.createElement("div");
        p.className = "muted";
        p.textContent = "No shops assigned to this owner account.";
        shopsWrap.appendChild(p);
      } else {
        shops.forEach((s) => {
          const div = document.createElement("div");
          div.className = "shop shopBtn";
          div.innerHTML = `
            <div style="font-weight:800">${escapeHtml(s.shopName || "Shop")}</div>
            <div class="muted">Shop ID: ${escapeHtml(s.shopId || "")} • Code: ${escapeHtml(s.shopCode || "")}</div>
          `;
          div.addEventListener("click", () => selectShop(s.shopId, s.shopName));
          shopsWrap.appendChild(div);
        });
      }

      showMe();
    } catch (e) {
      // token invalid/expired
      localStorage.removeItem(LS_TOKEN);
      showLoginErr(e.message || "Please login again");
      showLogin();
    }
  }

  
  
  function renderSalesTrend(trend, days) {
    const rows = Array.isArray(trend?.salesByDay) ? trend.salesByDay : [];
    if (trendMeta) trendMeta.textContent = `Last ${days} days`;

    if (!trendBarsEl) return;
    trendBarsEl.innerHTML = "";
    if (!rows.length) {
      trendBarsEl.innerHTML = `<div class="muted small" style="padding:8px">No trend data</div>`;
      return;
    }

    const max = Math.max(1, ...rows.map(r => Number(r.revenue || 0)));
    // Show the most recent 12 points for readability (still respects 7/30/90 range)
    const view = rows.slice(-12);

    view.forEach(r => {
      const day = String(r.day || "");
      const label = day ? day.slice(5) : ""; // MM-DD
      const revenue = Number(r.revenue || 0);
      const pct = Math.max(2, Math.round((revenue / max) * 100));

      const row = document.createElement("div");
      row.className = "trendRow";
      row.innerHTML = `
        <div class="trendDate">${escapeHtml(label)}</div>
        <div class="trendBarWrap"><div class="trendBar" style="width:${pct}%"></div></div>
        <div class="trendVal">${money(revenue)}</div>
      `;
      trendBarsEl.appendChild(row);
    });
  }

  function renderTopProducts(perf) {
    if (!topProductsListEl) return;
    const top = Array.isArray(perf?.topProducts) ? perf.topProducts.slice(0, 10) : [];
    topProductsListEl.innerHTML = "";
    if (!top.length) {
      topProductsListEl.innerHTML = `<div class="muted small" style="padding:8px">No top products</div>`;
      return;
    }

    top.forEach((x) => {
      const name = (x.name || x.key || "").trim() || "—";
      const qty = Number(x.qty || 0);
      const revenue = Number(x.revenue || 0);

      const row = document.createElement("div");
      row.className = "tpRow";
      row.innerHTML = `
        <div class="tpName">${escapeHtml(name)}</div>
        <div class="tpMeta">${money(revenue)}</div>
        <div class="tpQty">${qty}</div>
      `;
      topProductsListEl.appendChild(row);
    });
  }

  function renderProfit(profit) {
    // profit payload shape: { summary:{today, d7, d30, currency, hasCost}, byDay:[{day,revenue,profit,salesCount}] }
    try {
      const cur = (profit?.summary?.currency || "").trim();
      const hasCost = !!profit?.summary?.hasCost;
      if (profitNote) {
        profitNote.textContent = hasCost ? "" : "Note: Profit requires cost price. Showing revenue; profit may be 0 if cost is missing.";
      }

      if (profitMeta) profitMeta.textContent = `Updated: ${new Date().toLocaleString()}`;

      if (profitToday) profitToday.textContent = money(profit?.summary?.today ?? 0);
      if (profit7d) profit7d.textContent = money(profit?.summary?.d7 ?? 0);
      if (profit30d) profit30d.textContent = money(profit?.summary?.d30 ?? 0);

      if (!profitTableBody) return;
      profitTableBody.innerHTML = "";
      const rows = Array.isArray(profit?.byDay) ? profit.byDay.slice(-14).reverse() : [];
      if (!rows.length) {
        profitTableBody.innerHTML = `<tr><td colspan="4" class="muted small">No profit data</td></tr>`;
        return;
      }

      rows.forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(String(r.day || ""))}</td>
          <td style="text-align:right">${money(r.revenue || 0)}</td>
          <td style="text-align:right">${money(r.profit || 0)}</td>
          <td style="text-align:right">${Number(r.salesCount || 0)}</td>
        `;
        profitTableBody.appendChild(tr);
      });
    } catch (_e) {}
  }
function renderMiniLists(perf) {
    if (!bestSellersWrap || !slowMovingWrap) return;
    const best = Array.isArray(perf?.topProducts) ? perf.topProducts.slice(0, 5) : [];
    const slow = Array.isArray(perf?.slowProducts) ? perf.slowProducts.slice(0, 5) : [];

    bestSellersWrap.innerHTML = best.length ? "" : `<div class="muted">No data</div>`;
    slowMovingWrap.innerHTML = slow.length ? "" : `<div class="muted">No data</div>`;

    best.forEach((x) => {
      const div = document.createElement("div");
      div.className = "miniItem";
      div.innerHTML = `<div><b>${escapeHtml(x.name || x.key)}</b><div class="muted tiny">Qty: ${escapeHtml(x.qty ?? 0)} • Value: ${escapeHtml(money(x.value ?? 0))}</div></div><div class="badge">Hot</div>`;
      bestSellersWrap.appendChild(div);
    });

    slow.forEach((x) => {
      const div = document.createElement("div");
      div.className = "miniItem";
      div.innerHTML = `<div><b>${escapeHtml(x.name || x.key)}</b><div class="muted tiny">Sold: ${escapeHtml(x.qty ?? 0)} • Stock: ${escapeHtml(x.stock ?? 0)}</div></div><div class="badge warn">Slow</div>`;
      slowMovingWrap.appendChild(div);
    });
  }

  async function refreshOverview(daysOverride) {
    const shopId = selectedShopId;
    if (!shopId) return;
    const days = Number(daysOverride || currentRangeDays || 30) || 30;
    currentRangeDays = days;

    const ov = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/overview?days=${encodeURIComponent(days)}&lowStock=3`);
    const shop = ov.shop || { shopId };
    shopTitle.textContent = shop.shopName || "Shop";
    shopMeta.textContent = `Shop ID: ${shop.shopId || shopId}${shop.shopCode ? " • Code: " + shop.shopCode : ""}`;


    // Expiring-soon setting UI
    try {
      const sd = Number(ov?.range?.soonDays || 90) || 90;
      if (soonDaysSelect) {
        const preset = ["30","60","90"].includes(String(sd)) ? String(sd) : "custom";
        soonDaysSelect.value = preset;
      }
      if (soonDaysCustom) {
        soonDaysCustom.value = (["30","60","90"].includes(String(sd))) ? "" : String(sd);
      }
      if (soonDaysMsg) soonDaysMsg.textContent = `Current: ${sd} days`;
    } catch (_e) {}

    setKpis(ov.kpi || {});
    renderSalesTrend(ov.trend || {}, days);
    renderTopProducts(ov.productPerformance || {});
    renderMiniLists(ov.productPerformance || {});
    // Profit + daily table
    try {
      const ins = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/insights?days=${encodeURIComponent(days)}`);
      if (ins && ins.ok !== false) {
        renderProfit(ins.profit || {});
      }
    } catch(_e) {}
  }

async function loadOverview() {
    return refreshOverview(currentRangeDays);
  }

  async function loadProducts() {
    const shopId = selectedShopId;
    if (!shopId) return;

    const q = (qProducts?.value || "").trim();
    const pr = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/products${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    const items = Array.isArray(pr.items) ? pr.items : [];
    productsBody.innerHTML = "";
    if (!items.length) return clearTable(productsBody, 4, "No products");

    items.forEach((p) => {
      productsBody.appendChild(
        rowCells([
          p.name || "",
          p.barcode || p.sku || "",
          p.stock ?? p.qty ?? 0,
          money(p.price ?? 0),
        ])
      );
    });
  }

  async function loadSales() {
    const shopId = selectedShopId;
    if (!shopId) return;

    const sr = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/sales?limit=2000`);
    salesCache = Array.isArray(sr.items) ? sr.items : [];
    renderSales();
  }

  function renderSales() {
    const q = (qSales?.value || "").trim().toLowerCase();
    let items = Array.isArray(salesCache) ? salesCache : [];
    if (q) {
      items = items.filter((s) => {
        const receipt = String(s.receiptNo || "").toLowerCase();
        const staff = String(s.staffUser || "").toLowerCase();
        const method = String(s.paymentMethod || "").toLowerCase();
        const status = String(s.status || "").toLowerCase();
        return receipt.includes(q) || staff.includes(q) || method.includes(q) || status.includes(q);
      });
    }

    salesBody.innerHTML = "";
    if (!items.length) return clearTable(salesBody, 9, q ? "No matches" : "No sales");

    items.forEach((s) => {
      const ts = s.createdAt ? new Date(Number(s.createdAt)).toLocaleString() : "";
      salesBody.appendChild(
        rowCells([
          s.receiptNo || "",
          s.staffUser || "",
          s.paymentMethod || "",
          s.status || "",
          String(s.itemsCount ?? 0),
          money(s.paid ?? 0),
          money(s.remaining ?? 0),
          money(s.total ?? 0),
          ts,
        ])
      );
    });
  }

  async function loadDebtors() {
    const shopId = selectedShopId;
    if (!shopId) return;

    const dr = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/debtors`);
    debtorsCache = Array.isArray(dr.items) ? dr.items : [];
    renderDebtors();
  }

  function renderDebtors() {
    const q = (qDebtors?.value || "").trim().toLowerCase();
    let items = Array.isArray(debtorsCache) ? debtorsCache : [];

    // Ensure newest first
    items = items.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    if (q) {
      items = items.filter((d) => {
        const name = String(d.customerName || "").toLowerCase();
        const phone = String(d.customerPhone || "").toLowerCase();
        const receipt = String(d.receiptNo || "").toLowerCase();
        const status = String(d.status || "").toLowerCase();
        return name.includes(q) || phone.includes(q) || receipt.includes(q) || status.includes(q);
      });
    }

    debtorsBody.innerHTML = "";
    if (!items.length) return clearTable(debtorsBody, 9, q ? "No matches" : "No debtors");

    items.forEach((d) => {
      const ts = d.createdAt ? new Date(Number(d.createdAt)).toLocaleString() : "";
      const paid = Number(d.paid || 0);
      const balance = Number((d.balance ?? d.remaining) || 0);
      const total = Number(d.total || (paid + balance) || 0);
      const canPay = balance > 0.0001;

      const tr = document.createElement("tr");
      const cells = [
        d.customerName || "",
        d.customerPhone || "",
        d.receiptNo || "",
        d.status || "",
        money(paid),
        money(balance),
        money(total),
        ts,
      ];
      cells.forEach((txt) => {
        const td = document.createElement("td");
        td.textContent = txt;
        tr.appendChild(td);
      });

      const actionTd = document.createElement("td");
      if (canPay) {
        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.textContent = "Record payment";
        btn.addEventListener("click", () => openPayDebtorModal(d));
        actionTd.appendChild(btn);
      } else {
        const span = document.createElement("span");
        span.className = "badge";
        span.textContent = "Paid";
        actionTd.appendChild(span);
      }
      tr.appendChild(actionTd);
      debtorsBody.appendChild(tr);
    });
  }

  function openPayDebtorModal(row) {
    const paid = Number(row.paid || 0);
    const balance = Number((row.balance ?? row.remaining) || 0);
    const total = Number(row.total || (paid + balance) || 0);

    const html = `
      <div class="modal-header">
        <div class="modal-title">Record Debtor Payment</div>
        <button class="icon-btn" data-close>&times;</button>
      </div>
      <div class="modal-sub">
        <div><b>${escapeHtml(row.customerName || "")}</b> • ${escapeHtml(row.customerPhone || "")}</div>
        <div class="muted">Receipt: ${escapeHtml(row.receiptNo || "")}</div>
        <div class="muted">Total: ${money(total)} • Paid: ${money(paid)} • Balance: ${money(balance)}</div>
      </div>
      <form id="payDebtorForm" class="modal-form">
        <label>Amount</label>
        <input id="payAmount" type="number" min="0" step="0.01" placeholder="e.g. 5000" required />

        <label>Method</label>
        <select id="payMethod">
          <option value="CASH">CASH</option>
          <option value="TRANSFER">TRANSFER</option>
          <option value="POS">POS</option>
        </select>

        <label>Note (optional)</label>
        <input id="payNote" type="text" placeholder="..." />

        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close>Cancel</button>
          <button type="submit" class="btn">Save payment</button>
        </div>
        <div id="payErr" class="err" style="margin-top:10px;"></div>
      </form>
    `;

    const modal = openModal(html);
    const form = modal.querySelector("#payDebtorForm");
    const err = modal.querySelector("#payErr");
    const amountEl = modal.querySelector("#payAmount");
    amountEl.value = String(Math.min(balance, balance) || "");
    amountEl.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const amount = Number(amountEl.value || 0);
      const method = String(modal.querySelector("#payMethod").value || "CASH");
      const note = String(modal.querySelector("#payNote").value || "");
      if (!amount || amount <= 0) {
        err.textContent = "Enter a valid amount.";
        return;
      }

      try {
        await api(`/api/owner/shop/${encodeURIComponent(selectedShopId)}/debtors/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptNo: row.receiptNo, phone: row.customerPhone, amount, method, note }),
        });
        modal.close();
        await loadDebtors();
        await loadKPIs();
      } catch (ex) {
        err.textContent = (ex && ex.message) ? ex.message : "Failed";
      }
    });
  }

  async function selectShop(shopId, shopName) {
    try {
      showShopErr("");
      selectedShopId = String(shopId || "");
      if (!selectedShopId) return;

      showShop();
      shopTitle.textContent = shopName || "Shop";
      shopMeta.textContent = `Shop ID: ${selectedShopId}`;

      // preload placeholders
      setKpis({ products: 0, sales: 0, debtors: 0, totalSales: 0, totalPaid: 0, totalRemaining: 0 });
      clearTable(productsBody, 4, "Loading...");
      clearTable(salesBody, 9, "Loading...");
      clearTable(debtorsBody, 9, "Loading...");

      await loadOverview();
      await loadProducts();
      await loadSales();
      await loadDebtors();

      setTab("products");
    } catch (e) {
      console.error(e);
      showShopErr(e.message || String(e));
    }
  }

  function logout() {
    localStorage.removeItem(LS_TOKEN);
    selectedShopId = "";
    showLogin();
  }


  async function saveSoonDaysSetting() {
    const shopId = selectedShopId;
    if (!shopId) return;
    let val = 0;
    const sel = (soonDaysSelect?.value || "").trim();
    if (sel === "custom") val = parseInt((soonDaysCustom?.value || "0").trim(), 10);
    else val = parseInt(sel || "0", 10);

    if (!Number.isFinite(val) || val <= 0 || val > 365) {
      if (soonDaysMsg) soonDaysMsg.textContent = "Please enter 1 - 365 days";
      return;
    }

    try {
      if (btnSaveSoonDays) btnSaveSoonDays.disabled = true;
      if (soonDaysMsg) soonDaysMsg.textContent = "Saving...";
      await api(`/api/owner/shop/${encodeURIComponent(shopId)}/settings/expirySoonDays`, {
        method: "POST",
        body: JSON.stringify({ soonDays: val })
      });
      if (soonDaysMsg) soonDaysMsg.textContent = `Saved: ${val} days`;
      await refreshOverview(currentRangeDays || 30);
    } catch (e) {
      if (soonDaysMsg) soonDaysMsg.textContent = e.message || "Save failed";
    } finally {
      if (btnSaveSoonDays) btnSaveSoonDays.disabled = false;
    }
  }


  // Events
  btnLogin?.addEventListener("click", doLogin);
  $("password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  btnLogout?.addEventListener("click", logout);
  btnBack?.addEventListener("click", () => {
    selectedShopId = "";
    showMe();
  });
  btnSaveSoonDays?.addEventListener("click", saveSoonDaysSetting);
  soonDaysSelect?.addEventListener("change", () => {
    const v = (soonDaysSelect?.value || "").trim();
    if (soonDaysCustom) soonDaysCustom.classList.toggle("hidden", v !== "custom");
  });

  tabBtns.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  btnBack?.addEventListener("click", () => {
    selectedShopId = "";
    showMe();
  });

  // Product search debounce
  const onProductsSearch = debounce(() => {
    loadProducts().catch((e) => showShopErr(e.message || String(e)));
  }, 200);
  qProducts?.addEventListener("input", onProductsSearch);

  const onSalesSearch = debounce(() => {
    try { renderSales(); } catch (e) {}
  }, 120);
  qSales?.addEventListener("input", onSalesSearch);

  const onDebtorsSearch = debounce(() => {
    try { renderDebtors(); } catch (e) {}
  }, 120);
  qDebtors?.addEventListener("input", onDebtorsSearch);

  btnReloadSales?.addEventListener("click", () => loadSales().catch((e) => showShopErr(e.message || String(e))));
  btnReloadDebtors?.addEventListener("click", () => loadDebtors().catch((e) => showShopErr(e.message || String(e))));

  // Boot
  loadMe().catch(() => showLogin());
})();