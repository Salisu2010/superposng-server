(() => {
  const $ = (id) => document.getElementById(id);
  const loginCard = $("loginCard");
  const meCard = $("meCard");
  const loginErr = $("loginErr");

  const LS_TOKEN = "spng_owner_token";

  function showErr(msg){
    loginErr.textContent = msg || "";
    loginErr.classList.toggle("hidden", !msg);
  }

  async function api(path, opts={}){
    const res = await fetch(path, { headers: { "Content-Type":"application/json", ...(opts.headers||{}) }, ...opts });
    const data = await res.json().catch(()=> ({}));
    if(!res.ok || data.ok === false) throw new Error(data.error || data.message || ("HTTP "+res.status));
    return data;
  }

  async function login(){
    showErr("");
    $("btnLogin").disabled = true;
    try{
      const email = $("email").value.trim();
      const password = $("password").value.trim();
      const data = await api("/api/owner/auth/login", { method:"POST", body: JSON.stringify({ email, password })});
      localStorage.setItem(LS_TOKEN, data.token);
      await loadMe();
    }catch(e){
      showErr(e.message || String(e));
    }finally{
      $("btnLogin").disabled = false;
    }
  }

  async function loadMe(){
    const token = localStorage.getItem(LS_TOKEN);
    if(!token) return;

    const data = await api("/api/owner/me", { headers: { "Authorization": "Bearer "+token }});
    $("meEmail").textContent = data.owner.email;

    const wrap = $("shops");
    wrap.innerHTML = "";
    (data.owner.shops || []).forEach(s => {
      const div = document.createElement("div");
      div.className = "shop";
      div.innerHTML = `<div style="font-weight:800">${escapeHtml(s.shopName || "Shop")}</div>
        <div class="muted">Shop ID: ${escapeHtml(s.shopId || "")} • Code: ${escapeHtml(s.shopCode || "")}</div>`;
      div.innerHTML += `<div class="row" style="margin-top:10px"><button class="btn" data-shop="${escapeHtml(s.shopId || "")}" data-name="${escapeHtml(s.shopName || "Shop")}">Open Dashboard</button></div>`;
      wrap.appendChild(div);
    });

    wrap.querySelectorAll("button[data-shop]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        selectedShopId = btn.getAttribute("data-shop")||"";
        selectedShopName = btn.getAttribute("data-name")||"";
        try{ await loadDashboard(); }catch(e){ console.error(e); }
      });
    });

    loginCard.classList.add("hidden");
    meCard.classList.remove("hidden");
  }

  

let selectedShopId = "";
let selectedShopName = "";
let debounceT = null;

