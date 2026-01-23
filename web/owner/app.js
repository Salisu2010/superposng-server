(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem("sp_owner_token") || "",
    owner: null,
    shopId: localStorage.getItem("sp_owner_shop") || "",
    debounce: null,
  };

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (state.token) headers.Authorization = "Bearer " + state.token;
    const res = await fetch("/api/owner" + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.error || data.message || "Request failed";
      throw new Error(msg);
    }
    return data;
  }

  function show(view) {
    $("loginView").style.display = view === "login" ? "block" : "none";
    $("dashView").style.display = view === "dash" ? "block" : "none";
    $("btnLogout").style.display = view === "dash" ? "inline-flex" : "none";
  }

  function fmtMoney(n) {
    const x = Number(n || 0);
    return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setKpis(k) {
    const items = [
      ["Revenue", "₦ " + fmtMoney(k.revenue)],
      ["Paid", "₦ " + fmtMoney(k.paid)],
      ["Balance", "₦ " + fmtMoney(k.balance)],
      ["Sales", String(k.salesCount)],
      ["Products", String(k.productsCount)],
      ["Debtors", String(k.debtorsCount)],
      ["Low Stock", String(k.lowStockCount)],
      ["Expiring Soon", String(k.expiringSoonCount)],
      ["Expired", String(k.expiredCount)],
    ];

    const grid = $("kpiGrid");
    grid.innerHTML = "";
    for (const [label, value] of items) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
      grid.appendChild(div);
    }
  }

  function tab(name) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tabpane").forEach((p) => (p.style.display = "none"));
    $("tab_" + name).style.display = "block";
  }

  function setShopSelector(shops) {
    const sel = $("shopSelect");
    if (!shops || shops.length === 0) {
      sel.style.display = "none";
      return;
    }

    sel.style.display = "inline-flex";
    sel.innerHTML = shops.map((id) => `<option value="${id}">${id}</option>`).join("");

    if (!state.shopId || !shops.includes(state.shopId)) state.shopId = shops[0];
    sel.value = state.shopId;
    localStorage.setItem("sp_owner_shop", state.shopId);

    sel.onchange = async () => {
      state.shopId = sel.value;
      localStorage.setItem("sp_owner_shop", state.shopId);
      await refreshAll();
    };
  }

  async function refreshSync() {
    const d = await api(`/sync-status?shopId=${encodeURIComponent(state.shopId)}`);
    const t = d.lastSyncedAt ? new Date(d.lastSyncedAt).toLocaleString() : "Never";
    $("syncText").textContent = `Last synced: ${t} ${d.lastSyncSource ? " • " + d.lastSyncSource : ""}`;
  }

  async function refreshOverview() {
    const d = await api(`/overview?shopId=${encodeURIComponent(state.shopId)}`);
    setKpis(d.kpis || {});
  }

  async function loadProducts(q = "") {
    const d = await api(`/products?shopId=${encodeURIComponent(state.shopId)}&q=${encodeURIComponent(q)}`);
    const tbody = $("productsTable").querySelector("tbody");
    tbody.innerHTML = "";
    (d.items || []).forEach((p) => {
      const tr = document.createElement("tr");
      const sku = p.sku || p.plu || p.skuPlu || p.sku_plu || "";
      const exp = p.expiryDate || p.expiry || "";
      const price = p.price ?? p.sellingPrice ?? 0;
      tr.innerHTML = `
        <td>${p.name || ""}</td>
        <td>${sku}</td>
        <td>${p.barcode || ""}</td>
        <td>${Number(p.stock || 0)}</td>
        <td>${Number(p.lowStockLevel || 0)}</td>
        <td>₦ ${fmtMoney(price)}</td>
        <td>${exp}</td>
      `;
      tbody.appendChild(tr);
    });

    $("btnExportProducts").href = `/api/owner/export/products.csv?shopId=${encodeURIComponent(state.shopId)}&q=${encodeURIComponent(q)}`;
  }

  async function loadSales() {
    const from = $("fromDate").value || "";
    const to = $("toDate").value || "";
    const d = await api(`/sales?shopId=${encodeURIComponent(state.shopId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const tbody = $("salesTable").querySelector("tbody");
    tbody.innerHTML = "";
    (d.items || []).forEach((s) => {
      const tr = document.createElement("tr");
      const dt = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
      tr.innerHTML = `
        <td>${dt}</td>
        <td>${s.receiptNo || ""}</td>
        <td>${(s.customerName || "")}</td>
        <td>₦ ${fmtMoney(s.total)}</td>
        <td>₦ ${fmtMoney(s.paid)}</td>
        <td>₦ ${fmtMoney(s.remaining)}</td>
        <td>${s.cashier || s.staffName || ""}</td>
      `;
      tbody.appendChild(tr);
    });
    $("btnExportSales").href = `/api/owner/export/sales.csv?shopId=${encodeURIComponent(state.shopId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  async function refreshAll() {
    await Promise.all([refreshOverview(), refreshSync()]);
    // keep tables on current tab
    const active = document.querySelector(".tab.active")?.dataset?.tab || "overview";
    if (active === "products") await loadProducts($("productSearch").value || "");
    if (active === "sales") await loadSales();
  }

  async function initAuthed() {
    const me = await api("/me");
    state.owner = me.owner;
    setShopSelector(me.owner.shops || []);
    show("dash");
    tab("overview");
    await refreshAll();
  }

  $("btnLogin").onclick = async () => {
    $("loginMsg").textContent = "";
    try {
      const email = $("email").value;
      const password = $("password").value;
      const d = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      state.token = d.token;
      localStorage.setItem("sp_owner_token", state.token);
      await initAuthed();
    } catch (e) {
      $("loginMsg").textContent = e.message || "Login failed";
    }
  };

  $("btnLogout").onclick = () => {
    localStorage.removeItem("sp_owner_token");
    localStorage.removeItem("sp_owner_shop");
    state.token = "";
    state.shopId = "";
    show("login");
  };

  $("btnRefresh").onclick = refreshAll;

  document.querySelectorAll(".tab").forEach((b) => {
    b.onclick = async () => {
      tab(b.dataset.tab);
      if (b.dataset.tab === "products") await loadProducts($("productSearch").value || "");
      if (b.dataset.tab === "sales") await loadSales();
    };
  });

  $("productSearch").addEventListener("input", () => {
    clearTimeout(state.debounce);
    state.debounce = setTimeout(() => loadProducts($("productSearch").value || ""), 180);
  });

  $("btnLoadSales").onclick = loadSales;

  // Boot
  (async () => {
    if (!state.token) return show("login");
    try {
      await initAuthed();
    } catch (_e) {
      show("login");
    }
  })();
})();
