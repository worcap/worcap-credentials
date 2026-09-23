// ==========================================
// ESTADO E GERENCIAMENTO DE AUTENTICAÇÃO
// ==========================================

let authToken = localStorage.getItem("jwt_token") || null;
let currentRole = localStorage.getItem("jwt_role") || null;

const $ = (s) => document.querySelector(s);

// Escapa texto vindo da planilha antes de inserir no HTML
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Ícones SVG de traço (substituem os emojis)
const svg = (paths) => `<svg class="i" viewBox="0 0 24 24">${paths}</svg>`;
const ICON = {
  check: svg('<circle cx="12" cy="12" r="10"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  alert: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  userX: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5"/><path d="m22 8-5 5"/>'),
};

// Ajusta o tamanho do nome para caber em até 4 linhas, sem cortar palavras
function fitName(el, maxLines = 4) {
  for (let pt = 15; pt >= 8.5; pt -= 0.5) {
    el.style.fontSize = pt + "pt";
    const lineHeightPx = pt * 1.1 * (96 / 72);
    const cabeAltura = el.scrollHeight <= lineHeightPx * maxLines + 1;
    const cabeLargura = el.scrollWidth <= el.clientWidth + 1;
    if (cabeAltura && cabeLargura) return;
  }
}

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

const fileDropUpdate = $("#fileDropUpdate");
const fileInputUpdate = $("#fileInputUpdate");

if (fileDropUpdate && fileInputUpdate) {
  fileDropUpdate.onclick = () => fileInputUpdate.click();
  fileInputUpdate.onchange = (e) => {
    const f = e.target.files[0];
    $("#fileNameUpdate").textContent = f ? f.name : "";
  };
}

const btnUpdateParticipants = $("#btnUpdateParticipants");
if (btnUpdateParticipants) {
  btnUpdateParticipants.onclick = async () => {
    const f = $("#fileInputUpdate").files[0];
    if (!f) return toast("Escolha a planilha de correções primeiro.");
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/api/update-participants", { method: "POST", body: fd });
      renderUpdateResults(r);
      toast(`${r.atualizados.length} cadastro(s) atualizados.`);
    } catch (e) {
      toast(e.message);
    }
  };
}

