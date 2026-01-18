/* SuperPOSNG Local Hub Dashboard (no framework)
 * - Reads data from /api/dashboard/* endpoints
 * - Designed for offline LAN use
 */

const $ = (id) => document.getElementById(id);
const fmtN = (n) => {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const fmtMoney = (n, currencySymbol = "₦") => `${currencySymbol}${fmtN(n)}`;

const fmtDateTime = (ts) => {
  const d = new Date(Number(ts || 0));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
};

function toast(msg, isErr = false){
  const t = $("toast");
  t.textContent = msg;
  t.style.borderColor = isErr ? "rgba(239,68,68,.55)" : "rgba(255,255,255,.1)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path){
  const r = await fetch(path, { cache: "no-store" });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Request failed");
  return j;
}

function setActiveTab(key){
  document.querySelectorAll(".navBtn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === key);
  });
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  const el = $("tab-" + key);
  if (el) el.classList.add("active");
  $("pageTitle").textContent = key === "staff" ? "Staff Performance" : (key.charAt(0).toUpperCase() + key.slice(1));
}

function renderBars(el, points){
  // points: [{day, revenue, count}] for N days
  el.innerHTML = "";
  const max = Math.max(1, ...points.map(p => Number(p.revenue || 0)));
  for (const p of points){
    const v = Number(p.revenue || 0);
    const h = Math.max(2, Math.round((v / max) * 100));
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = h + "%";
    bar.title = `${p.day}\nRevenue: ${fmtN(v)}\nReceipts: ${fmtN(p.count)}`;
    el.appendChild(bar);
  }
}

function renderMiniList(el, rows, labelKey, valueKey, valueFmt){
  el.innerHTML = "";
  if (!rows || rows.length === 0){
    const e = document.createElement("div");
    e.className = "chip";
    e.innerHTML = `<div class="k">No data</div><div class="v">—</div>`;
    el.appendChild(e);
    return;
  }
  for (const r of rows){
    const c = document.createElement("div");
    c.className = "chip";
    const vv = valueFmt ? valueFmt(r[valueKey]) : r[valueKey];
    c.innerHTML = `<div class="k">${(r[labelKey] ?? "").toString()}</div><div class="v">${vv}</div>`;
    el.appendChild(c);
  }
}

