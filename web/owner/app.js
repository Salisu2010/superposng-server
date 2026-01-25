(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const LS_TOKEN = "spng_owner_token";

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
  const kpisWrap = $("kpis");

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
  let salesCache = [];
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

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s])
    );
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
    ];

    // Keep it neat: 6 KPI cards (2 rows on desktop)
    items.forEach((it) => {
      const d = document.createElement("div");
      d.className = "kpi";
      d.innerHTML = `<div class="muted">${escapeHtml(it.k)}</div><div class="v">${escapeHtml(it.v)}</div>`;
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

  async function loadOverview() {
    const shopId = selectedShopId;
    if (!shopId) return;

    const ov = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/overview`);
    const shop = ov.shop || { shopId };
    shopTitle.textContent = shop.shopName || "Shop";
    shopMeta.textContent = `Shop ID: ${shop.shopId || shopId}${shop.shopCode ? " • Code: " + shop.shopCode : ""}`;
    setKpis(ov.kpi || {});
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

  // Events
  btnLogin?.addEventListener("click", doLogin);
  $("password")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin();
  });
  btnLogout?.addEventListener("click", logout);

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
