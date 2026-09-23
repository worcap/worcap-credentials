import "dotenv/config"; // Carrega as variáveis do arquivo .env

// Servidores na nuvem (Railway incluso) rodam em UTC. Sem isto, um check-in às 10h
// de Brasília seria gravado como 13h, período "Tarde", e as datas virariam às 21h.
process.env.TZ = process.env.TZ || "America/Sao_Paulo";
import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import QRCode from "qrcode";
import { fileURLToPath } from "url";
import { dirname, join, isAbsolute } from "path";
import fs from "fs";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

// Falha logo na inicialização, com mensagem clara, se faltar configuração
const obrigatorias = ["JWT_SECRET", "ADMIN_USER", "ADMIN_PASS", "OPERATOR_USER", "OPERATOR_PASS"];
const faltando = obrigatorias.filter((v) => !process.env[v]);
if (faltando.length) {
  console.error(`Variáveis de ambiente ausentes: ${faltando.join(", ")}`);
  process.exit(1);
}

// Usuários definidos via Variáveis de Ambiente (com fallbacks opcionais)
const USERS = [
  {
    username: process.env.ADMIN_USER,
    password: process.env.ADMIN_PASS,
    role: "ADMIN",
  },
  {
    username: process.env.OPERATOR_USER,
    password: process.env.OPERATOR_PASS,
    role: "USER",
  },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
// No Railway, o caminho do volume anexado vem em RAILWAY_VOLUME_MOUNT_PATH
const rawVolume = process.env.VOLUME || process.env.RAILWAY_VOLUME_MOUNT_PATH || "data";
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn("ATENÇÃO: nenhum volume anexado. Inscritos e presenças serão apagados a cada deploy ou reinício.");
}

// Se for absoluto (/data), usa direto; se for relativo, junta com __dirname
const DATA_DIR = isAbsolute(rawVolume) ? rawVolume : join(__dirname, rawVolume);
const PARTICIPANTS_FILE = join(DATA_DIR, "participants.json");
const ATTENDANCE_FILE = join(DATA_DIR, "attendance.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let participants = load(PARTICIPANTS_FILE, []);
let attendance = load(ATTENDANCE_FILE, []); // [{id, nome, instituicao, data, periodo, horario, timestamp}]

function genId() {
  return "P-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getPeriodoAtual(dataObj = new Date()) {
  return dataObj.getHours() < 13 ? "Manhã" : "Tarde";
}

// ---------- Leitura de planilhas com acentuação correta ----------
// Arquivos .xlsx (ZIP, começa com "PK") e .xls (OLE) são binários e já trazem o texto em Unicode.
function isBinarySheet(buf) {
  if (buf.length < 4) return false;
  const zip = buf[0] === 0x50 && buf[1] === 0x4b;
  const ole = buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0;
  return zip || ole;
}

// CSV é texto: tenta UTF-8 (padrão do Google Sheets e do "CSV UTF-8" do Excel)
// e, se os bytes não forem UTF-8 válido, cai para Windows-1252 (CSV comum do Excel).
function decodeText(buf) {
  let txt;
  try {
    txt = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    txt = new TextDecoder("windows-1252").decode(buf);
  }
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1); // remove BOM
  return txt.normalize("NFC");
}

