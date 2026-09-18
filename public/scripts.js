// ==========================================
// ESTADO E GERENCIAMENTO DE AUTENTICAÇÃO
// ==========================================

let authToken = localStorage.getItem("jwt_token") || null;
let currentRole = localStorage.getItem("jwt_role") || null;

const $ = (s) => document.querySelector(s);

const toast = (msg) => {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
};

// Wrapper centralizado com cabeçalho JWT
async function api(url, opts = {}) {
  opts.headers = opts.headers || {};
  if (authToken) {
    if (opts.headers instanceof Headers) {
      opts.headers.set("Authorization", "Bearer " + authToken);
    } else {
      opts.headers["Authorization"] = "Bearer " + authToken;
    }
  }

  const r = await fetch(url, opts);
  if (r.status === 401) {
    logout();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Erro na requisição.");
  return j;
}

// Controle de interface por perfil (ADMIN vs USER)
function checkAuthUI() {
  const isLogged = !!authToken;
  const main = document.querySelector("main");
  const nav = document.querySelector("nav");
  const loginOverlay = $("#loginOverlay");
  const btnLogout = $("#btnLogout");
  const roleBadge = $("#userRoleBadge");

  if (main) main.style.display = isLogged ? "block" : "none";
  if (nav) nav.style.display = isLogged ? "flex" : "none";
  if (loginOverlay) loginOverlay.style.display = isLogged ? "none" : "block";
  if (btnLogout) btnLogout.style.display = isLogged ? "block" : "none";

  if (!isLogged) {
    if (roleBadge) roleBadge.textContent = "";
    stopScanner();
    return;
  }

  if (roleBadge) {
    roleBadge.textContent = `Perfil: ${currentRole === "ADMIN" ? "Administrador" : "Operador"}`;
  }

  const adminNavBtns = document.querySelectorAll('nav button[data-view="setup"], nav button[data-view="validate"]');
  const btnExport = $("#btnExport");

  if (currentRole) {
    document.getElementById('appHeader').style.display = 'flex';
  }

  if (currentRole === "USER") {
    adminNavBtns.forEach((b) => (b.style.display = "none"));
    if (btnExport) btnExport.style.display = "none";
    switchView("scan");
  } else {
    adminNavBtns.forEach((b) => (b.style.display = "flex"));
    if (btnExport) btnExport.style.display = "block";
    switchView("setup");
    refreshCount();
  }
}

// Login
const btnLogin = $("#btnLogin");
if (btnLogin) {
  btnLogin.onclick = async () => {
    const username = $("#txtUser").value.trim();
    const password = $("#txtPass").value.trim();
    if (!username || !password) return toast("Informe usuário e senha.");

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then((r) => r.json());

      if (res.error) throw new Error(res.error);

      authToken = res.token;
      currentRole = res.role;
      localStorage.setItem("jwt_token", authToken);
      localStorage.setItem("jwt_role", currentRole);

      $("#txtUser").value = "";
      $("#txtPass").value = "";

      checkAuthUI();
    } catch (e) {
      toast(e.message);
    }
  };
}

function logout() {
  authToken = null;
  currentRole = null;
  document.getElementById('appHeader').style.display = 'none';
  localStorage.removeItem("jwt_token");
  localStorage.removeItem("jwt_role");
  checkAuthUI();
}

const btnLogout = $("#btnLogout");
if (btnLogout) btnLogout.onclick = logout;

// ==========================================
// NAVEGAÇÃO ENTRE ABAS
// ==========================================
function switchView(viewName) {
  document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".view").forEach((x) => x.classList.remove("active"));
  const btns = ["setup", "scan", "list", "validate"];
  for (let b of btns) {
    let btn = document.getElementById(`${b}`);
    if (b === viewName) {
      btn.style.backgroundColor = "#8b8b8b";
      btn.style.color = "white";
    } else {
      btn.style.backgroundColor = "white";
      btn.style.color = "black";
    }
  }
  const targetBtn = document.querySelector(`nav button[data-view="${viewName}"]`);
  if (targetBtn) targetBtn.classList.add("active");

  const targetView = $("#view-" + viewName);
  if (targetView) targetView.classList.add("active");

  if (viewName === "list") loadAttendance();
  if (viewName === "validate") loadCurrentValidation();
  if (viewName !== "scan") stopScanner();
}

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => switchView(b.dataset.view);
});

