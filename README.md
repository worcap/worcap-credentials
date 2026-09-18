# Credenciamento de Conferência — Web App (gera os tokens)

App web responsivo que roda **localmente na máquina do organizador**. É aqui que os inscritos são importados e os crachás/QR Codes ("tokens") são gerados e impressos. Sem banco de dados — usa arquivos JSON em `data/`.

> A validação dos tokens (leitura do QR) e a marcação de presença do dia acontecem no app mobile, em `../mobile-app`. Este web app também pode credenciar/ver presenças (funções originais mantidas), mas seu papel principal é gerar os tokens e, ao final, **conferir as presenças** trazidas de volta em planilha.

## Rodar

```bash
npm install
npm start
```

Abra `http://localhost:3000`. Para usar o scanner no celular, a página precisa de **HTTPS** ou `localhost` (exigência da câmera nos navegadores). Em rede local, use um túnel (ex.: `ngrok http 3000`) ou rode atrás de HTTPS.

## Fluxo

1. **Inscritos** — importe um `.xlsx`/`.csv` (coluna obrigatória: `nome`; opcionais: `email`, `instituicao`) ou cole a URL de uma planilha do Google publicada como CSV (Arquivo → Compartilhar → Publicar na web → CSV). Cada participante recebe um ID único.
2. **Crachás** — gere e imprima os crachás com QR Code (botão Imprimir abre o diálogo do navegador; o CSS já isola só os crachás na impressão).
3. **Credenciar** — no celular, abra a câmera e leia o QR. A presença é registrada com data e hora. Uma presença por participante por dia; leituras repetidas no mesmo dia são sinalizadas, não duplicadas.
4. **Presenças** — veja os registros, contadores do dia e exporte tudo em `.xlsx`.
5. **Conferir** — envie uma planilha de presenças (por exemplo, a exportada pelo app mobile) e veja o total de dias presentes por inscrito, o total de presentes por dia, quem ainda não compareceu nenhuma vez e registros com ID não cadastrado no sistema.

## Dados

- `data/participants.json` — inscritos e seus IDs.
- `data/attendance.json` — registros de presença (id, nome, data, horário).

Para reiniciar o evento, esvazie esses arquivos com `[]`.

## Endpoints

| Método | Rota | Função |
|---|---|---|
| POST | `/api/import` | importar arquivo |
| POST | `/api/import-url` | importar de URL CSV |
| GET | `/api/participants` | listar inscritos |
| GET | `/api/qrcode/:id` | QR Code (PNG dataURL) |
| POST | `/api/checkin` | registrar presença |
| GET | `/api/attendance?data=` | presenças (filtro opcional) |
| GET | `/api/stats` | contadores |
| GET | `/api/export` | baixar planilha |
| POST | `/api/validate-attendance` | conferir planilha de presenças (contagem por inscrito e por dia) |