function readSheetRows(buf) {
  const wb = isBinarySheet(buf)
    ? XLSX.read(buf, { type: "buffer" })
    : XLSX.read(decodeText(buf), { type: "string" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

// Compara cabeçalhos ignorando maiúsculas, espaços e acentos ("Instituição" = "instituicao")
const normKey = (k) =>
  String(k).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function findCol(obj, keys) {
  const wanted = keys.map(normKey);
  for (const k of Object.keys(obj)) {
    if (wanted.includes(normKey(k))) return obj[k];
  }
  return "";
}

// Repara texto UTF-8 que foi lido como Latin-1/Windows-1252 ("JoÃ£o" -> "João").
// Só altera o texto se o resultado for UTF-8 válido; nomes corretos passam intactos.
const CP1252_REV = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const MOJIBAKE_RE = /[\u00c2-\u00c5][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u2026\u2030\u2039\u203a\u20ac\u2122]/;

function fixMojibake(str) {
  let s = String(str ?? "");
  for (let pass = 0; pass < 2 && MOJIBAKE_RE.test(s); pass++) {
    const bytes = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c <= 0xff) bytes.push(c);
      else if (CP1252_REV[c] !== undefined) bytes.push(CP1252_REV[c]);
      else return s;
    }
    try {
      s = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return s;
    }
  }
  return s;
}

// Valores sempre em NFC, para que "João" digitado no Mac e no Windows seja o mesmo texto
const clean = (v) => fixMojibake(v).normalize("NFC").replace(/\s+/g, " ").trim();

// Nomes padronizados em caixa alta
const cleanName = (v) => clean(v).toLocaleUpperCase("pt-BR");

// Corrige registros já salvos (importados antes desta versão)
function repairStored() {
  let changed = 0;
  const fix = (obj) => {
    const nome = cleanName(obj.nome);
    const instituicao = clean(obj.instituicao);
    if (nome !== obj.nome || instituicao !== (obj.instituicao ?? "")) changed++;
    return { ...obj, nome, instituicao };
  };
  participants = participants.map(fix);
  attendance = attendance.map(fix);
  if (changed) {
    save(PARTICIPANTS_FILE, participants);
    save(ATTENDANCE_FILE, attendance);
    console.log(`Nomes padronizados/corrigidos em ${changed} registro(s) salvos.`);
  }
}
repairStored();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage() });

// ---------- Autenticação & Autorização ----------
function auth(requiredRole = null) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token ausente ou inválido." });
    }

    const token = header.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;

      if (requiredRole === "ADMIN" && decoded.role !== "ADMIN") {
        return res.status(403).json({ error: "Acesso negado: privilégios insuficientes." });
      }

      next();
    } catch {
      return res.status(401).json({ error: "Sessão expirada ou token inválido." });
    }
  };
}

// Rota de Login
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  const token = jwt.sign(
    { username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "4h" } // <-- Duração configurada aqui
  );

  res.json({ token, role: user.role, username: user.username });
});

// ---------- 1. Importações (ADMIN) ----------
function normalizeRows(rows) {
  return rows
    .map((r) => {
      const nome = cleanName(findCol(r, ["nome", "name", "participante", "nome completo"]));
      if (!nome) return null;
      return {
        id: genId(),
        nome,
        email: clean(findCol(r, ["email", "e-mail"])),
        instituicao: clean(findCol(r, ["instituicao", "institution", "org", "organizacao"])),
      };
    })
    .filter(Boolean);
}

app.post("/api/import", auth("ADMIN"), upload.single("file"), (req, res) => {
  try {
    let rows;
    if (req.file) {
      rows = readSheetRows(req.file.buffer);
    } else if (req.body && Array.isArray(req.body.rows)) {
      rows = req.body.rows;
    } else {
      return res.status(400).json({ error: "Envie um arquivo ou dados." });
    }

    const novos = normalizeRows(rows);
    if (novos.length === 0)
      return res.status(400).json({ error: "Nenhum participante válido. Verifique a coluna 'nome'." });

    const existentesEmail = new Set(participants.filter((p) => p.email).map((p) => p.email.toLowerCase()));
    const adicionados = novos.filter((p) => !p.email || !existentesEmail.has(p.email.toLowerCase()));
    participants = participants.concat(adicionados);
    save(PARTICIPANTS_FILE, participants);

    res.json({ total: participants.length, adicionados: adicionados.length });
  } catch (e) {
    res.status(500).json({ error: "Falha ao ler a planilha: " + e.message });
  }
});

app.post("/api/import-url", auth("ADMIN"), async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Informe a URL." });
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const rows = readSheetRows(buf);
    const novos = normalizeRows(rows);
    const existentesEmail = new Set(participants.filter((p) => p.email).map((p) => p.email.toLowerCase()));
    const adicionados = novos.filter((p) => !p.email || !existentesEmail.has(p.email.toLowerCase()));
    participants = participants.concat(adicionados);
    save(PARTICIPANTS_FILE, participants);
    res.json({ total: participants.length, adicionados: adicionados.length });
  } catch (e) {
    res.status(500).json({ error: "Falha ao importar da URL: " + e.message });
  }
});