// ==========================================
// IMPORTAÇÃO E CRACHÁS (ADMIN)
// ==========================================
const fileDrop = $("#fileDrop");
const fileInput = $("#fileInput");

if (fileDrop && fileInput) {
  fileDrop.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const f = e.target.files[0];
    $("#fileName").textContent = f ? f.name : "";
  };
}

const btnImportFile = $("#btnImportFile");
if (btnImportFile) {
  btnImportFile.onclick = async () => {
    const f = $("#fileInput").files[0];
    if (!f) return toast("Escolha um arquivo primeiro.");
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/api/import", { method: "POST", body: fd });
      toast(`${r.adicionados} adicionados · ${r.total} no total.`);
      refreshCount();
    } catch (e) {
      toast(e.message);
    }
  };
}

const btnImportUrl = $("#btnImportUrl");
if (btnImportUrl) {
  btnImportUrl.onclick = async () => {
    const url = $("#sheetUrl").value.trim();
    if (!url) return toast("Cole a URL da planilha publicada.");
    try {
      const r = await api("/api/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      toast(`${r.adicionados} adicionados · ${r.total} no total.`);
      refreshCount();
    } catch (e) {
      toast(e.message);
    }
  };
}

async function refreshCount() {
  if (currentRole !== "ADMIN") return;
  try {
    const p = await api("/api/participants");
    const countEl = $("#setupCount");
    if (countEl) {
      countEl.textContent = p.length
        ? `${p.length} participante(s) prontos para credenciamento.`
        : "Nenhum participante importado ainda.";
    }
  } catch {}
}

const btnGenBadges = $("#btnGenBadges");
if (btnGenBadges) {
  btnGenBadges.onclick = async () => {
    try {
      const ps = await api("/api/participants");
      if (!ps.length) return toast("Importe participantes primeiro.");
      const area = $("#printArea");
      area.innerHTML = "";
      toast("Gerando " + ps.length + " crachá(s)...");

      for (const p of ps) {
        const q = await api("/api/qrcode/" + p.id);
        const div = document.createElement("div");
        // div.className = "badge";
        // div.innerHTML = `
        //   <div class="top"><div class="ev">Conferência Acadêmica</div></div>
        //   <div class="body">
        //     <img src="${q.qr}" alt="QR ${p.id}" />
        //     <div class="bn">${p.nome}</div>
        //     ${p.instituicao ? `<div class="bi">${p.instituicao}</div>` : ""}
        //     <div class="bid">${p.id}</div>
        //   </div>`;
        // area.appendChild(div);
        div.className = "badge";
        div.innerHTML = `
          <div class="badge-content">
            <div class="badge-info">
              <div class="bn">${p.nome}</div>
              ${p.instituicao ? `<div class="bi">${p.instituicao}</div>` : ""}
              <div class="bid">${p.id}</div>
            </div>
            <div class="badge-qr">
              <img src="${q.qr}" alt="QR ${p.id}" />
            </div>
          </div>`;
        area.appendChild(div);
      }
    } catch (e) {
      toast(e.message);
    }
  };
}

const btnPrint = $("#btnPrint");
if (btnPrint) {
  btnPrint.onclick = () => {
    const area = $("#printArea");
    if (!area || !area.children.length) return toast("Gere os crachás antes de imprimir.");
    window.print();
  };
}

// ==========================================
// SCANNER / CREDENCIAMENTO COM PERÍODO
// ==========================================
let scanner = null;
let scanning = false;
let lastScan = 0;

const btnStartScan = $("#btnStartScan");
const btnStopScan = $("#btnStopScan");

if (btnStartScan) btnStartScan.onclick = startScanner;
if (btnStopScan) btnStopScan.onclick = stopScanner;

async function startScanner() {
  if (scanning) return;
  scanner = new Html5Qrcode("reader");
  try {
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      onScan,
      () => {}
    );
    scanning = true;
  } catch (e) {
    toast("Não foi possível abrir a câmera.");
  }
}