function kv(el, obj){
  el.innerHTML = "";
  const entries = Object.entries(obj || {});
  for (const [k, v] of entries){
    if (v === undefined || v === null) continue;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div>${k}</div><div class="value">${(v === "" ? "—" : v)}</div>`;
    el.appendChild(row);
  }
}

function fillTable(tableId, rows, cols){
  const tb = document.querySelector(`#${tableId} tbody`);
  tb.innerHTML = "";
  if (!rows || rows.length === 0){
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = cols.length;
    td.className = "tiny";
    td.textContent = "No records";
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  for (const r of rows){
    const tr = document.createElement("tr");
    for (const c of cols){
      const td = document.createElement("td");
      const v = c.get(r);
      td.textContent = v;
      if (c.right) td.classList.add("right");
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
}

let state = {
  shops: [],
  shopId: "",
  days: 30,
  currency: "₦",
};

async function loadShops(){
  const j = await api("/api/dashboard/shops");
  state.shops = j.items || [];
  const sel = $("shopSelect");
  sel.innerHTML = "";
  for (const s of state.shops){
    const opt = document.createElement("option");
    opt.value = s.shopId;
    opt.textContent = `${s.shopName || "Shop"}  •  ${s.shopCode || s.shopId}`;
    sel.appendChild(opt);
  }

  // pick last used from localStorage, else first
  const saved = localStorage.getItem("spng_shopId") || "";
  const found = state.shops.find(x => x.shopId === saved);
  state.shopId = found ? found.shopId : (state.shops[0]?.shopId || "");
  sel.value = state.shopId;
}

async function refreshAll(){
  if (!state.shopId){
    toast("No shop found in hub db.json", true);
    return;
  }

  localStorage.setItem("spng_shopId", state.shopId);
  const days = state.days;

  const ov = await api(`/api/dashboard/overview?shopId=${encodeURIComponent(state.shopId)}&days=${encodeURIComponent(days)}`);
  const shop = ov.shop || {};
  state.currency = shop.currency && shop.currency.trim() ? (shop.currency.trim().toUpperCase() === "N" ? "₦" : shop.currency.trim()) : "₦";

  $("shopHint").textContent = `${shop.shopName || ""}${shop.shopCode ? " • " + shop.shopCode : ""}`;
  $("serverTime").textContent = `Server: ${fmtDateTime(ov.serverTime)}`;
  $("trendSub").textContent = `Last ${days} days • ${fmtN(ov.metrics.salesCount)} receipts`;

  // metrics cards
  $("mRevenue").textContent = fmtMoney(ov.metrics.revenue, state.currency);
  $("mSalesCount").textContent = `${fmtN(ov.metrics.salesCount)} receipts • ${fmtN(ov.metrics.itemsSold)} items`;
  $("mPaid").textContent = fmtMoney(ov.metrics.paid, state.currency);
  $("mOutstanding").textContent = fmtMoney(ov.metrics.remaining, state.currency);
  $("mTotalOwed").textContent = fmtMoney(ov.metrics.totalOwed, state.currency);
  $("mDebtorsCount").textContent = `${fmtN(ov.metrics.debtorsCount)} customers owing`;
  $("mProducts").textContent = fmtN(ov.metrics.productsCount);
  $("mLowStock").textContent = `${fmtN(ov.metrics.lowStockCount)} low stock (<=3)`;
  $("mStaffs").textContent = fmtN(ov.metrics.staffCount);

  // trend chart + mini lists
  renderBars($("chartTrend"), ov.salesByDay || []);
  renderMiniList($("topProducts"), (ov.topProducts || []).map(x => ({ label: x.key, value: x.qty })), "label", "value", (v) => fmtN(v));
  renderMiniList($("payMethods"), (ov.paymentBreakdown || []).map(x => ({ label: x.method, value: x.count })), "label", "value", (v) => fmtN(v));
  kv($("shopProfileKv"), {
    "Shop Name": shop.shopName || "",
    "Address": shop.address || "",
    "Phone": shop.phone || "",
    "WhatsApp": shop.whatsapp || "",
    "Currency": state.currency,
  });

  // sales
  const from = ov.range?.since || (Date.now() - days * 24 * 60 * 60 * 1000);
  const to = ov.range?.now || Date.now();
  const sales = await api(`/api/dashboard/sales?shopId=${encodeURIComponent(state.shopId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=200`);
  fillTable("salesTable", sales.items || [], [
    { get: (r) => fmtDateTime(r.createdAt), right:false },
    { get: (r) => (r.receiptNo || ""), right:false },
    { get: (r) => (r.customerName || "") , right:false },
    { get: (r) => (r.staffUser || r.staffName || r.staffId || "") , right:false },
    { get: (r) => fmtMoney(r.total, state.currency), right:true },
    { get: (r) => fmtMoney(r.paid, state.currency), right:true },
    { get: (r) => fmtMoney(r.remaining, state.currency), right:true },
    { get: (r) => (r.paymentMethod || ""), right:false },
    { get: (r) => (r.status || ""), right:false },
  ]);

  // products
  const products = await api(`/api/dashboard/products?shopId=${encodeURIComponent(state.shopId)}`);
  fillTable("productsTable", products.items || [], [
    { get: (r) => (r.name || r.productName || ""), right:false },
    { get: (r) => (r.sku || ""), right:false },
    { get: (r) => (r.barcode || ""), right:false },
    { get: (r) => fmtMoney(r.price, state.currency), right:true },
    { get: (r) => fmtN(r.stock), right:true },
    { get: (r) => fmtDateTime(r.updatedAt || r.createdAt), right:false },
  ]);

  // debtors
  const debtors = await api(`/api/dashboard/debtors?shopId=${encodeURIComponent(state.shopId)}`);
  fillTable("debtorsTable", debtors.items || [], [
    { get: (r) => (r.customerName || ""), right:false },
    { get: (r) => (r.customerPhone || ""), right:false },
    { get: (r) => fmtMoney(r.totalOwed, state.currency), right:true },
    { get: (r) => (r.lastReceiptNo || ""), right:false },
    { get: (r) => fmtDateTime(r.updatedAt || r.createdAt), right:false },
  ]);

  // staff
  const staff = await api(`/api/dashboard/staff?shopId=${encodeURIComponent(state.shopId)}&days=${encodeURIComponent(days)}`);
  fillTable("staffTable", staff.items || [], [
    { get: (r) => r.staff, right:false },
    { get: (r) => fmtN(r.salesCount), right:true },
    { get: (r) => fmtMoney(r.revenue, state.currency), right:true },
    { get: (r) => fmtMoney(r.paid, state.currency), right:true },
    { get: (r) => fmtMoney(r.remaining, state.currency), right:true },
    { get: (r) => fmtN(r.itemsSold), right:true },
    { get: (r) => fmtMoney(r.avgSale, state.currency), right:true },
  ]);

  toast("Dashboard updated");
}

function bindUI(){
  document.querySelectorAll(".navBtn").forEach((b) => {
    b.addEventListener("click", () => setActiveTab(b.dataset.tab));
  });

  $("shopSelect").addEventListener("change", (e) => {
    state.shopId = e.target.value;
    refreshAll().catch(err => toast(err.message || String(err), true));
  });
  $("rangeSelect").addEventListener("change", (e) => {
    state.days = Number(e.target.value || 30);
    refreshAll().catch(err => toast(err.message || String(err), true));
  });
  $("btnRefresh").addEventListener("click", () => {
    refreshAll().catch(err => toast(err.message || String(err), true));
  });
}

(async function init(){
  try{
    bindUI();
    await loadShops();
    // load saved range
    const r = localStorage.getItem("spng_days");
    if (r){
      state.days = Number(r) || 30;
      $("rangeSelect").value = String(state.days);
    }
    await refreshAll();
  } catch (e){
    console.error(e);
    toast(e.message || String(e), true);
  }
})();

window.addEventListener("beforeunload", () => {
  localStorage.setItem("spng_days", String(state.days || 30));
});
