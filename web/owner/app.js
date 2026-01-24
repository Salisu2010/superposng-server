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

    const sr = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/sales?limit=200`);
    const items = Array.isArray(sr.items) ? sr.items : [];
    salesBody.innerHTML = "";
    if (!items.length) return clearTable(salesBody, 4, "No sales");

    items.forEach((s) => {
      const ts = s.createdAt ? new Date(Number(s.createdAt)).toLocaleString() : "";
      salesBody.appendChild(
        rowCells([
          s.receiptNo || s.receipt || "",
          s.staffUser || s.staffName || "",
          ts,
          money(s.total ?? 0),
        ])
      );
    });
  }

  async function loadDebtors() {
    const shopId = selectedShopId;
    if (!shopId) return;

    const dr = await api(`/api/owner/shop/${encodeURIComponent(shopId)}/debtors`);
    const items = Array.isArray(dr.items) ? dr.items : [];
    debtorsBody.innerHTML = "";
    if (!items.length) return clearTable(debtorsBody, 4, "No debtors");

    items.forEach((d) => {
      debtorsBody.appendChild(
        rowCells([
          d.customerName || d.name || "",
          d.receiptNo || d.receipt || "",
          d.customerPhone || d.phone || "",
          money(d.remaining ?? d.balance ?? d.amount ?? 0),
        ])
      );
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
      clearTable(salesBody, 4, "Loading...");
      clearTable(debtorsBody, 4, "Loading...");

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
  let qTimer = null;
  qProducts?.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      loadProducts().catch((e) => showShopErr(e.message || String(e)));
    }, 200);
  });

  btnReloadSales?.addEventListener("click", () => loadSales().catch((e) => showShopErr(e.message || String(e))));
  btnReloadDebtors?.addEventListener("click", () => loadDebtors().catch((e) => showShopErr(e.message || String(e))));

  // Boot
  loadMe().catch(() => showLogin());
})();