async function stopScanner() {
  if (scanner && scanning) {
    try {
      await scanner.stop();
      scanner.clear();
    } catch {}
    scanning = false;
  }
}

async function onScan(text) {
  const now = Date.now();
  if (now - lastScan < 2500) return;
  lastScan = now;
  if (navigator.vibrate) navigator.vibrate(60);

  const selectVal = $("#scanPeriodo") ? $("#scanPeriodo").value : "auto";
  const bodyData = { id: text.trim() };
  if (selectVal !== "auto") {
    bodyData.periodo = selectVal;
  }

  const box = $("#scanResult");
  try {
    const r = await api("/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyData),
    });

    box.className = "scan-result show " + (r.duplicado ? "dup" : "ok");
    box.innerHTML = `
      <div class="icon">${r.duplicado ? "ℹ️" : "✅"}</div>
      <div class="name">${r.nome}</div>
      <div class="meta">${r.instituicao ? r.instituicao + " · " : ""}${r.msg} às ${r.horario}</div>`;
  } catch (e) {
    box.className = "scan-result show err";
    box.innerHTML = `
      <div class="icon">⚠️</div>
      <div class="name">Não reconhecido</div>
      <div class="meta">${e.message}</div>`;
  }
  setTimeout(() => box.classList.remove("show"), 3500);
}

// ==========================================
// LISTAGEM DE PRESENÇAS (MANHÃ E TARDE)
// ==========================================
async function loadAttendance() {
  try {
    const [list, stats] = await Promise.all([api("/api/attendance"), api("/api/stats")]);

    // Data de hoje no formato DD/MM/YYYY do navegador
    const agora = new Date();
    const hojeStr = `${String(agora.getDate()).padStart(2, "0")}/${String(agora.getMonth() + 1).padStart(2, "0")}/${agora.getFullYear()}`;

    // Contabiliza com base na lista de presenças já salvas
    let manhaHoje = 0;
    let tardeHoje = 0;

    list.forEach((item) => {
      const dataItem = String(item.data || "").trim();
      const perItem = String(item.periodo || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

      if (dataItem === hojeStr) {
        if (perItem.includes("manh")) manhaHoje++;
        else if (perItem.includes("tard")) tardeHoje++;
      }
    });

    // Atualiza os cards
    if ($("#stTotal")) $("#stTotal").textContent = stats.totalParticipantes;
    if ($("#stHojeManha")) $("#stHojeManha").textContent = stats.presencasHojeManha || manhaHoje;
    if ($("#stHojeTarde")) $("#stHojeTarde").textContent = stats.presencasHojeTarde || tardeHoje;

    const ul = $("#attList");
    if (!list.length) {
      ul.innerHTML = '<li class="empty">Sem registros ainda.</li>';
      return;
    }

    ul.innerHTML = list
      .map(
        (a) => `
        <li>
          <div class="info">
            <div class="n">${a.nome}</div>
            <div class="s">${a.instituicao || a.id} · ${a.data} (${a.periodo || "—"})</div>
          </div>
          <div class="time">${a.horario}</div>
        </li>`
      )
      .join("");
  } catch (e) {
    toast(e.message);
  }
}

// Exportação autenticada via Blob
const btnExport = $("#btnExport");
if (btnExport) {
  btnExport.onclick = async () => {
    try {
      const res = await fetch("/api/export", {
        headers: { Authorization: "Bearer " + authToken },
      });
      if (!res.ok) throw new Error("Falha ao exportar planilha.");
      const blob = await res.blob();
      const u = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = u;
      a.download = "presencas.xlsx";
      a.click();
      window.URL.revokeObjectURL(u);
    } catch (e) {
      toast(e.message);
    }
  };
}

// ==========================================
// CONFERÊNCIA DE PLANILHA (ADMIN)
// ==========================================
const fileDropValidate = $("#fileDropValidate");
const fileInputValidate = $("#fileInputValidate");

if (fileDropValidate && fileInputValidate) {
  fileDropValidate.onclick = () => fileInputValidate.click();
  fileInputValidate.onchange = (e) => {
    const f = e.target.files[0];
    $("#fileNameValidate").textContent = f ? f.name : "";
  };
}

const btnValidate = $("#btnValidate");
if (btnValidate) {
  btnValidate.onclick = async () => {
    const f = $("#fileInputValidate").files[0];
    if (!f) return toast("Escolha a planilha de presenças primeiro.");
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/api/validate-attendance", { method: "POST", body: fd });
      renderValidateResults(r);
    } catch (e) {
      toast(e.message);
    }
  };
}

