(() => {
  const $ = (id) => document.getElementById(id);
  const loginCard = $("loginCard");
  const meCard = $("meCard");
  const loginErr = $("loginErr");

  const LS_TOKEN = "spng_owner_token";

  const shopCard = $("shopCard");
  const shopTitle = $("shopTitle");
  const shopMeta = $("shopMeta");
  const kpiProducts = $("kpiProducts");
  const kpiSales = $("kpiSales");
  const kpiDebtors = $("kpiDebtors");
  const kpiRevenue = $("kpiRevenue");
  const shopMsg = $("shopMsg");
  const tProducts = $("tProducts");
  const tSales = $("tSales");
  const tDebtors = $("tDebtors");
  $1
  // Tab buttons + panels
  const tabProducts = document.querySelector('[data-tab="products"]');
  const tabSales = document.querySelector('[data-tab="sales"]');
  const tabDebtors = document.querySelector('[data-tab="debtors"]');

  const panelProducts = $("tab_products");
  const panelSales = $("tab_sales");
  const panelDebtors = $("tab_debtors");

  // Back button (in shop view)
  const btnBackToShops = $("btnBack");
function showErr(msg){
    loginErr.textContent = msg || "";
    loginErr.classList.toggle("hidden", !msg);
  }

  function showShopMsg(msg) {
    shopMsg.textContent = msg || "";
    shopMsg.classList.toggle("hidden", !msg);
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0.00";
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function api(path, opts={}){
    const token = localStorage.getItem(LS_TOKEN);
    const headers = { "Content-Type": "application/json", ...(opts.headers||{}) };
    // Auto-attach owner token for protected owner APIs when header not provided
    if(!headers["Authorization"] && token && (String(path).includes("/api/owner/"))) {
      headers["Authorization"] = "Bearer " + token;
    }
    const res = await fetch(path, { ...opts, headers });
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
    wrap.className = "shopsList";
    (data.owner.shops || []).forEach(s => {
      const div = document.createElement("div");
      div.className = "shop shopBtn";
      div.addEventListener('click', () => {
        const id = (s.shopId || "").toString();
        if (id) selectShop(s);
      });

      const lines = [];
      const addr = (s.address || "").trim();
      const phone = (s.phone || "").trim();
      const wa = (s.whatsapp || "").trim();
      const tagline = (s.tagline || "").trim();

      if (addr) lines.push(`Address: ${escapeHtml(addr)}`);
      if (phone) lines.push(`Phone: ${escapeHtml(phone)}`);
      if (wa) lines.push(`WhatsApp: ${escapeHtml(wa)}`);
      if (tagline) lines.push(escapeHtml(tagline));

      div.innerHTML = `
        <div style="font-weight:800">${escapeHtml(s.shopName || "Shop")}</div>
        <div class="muted">Shop ID: ${escapeHtml(s.shopId || "")} • Code: ${escapeHtml(s.shopCode || "")}</div>
        ${lines.length ? `<div class="muted" style="margin-top:6px; line-height:1.4">${lines.join("<br>")}</div>` : ""}
      `;
      wrap.appendChild(div);
    });

    loginCard.classList.add("hidden");
    meCard.classList.remove("hidden");
  }

  function money(n){
    const v = Number(n);
    if (!Number.isFinite(v)) return "0.00";
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setTab(tab){
    const btns = [tabProducts, tabSales, tabDebtors];
    btns.forEach(b => {
      if (!b) return;
      if (b.dataset.tab === tab) b.classList.add('active');
      else b.classList.remove('active');
    });

    if (panelProducts) panelProducts.classList.toggle('hidden', tab !== 'products');
    if (panelSales) panelSales.classList.toggle('hidden', tab !== 'sales');
    if (panelDebtors) panelDebtors.classList.toggle('hidden', tab !== 'debtors');
  }

  function renderTable(tbody, rows, cols){
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || !rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = cols;
      td.className = 'muted';
      td.textContent = 'No data';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(r => tbody.appendChild(r));
  }

  function makeTd(txt){
    const td = document.createElement('td');
    td.textContent = txt == null ? '' : String(txt);
    return td;
  }

  async function selectShop(shop){
    try {
      if (!shop) return;
      const token = localStorage.getItem(LS_TOKEN) || '';
      if (!token) return;

      // show selected card
      shopTitle.textContent = shop.shopName || 'Shop';
      shopMeta.textContent = `Shop ID: ${shop.shopId || ''}`;
      meCard.classList.add('hidden');
      shopCard.classList.remove('hidden');

      // overview
      const ov = await api(`/api/owner/shop/${encodeURIComponent(shop.shopId)}/overview`);
      if (ov && ov.ok && ov.overview) {
        kpiProducts.textContent = String(ov.overview.productsCount ?? 0);
        kpiSales.textContent = String(ov.overview.salesCount ?? 0);
        kpiDebtors.textContent = String(ov.overview.debtorsCount ?? 0);
        kpiRevenue.textContent = money(ov.overview.revenue ?? 0);
      }

      // products
      const pr = await api(`/api/owner/shop/${encodeURIComponent(shop.shopId)}/products`);
      const prows = (pr && pr.ok && pr.items ? pr.items : []).map(p => {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(p.name || ''));
        tr.appendChild(makeTd(p.barcode || p.sku || ''));
        tr.appendChild(makeTd(p.stock ?? 0));
        tr.appendChild(makeTd(money(p.price ?? 0)));
        return tr;
      });
      renderTable(productsTbody, prows, 4);

      // sales
      const sr = await api(`/api/owner/shop/${encodeURIComponent(shop.shopId)}/sales?limit=200`);
      const srows = (sr && sr.ok && sr.items ? sr.items : []).map(s => {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(s.receiptNo || ''));
        tr.appendChild(makeTd(s.staffUser || ''));
        tr.appendChild(makeTd(s.createdAt ? new Date(s.createdAt).toLocaleString() : ''));
        tr.appendChild(makeTd(money(s.total ?? 0)));
        return tr;
      });
      renderTable(salesTbody, srows, 4);

      // debtors
      const dr = await api(`/api/owner/shop/${encodeURIComponent(shop.shopId)}/debtors?limit=200`);
      const drows = (dr && dr.ok && dr.items ? dr.items : []).map(d => {
        const tr = document.createElement('tr');
        tr.appendChild(makeTd(d.customerName || ''));
        tr.appendChild(makeTd(d.receiptNo || ''));
        tr.appendChild(makeTd(d.customerPhone || ''));
        tr.appendChild(makeTd(money(d.remaining ?? d.amount ?? 0)));
        return tr;
      });
      renderTable(debtorsTbody, drows, 4);

      setTab('products');

    } catch (e) {
      console.error(e);
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
  $("btnLogout").addEventListener("click", logout);
  $("password").addEventListener("keydown", (e) => { if(e.key === "Enter") login(); });

  tabProducts?.addEventListener('click', () => setTab('products'));
  tabSales?.addEventListener('click', () => setTab('sales'));
  tabDebtors?.addEventListener('click', () => setTab('debtors'));
  btnBackToShops?.addEventListener('click', () => {
    shopCard.classList.add('hidden');
    meCard.classList.remove('hidden');
    selectedShop = null;
  });

  // auto
  loadMe().catch(()=>{});
})();