// ---------- 1b. Atualizar cadastro de quem já existe (ADMIN) ----------
// Casa pelo nome (ignorando acentos, maiúsculas e espaços duplicados) e corrige
// e-mail e instituição. Não cria, não remove e não altera IDs nem QR Codes.
const chaveNome = (n) =>
  clean(n).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

app.post("/api/update-participants", auth("ADMIN"), upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Envie um arquivo de planilha." });

    const rows = readSheetRows(req.file.buffer);

    // Índice de nomes já cadastrados
    const porNome = new Map();
    for (const p of participants) {
      const k = chaveNome(p.nome);
      if (!porNome.has(k)) porNome.set(k, []);
      porNome.get(k).push(p);
    }

    const atualizados = [];
    const semCorrespondencia = [];
    const ambiguos = [];
    const semMudanca = [];

    for (const r of rows) {
      const nome = clean(findCol(r, ["nome", "name", "participante", "nome completo"]));
      if (!nome) continue;

      const achados = porNome.get(chaveNome(nome)) || [];
      if (achados.length === 0) {
        semCorrespondencia.push(nome);
        continue;
      }
      if (achados.length > 1) {
        ambiguos.push(nome);
        continue;
      }

      const p = achados[0];
      const email = clean(findCol(r, ["email", "e-mail"]));
      const instituicao = clean(findCol(r, ["instituicao", "institution", "org", "organizacao"]));

      const antes = { email: p.email || "", instituicao: p.instituicao || "" };
      if (email) p.email = email;
      if (instituicao) p.instituicao = instituicao;

      if (antes.email === (p.email || "") && antes.instituicao === (p.instituicao || "")) {
        semMudanca.push({ id: p.id, nome: p.nome });
        continue;
      }

      // Presenças guardam uma cópia da instituição
      for (const a of attendance) {
        if (a.id === p.id) a.instituicao = p.instituicao;
      }

      atualizados.push({ id: p.id, nome: p.nome, antes, depois: { email: p.email || "", instituicao: p.instituicao || "" } });
    }

    if (atualizados.length) {
      save(PARTICIPANTS_FILE, participants);
      save(ATTENDANCE_FILE, attendance);
    }

    res.json({
      totalLinhas: rows.length,
      atualizados,
      semMudanca,
      semCorrespondencia,
      ambiguos,
    });
  } catch (e) {
    res.status(500).json({ error: "Falha ao atualizar cadastros: " + e.message });
  }
});

// ---------- 2 & 3. Participantes & QR Codes (ADMIN) ----------
app.get("/api/participants", auth("ADMIN"), (req, res) => {
  res.json(participants);
});

app.get("/api/qrcode/:id", auth("ADMIN"), async (req, res) => {
  const p = participants.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Participante não encontrado." });
  const dataUrl = await QRCode.toDataURL(p.id, { width: 300, margin: 1 });
  res.json({ id: p.id, nome: p.nome, qr: dataUrl });
});

// ---------- 4. Credenciar (USER e ADMIN) com Período Salvo ----------
app.post("/api/checkin", auth(), (req, res) => {
  const { id, periodo: periodoForcado } = req.body;
  const p = participants.find((x) => x.id === id);
  if (!p) return res.status(404).json({ ok: false, error: "QR Code não reconhecido." });

  const now = new Date();
  const data = now.toLocaleDateString("pt-BR");
  const horario = now.toLocaleTimeString("pt-BR");
  const periodo = periodoForcado || getPeriodoAtual(now);

  // Impede dupla marcação no mesmo dia e MESMO período
  const jaRegistrado = attendance.find((a) => a.id === id && a.data === data && a.periodo === periodo);
  if (jaRegistrado) {
    return res.json({
      ok: true,
      duplicado: true,
      nome: p.nome,
      instituicao: p.instituicao,
      data,
      periodo,
      horario: jaRegistrado.horario,
      msg: `Presença já registrada na ${periodo} hoje`,
    });
  }

  const reg = {
    id,
    nome: p.nome,
    instituicao: p.instituicao,
    data,
    periodo,
    horario,
    timestamp: now.toISOString(),
  };
  attendance.push(reg);
  save(ATTENDANCE_FILE, attendance);

  res.json({
    ok: true,
    duplicado: false,
    nome: p.nome,
    instituicao: p.instituicao,
    data,
    periodo,
    horario,
    msg: `Credenciado (${periodo})`,
  });
});