function renderValidateResults(r) {
  const box = $("#validateResults");
  const { resumo, porInscrito, porPeriodo, ausentes, naoReconhecidos } = r;

  const porInscritoRows = porInscrito
    .map(
      (p) => `
      <tr>
        <td>${p.nome}</td>
        <td>${p.instituicao || "—"}</td>
        <td>${p.totalPeriodos}</td>
        <td class="datas">${p.periodos.join(", ")}</td>
      </tr>`
    )
    .join("");

  const porPeriodoRows = porPeriodo
    .map((d) => `<tr><td>${d.periodo}</td><td>${d.total}</td></tr>`)
    .join("");

  const ausentesHtml = ausentes.length
    ? `
    <div class="warn-box">
      <h3>⚠️ Inscritos sem nenhuma presença (${ausentes.length})</h3>
      <ul>${ausentes.map((a) => `<li>${a.nome}${a.instituicao ? " · " + a.instituicao : ""}</li>`).join("")}</ul>
    </div>`
    : "";

  const naoReconhecidosHtml = naoReconhecidos.length
    ? `
    <div class="warn-box">
      <h3>🔎 Registros com ID não cadastrado no sistema (${naoReconhecidos.length})</h3>
      <p class="hint" style="margin:0 0 8px">Podem ser inscritos importados só no celular, ou erro de digitação/QR.</p>
      <ul>${naoReconhecidos.map((n) => `<li>${n.nome} (${n.id})</li>`).join("")}</ul>
    </div>`
    : "";

  box.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="num">${resumo.totalRegistros}</div><div class="lbl">Registros</div></div>
      <div class="stat"><div class="num">${resumo.totalInscritosPresentes}</div><div class="lbl">Inscritos presentes</div></div>
      <div class="stat"><div class="num">${resumo.totalPeriodosUnicos}</div><div class="lbl">Turnos distintos</div></div>
    </div>
    <div class="card">
      <h2>Presenças por inscrito</h2>
      <div class="vtable-wrap">
        <table class="vtable">
          <thead><tr><th>Nome</th><th>Instituição</th><th>Total de Turnos</th><th>Presenças Registradas</th></tr></thead>
          <tbody>${porInscritoRows}</tbody>
        </table>
      </div>
      <div class="section-title">Presenças por turno</div>
      <div class="vtable-wrap">
        <table class="vtable">
          <thead><tr><th>Data e Turno</th><th>Total de presentes</th></tr></thead>
          <tbody>${porPeriodoRows}</tbody>
        </table>
      </div>
      ${ausentesHtml}
      ${naoReconhecidosHtml}
    </div>`;
}

async function loadCurrentValidation() {
  try {
    const r = await api("/api/validate-attendance");
    renderValidateResults(r);
  } catch (e) {
    toast(e.message);
  }
}

const btnLoadCurrentStats = $("#btnLoadCurrentStats");
if (btnLoadCurrentStats) {
  btnLoadCurrentStats.onclick = loadCurrentValidation;
}

// Inicializa checagem de tela
checkAuthUI();
