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

  // auto
  loadMe().catch(()=>{});
})();