// ---------- 5 & 7. Presenças e Estatísticas (USER e ADMIN) ----------
app.get("/api/attendance", auth(), (req, res) => {
  const { data, periodo } = req.query;
  let lista = attendance;
  if (data) lista = lista.filter((a) => a.data === data);
  if (periodo) lista = lista.filter((a) => a.periodo === periodo);
  res.json(lista.slice().reverse());
});

// Função auxiliar para obter a data atual no formato DD/MM/YYYY padronizado
function getHojeFormatado() {
  const agora = new Date();
  const dia = String(agora.getDate()).padStart(2, "0");
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const ano = agora.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

app.get("/api/stats", auth(), (req, res) => {
  const hoje = getHojeFormatado();
  const porDiaPeriodo = {};

  let presencasHojeManha = 0;
  let presencasHojeTarde = 0;

  attendance.forEach((a) => {
    // Garante que o período seja reconhecido mesmo se faltar o campo
    let per = a.periodo;
    if (!per && a.horario) {
      const hora = parseInt(a.horario.split(":")[0], 10);
      per = !isNaN(hora) && hora < 13 ? "Manhã" : "Tarde";
    }
    per = per || "Manhã";

    // Normaliza acentuação e espaços
    const perNorm = per.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const dataLimpa = String(a.data || "").trim();

    const chave = `${dataLimpa} (${per})`;
    porDiaPeriodo[chave] = (porDiaPeriodo[chave] || 0) + 1;

    // Compara apenas os dígitos da data (ex: "17/09/2026")
    if (dataLimpa === hoje) {
      if (perNorm.includes("manh")) {
        presencasHojeManha++;
      } else if (perNorm.includes("tard")) {
        presencasHojeTarde++;
      }
    }
  });

  res.json({
    totalParticipantes: participants.length,
    presencasHojeManha,
    presencasHojeTarde,
    presencasHojeTotal: presencasHojeManha + presencasHojeTarde,
    porDiaPeriodo,
  });
});

// ---------- 6. Exportar XLSX com Período (ADMIN) ----------
app.get("/api/export", auth("ADMIN"), (req, res) => {
  const ws = XLSX.utils.json_to_sheet(
    attendance.map((a) => ({
      ID: a.id,
      Nome: a.nome,
      Instituicao: a.instituicao,
      Data: a.data,
      Periodo: a.periodo || "—",
      Horario: a.horario,
    }))
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Presencas");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", "attachment; filename=presencas.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ---------- 8. Validação e Persistência de Planilha (ADMIN) ----------
function inferPeriodo(periodoStr, horarioStr) {
  if (periodoStr) {
    const norm = periodoStr.toLowerCase();
    if (norm.includes("manh") || norm.includes("morning") || norm.includes("mat")) return "Manhã";
    if (norm.includes("tard") || norm.includes("afternoon") || norm.includes("vesp")) return "Tarde";
  }
  if (horarioStr) {
    const hora = parseInt(horarioStr.split(":")[0], 10);
    if (!isNaN(hora)) return hora < 13 ? "Manhã" : "Tarde";
  }
  return "Manhã";
}

function normalizeAttendanceRows(rows) {
  return rows
    .map((r) => {
      const nome = cleanName(findCol(r, ["nome", "name", "participante", "nome completo"]));
      const data = clean(findCol(r, ["data", "date", "dia"]));
      if (!nome || !data) return null;

      const horario = clean(findCol(r, ["horario", "hora", "time"]));
      const periodoRaw = clean(findCol(r, ["periodo", "turno", "shift"]));

      return {
        id: clean(findCol(r, ["id", "codigo"])),
        nome,
        instituicao: clean(findCol(r, ["instituicao", "institution", "org", "organizacao"])),
        data,
        periodo: inferPeriodo(periodoRaw, horario),
        horario: horario || "—",
      };
    })
    .filter(Boolean);
}

// Função auxiliar reutilizável para compilar o relatório
function buildAttendanceReport(registros, inseridos = 0) {
  const chaveInscrito = (r) => r.id || `nome:${r.nome.toLowerCase()}|${r.instituicao.toLowerCase()}`;
  const porInscritoMap = new Map();
  const porPeriodoMap = new Map();

  for (const r of registros) {
    const chave = chaveInscrito(r);
    const chavePeriodo = `${r.data} (${r.periodo})`;

    if (!porInscritoMap.has(chave)) {
      porInscritoMap.set(chave, {
        id: r.id || null,
        nome: r.nome,
        instituicao: r.instituicao,
        periodos: new Set(),
      });
    }
    porInscritoMap.get(chave).periodos.add(chavePeriodo);
    porPeriodoMap.set(chavePeriodo, (porPeriodoMap.get(chavePeriodo) || 0) + 1);
  }

  const porInscrito = Array.from(porInscritoMap.values())
    .map((p) => ({
      id: p.id,
      nome: p.nome,
      instituicao: p.instituicao,
      periodos: Array.from(p.periodos).sort(),
      totalPeriodos: p.periodos.size,
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const porPeriodo = Array.from(porPeriodoMap.entries())
    .map(([periodo, total]) => ({ periodo, total }))
    .sort((a, b) => a.periodo.localeCompare(b.periodo));

  const idsComPresenca = new Set(porInscrito.filter((p) => p.id).map((p) => p.id));
  const ausentes = participants
    .filter((p) => !idsComPresenca.has(p.id))
    .map((p) => ({ id: p.id, nome: p.nome, instituicao: p.instituicao }));

  const idsConhecidos = new Set(participants.map((p) => p.id));
  const naoReconhecidos = porInscrito.filter((p) => p.id && !idsConhecidos.has(p.id));

  return {
    resumo: {
      totalRegistros: registros.length,
      totalInscritosPresentes: porInscrito.length,
      totalPeriodosUnicos: porPeriodo.length,
      totalAusentes: ausentes.length,
      novosSalvos: inseridos,
    },
    porInscrito,
    porPeriodo,
    ausentes,
    naoReconhecidos,
  };
}

// NOVO: Endpoint GET que usa o estado atual do sistema
app.get("/api/validate-attendance", auth("ADMIN"), (req, res) => {
  try {
    const report = buildAttendanceReport(attendance, 0);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: "Falha ao gerar relatório: " + e.message });
  }
});

// Endpoint POST mantido para upload de novas planilhas
app.post("/api/validate-attendance", auth("ADMIN"), upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Envie um arquivo de planilha." });

    const rows = readSheetRows(req.file.buffer);
    const registros = normalizeAttendanceRows(rows);

    if (registros.length === 0) {
      return res.status(400).json({ error: "Nenhum registro válido. Verifique as colunas 'nome' e 'data'." });
    }

    let inseridos = 0;
    for (const r of registros) {
      const chaveId = r.id || r.nome.toLowerCase();
      const jaExiste = attendance.some((a) => {
        const aChave = a.id || a.nome.toLowerCase();
        return aChave === chaveId && a.data === r.data && a.periodo === r.periodo;
      });

      if (!jaExiste) {
        attendance.push({
          id: r.id || genId(),
          nome: r.nome,
          instituicao: r.instituicao,
          data: r.data,
          periodo: r.periodo,
          horario: r.horario,
          timestamp: new Date().toISOString(),
        });
        inseridos++;
      }
    }

    if (inseridos > 0) {
      save(ATTENDANCE_FILE, attendance);
    }

    const report = buildAttendanceReport(registros, inseridos);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: "Falha ao validar a planilha: " + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor na porta ${PORT} · dados em ${DATA_DIR} · fuso ${process.env.TZ}`);
});
