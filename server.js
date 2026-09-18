import "dotenv/config"; // Carrega as variáveis do arquivo .env
import express from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import QRCode from "qrcode";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { isAbsolute, join, dirname } from "path";

const JWT_SECRET = process.env.JWT_SECRET;

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
const rawVolume = process.env.VOLUME || "data";

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
  const find = (obj, keys) => {
    for (const k of Object.keys(obj)) {
      const norm = k.toString().trim().toLowerCase();
      if (keys.includes(norm)) return obj[k];
    }
    return "";
  };
  return rows
    .map((r) => {
      const nome = find(r, ["nome", "name", "participante", "nome completo"]);
      if (!nome) return null;
      return {
        id: genId(),
        nome: String(nome).trim(),
        email: String(find(r, ["email", "e-mail"]) || "").trim(),
        instituicao: String(
          find(r, ["instituicao", "instituição", "institution", "org", "organização"]) || ""
        ).trim(),
      };
    })
    .filter(Boolean);
}

app.post("/api/import", auth("ADMIN"), upload.single("file"), (req, res) => {
  try {
    let rows;
    if (req.file) {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
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
    const text = await r.text();
    const wb = XLSX.read(text, { type: "string" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
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
  const find = (obj, keys) => {
    for (const k of Object.keys(obj)) {
      const norm = k.toString().trim().toLowerCase();
      if (keys.includes(norm)) return obj[k];
    }
    return "";
  };
  return rows
    .map((r) => {
      const nome = find(r, ["nome", "name", "participante", "nome completo"]);
      const data = find(r, ["data", "date", "dia"]);
      if (!nome || !data) return null;

      const horario = String(find(r, ["horario", "horário", "hora", "time"]) || "").trim();
      const periodoRaw = String(find(r, ["periodo", "período", "turno", "shift"]) || "").trim();

      return {
        id: String(find(r, ["id", "codigo", "código"]) || "").trim(),
        nome: String(nome).trim(),
        instituicao: String(
          find(r, ["instituicao", "instituição", "institution", "org", "organização"]) || ""
        ).trim(),
        data: String(data).trim(),
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

    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
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
app.listen(PORT, () => console.log(`Servidor em http://localhost:${PORT}`));