function fmtN(n){
  try{
    const x = Number(n||0);
    return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }catch(_){ return String(n||0); }
}
function fmtMoney(n){
  return "NGN " + fmtN(n);
}
function fmtTime(ms){
  const d = new Date(Number(ms||0));
  if(isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

function renderKpis(k){
  const wrap = $("kpis");
  if(!wrap) return;
  wrap.innerHTML = "";
  const items = [
    ["Revenue", fmtMoney(k.revenue)],
    ["Paid", fmtMoney(k.paid)],
    ["Balance", fmtMoney(k.balance)],
    ["Sales", fmtN(k.salesCount)],
    ["Items", fmtN(k.itemsSold)],
    ["Low Stock", fmtN(k.lowStock)],
  ];
  items.forEach(([t,v])=>{
    const div = document.createElement("div");
    div.className = "kpi";
    div.innerHTML = `<div class="muted">${escapeHtml(t)}</div><div class="v">${escapeHtml(v)}</div>`;
    div.innerHTML += `<div class="row" style="margin-top:10px"><button class="btn" data-shop="${escapeHtml(s.shopId || "")}" data-name="${escapeHtml(s.shopName || "Shop")}">Open Dashboard</button></div>`;
      wrap.appendChild(div);
  });
}

async function apiOwner(path, opts={}){
  const token = localStorage.getItem(LS_TOKEN) || "";
  return api(path, { ...opts, headers: { ...(opts.headers||{}), "Authorization":"Bearer "+token } });
}

async function loadDashboard(){
  if(!selectedShopId) return;
  $("shopDash").classList.remove("hidden");
  $("dashTitle").textContent = selectedShopName || "Shop Dashboard";
  $("dashSub").textContent = "Shop ID: " + selectedShopId;

  const days = Number($("dashDays").value || 30);

  // Overview
  const ov = await apiOwner(`/api/owner/dashboard/overview?shopId=${encodeURIComponent(selectedShopId)}&days=${days}`);
  renderKpis(ov.kpi || {});

  // Recent sales
  const sales = await apiOwner(`/api/owner/dashboard/sales?shopId=${encodeURIComponent(selectedShopId)}&days=${Math.min(days,30)}&limit=40`);
  const sWrap = $("salesList");
  sWrap.innerHTML = "";
  (sales.items||[]).forEach(s=>{
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<div class="t">${escapeHtml(s.receiptNo || "Receipt")}</div>
      <div class="m">${escapeHtml(fmtTime(s.createdAt))} • ${escapeHtml((s.paymentMethod||"").toUpperCase())} • Total: ${escapeHtml(fmtMoney(s.total))} • Paid: ${escapeHtml(fmtMoney(s.paid))} • Bal: ${escapeHtml(fmtMoney(s.remaining))}</div>`;
    sWrap.appendChild(div);
  });
  if((sales.items||[]).length===0){
    sWrap.innerHTML = `<div class="muted">No sales yet. (Cloud sync may not have pushed data.)</div>`;
  }

  // Default products list
  await loadProducts();
}

async function loadProducts(){
  if(!selectedShopId) return;
  const q = ($("prodQ").value||"").trim();
  const data = await apiOwner(`/api/owner/dashboard/products?shopId=${encodeURIComponent(selectedShopId)}&q=${encodeURIComponent(q)}&limit=120`);
  const wrap = $("prodList");
  wrap.innerHTML = "";
  (data.items||[]).forEach(p=>{
    const div = document.createElement("div");
    div.className = "item";
    const exp = p.expiryDate ? ` • Exp: ${escapeHtml(p.expiryDate)}` : "";
    const low = p.lowStockLevel>0 ? ` • Low: ${escapeHtml(String(p.lowStockLevel))}` : "";
    div.innerHTML = `<div class="t">${escapeHtml(p.name || "Product")}</div>
      <div class="m">Price: ${escapeHtml(fmtMoney(p.price))} • Stock: ${escapeHtml(fmtN(p.stock))}${exp}${low}</div>
      <div class="m">Barcode: ${escapeHtml(p.barcode||"-")} • SKU: ${escapeHtml(p.sku||"-")} • PLU: ${escapeHtml(p.plu||"-")}</div>`;
    div.innerHTML += `<div class="row" style="margin-top:10px"><button class="btn" data-shop="${escapeHtml(s.shopId || "")}" data-name="${escapeHtml(s.shopName || "Shop")}">Open Dashboard</button></div>`;
      wrap.appendChild(div);
  });
  if((data.items||[]).length===0){
    wrap.innerHTML = `<div class="muted">No products found.</div>`;
  }
}

function logout(){
    localStorage.removeItem(LS_TOKEN);
    meCard.classList.add("hidden");
    loginCard.classList.remove("hidden");
  }

  function escapeHtml(str){
    return String(str||"").replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  }

  $("btnLogin").addEventListener("click", login);

  // Dashboard controls
  $("btnRefreshDash")?.addEventListener("click", ()=> loadDashboard().catch(console.error));
  $("btnProd")?.addEventListener("click", ()=> loadProducts().catch(console.error));
  $("prodQ")?.addEventListener("input", ()=>{
    clearTimeout(debounceT);
    debounceT = setTimeout(()=> loadProducts().catch(console.error), 180);
  });
  $("prodQ")?.addEventListener("keydown", (e)=>{
    if(e.key === "Enter"){
      e.preventDefault();
      loadProducts().catch(console.error);
    }
  });
  $("btnLogout").addEventListener("click", logout);
  $("password").addEventListener("keydown", (e) => { if(e.key === "Enter") login(); });

  // auto
  loadMe().catch(()=>{});
})();