function renderUpdateResults(r) {
  const box = $("#updateResults");
  const lista = (titulo, itens, classe = "") =>
    itens.length
      ? `<div class="warn-box ${classe}"><h3>${titulo} (${itens.length})</h3><ul>${itens
          .map((i) => `<li>${esc(i)}</li>`)
          .join("")}</ul></div>`
      : "";

  const alterados = r.atualizados.length
    ? `<div class="vtable-wrap"><table class="vtable">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Instituição</th></tr></thead>
        <tbody>${r.atualizados
          .map(
            (a) => `<tr>
              <td>${esc(a.nome)}</td>
              <td>${esc(a.depois.email || "—")}</td>
              <td class="datas">${esc(a.depois.instituicao || "—")}</td>
            </tr>`
          )
          .join("")}</tbody></table></div>`
    : "";

  // Todos os que a planilha localizou no sistema, tenham mudado ou não
  const idsDaPlanilha = [...r.atualizados.map((a) => a.id), ...r.semMudanca.map((m) => m.id)];

  const btnCrachas = idsDaPlanilha.length
    ? `<button class="btn-primary" style="margin-top:14px" id="btnBadgesUpdated">Gerar crachás destes ${idsDaPlanilha.length}</button>`
    : "";

  box.innerHTML = `
    <div class="section-title">${r.atualizados.length} de ${r.totalLinhas} linha(s) aplicadas</div>
    ${alterados}
    ${btnCrachas}
    ${lista(`${ICON.info} Já estavam corretos`, r.semMudanca.map((m) => m.nome))}
    ${lista(`${ICON.userX} Nome não encontrado no sistema`, r.semCorrespondencia, "danger")}
    ${lista(`${ICON.alert} Nome repetido no sistema, corrija à mão`, r.ambiguos, "danger")}`;

  const btn = $("#btnBadgesUpdated");
  if (btn) btn.onclick = () => gerarCrachasDaPlanilha(idsDaPlanilha);
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

// Monta os crachás de uma lista de participantes
async function gerarCrachas(ps) {
  if (!ps.length) return toast("Nenhum participante para gerar.");
  const area = $("#printArea");
  area.innerHTML = "";
  toast(`Gerando ${ps.length} crachá(s)...`);

  // A medição do nome depende da fonte final já carregada
  if (document.fonts && document.fonts.ready) await document.fonts.ready;

  for (const p of ps) {
    const q = await api("/api/qrcode/" + p.id);
    const div = document.createElement("div");
    div.className = "badge";
    div.innerHTML = `
      <div class="badge-info">
        <div class="bn">${esc(p.nome)}</div>
        ${p.instituicao ? `<div class="bi">${esc(p.instituicao)}</div>` : ""}
      </div>
      <div class="badge-qr">
        <img src="${q.qr}" alt="QR ${esc(p.id)}" />
        <div class="bid">${esc(p.id)}</div>
      </div>`;
    area.appendChild(div);
    fitName(div.querySelector(".bn"));
  }

  const folhas = Math.ceil(ps.length / 12);
  toast(`${ps.length} crachá(s) prontos · ${folhas} folha(s) A4.`);
  area.scrollIntoView({ behavior: "smooth", block: "start" });
}

const btnGenBadges = $("#btnGenBadges");
if (btnGenBadges) {
  btnGenBadges.onclick = async () => {
    try {
      const ps = await api("/api/participants");
      if (!ps.length) return toast("Importe participantes primeiro.");
      await gerarCrachas(ps);
    } catch (e) {
      toast(e.message);
    }
  };
}

// Gera apenas os crachás das pessoas que vieram na planilha de correção
async function gerarCrachasDaPlanilha(ids) {
  try {
    const todos = await api("/api/participants");
    const alvo = new Set(ids);
    await gerarCrachas(todos.filter((p) => alvo.has(p.id)));
  } catch (e) {
    toast(e.message);
  }
}

const btnPrint = $("#btnPrint");
if (btnPrint) {
  btnPrint.onclick = async () => {
    const area = $("#printArea");
    if (!area || !area.children.length) return toast("Gere os crachás antes de imprimir.");
    // Garante que a fonte já carregou antes de montar a página de impressão
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
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
      <div class="icon">${r.duplicado ? ICON.info : ICON.check}</div>
      <div class="name">${esc(r.nome)}</div>
      <div class="meta">${r.instituicao ? esc(r.instituicao) + " · " : ""}${esc(r.msg)} às ${esc(r.horario)}</div>`;
    stopScanner()
  } catch (e) {
    box.className = "scan-result show err";
    box.innerHTML = `
      <div class="icon">${ICON.alert}</div>
      <div class="name">Não reconhecido</div>
      <div class="meta">${esc(e.message)}</div>`;
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
            <div class="n">${esc(a.nome)}</div>
            <div class="s">${esc(a.instituicao || a.id)} · ${esc(a.data)} (${esc(a.periodo || "—")})</div>
          </div>
          <div class="time">${esc(a.horario)}</div>
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
        <td>${esc(p.nome)}</td>
        <td>${esc(p.instituicao || "—")}</td>
        <td>${p.totalPeriodos}</td>
        <td class="datas">${esc(p.periodos.join(", "))}</td>
      </tr>`
    )
    .join("");

  const porPeriodoRows = porPeriodo
    .map((d) => `<tr><td>${esc(d.periodo)}</td><td>${d.total}</td></tr>`)
    .join("");

  const ausentesHtml = ausentes.length
    ? `
    <div class="warn-box">
      <h3>${ICON.userX} Inscritos sem nenhuma presença (${ausentes.length})</h3>
      <ul>${ausentes.map((a) => `<li>${esc(a.nome)}${a.instituicao ? " · " + esc(a.instituicao) : ""}</li>`).join("")}</ul>
    </div>`
    : "";

  const naoReconhecidosHtml = naoReconhecidos.length
    ? `
    <div class="warn-box danger">
      <h3>${ICON.search} Registros com ID não cadastrado no sistema (${naoReconhecidos.length})</h3>
      <p class="hint" style="margin:0 0 8px">Podem ser inscritos importados só no celular, ou erro de digitação/QR.</p>
      <ul>${naoReconhecidos.map((n) => `<li>${esc(n.nome)} (${esc(n.id)})</li>`).join("")}</ul>
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
