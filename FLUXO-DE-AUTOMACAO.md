# O Fluxo de Automação: WhatsApp → OpenAI → Moskit CRM

Esse documento descreve o ciclo de vida completo de um atendimento: desde o webhook do WhatsApp até o agendamento da consulta no Google Calendar e na agenda do Moskit.

---

## Visão Geral (30.000 pés)

```
[Webhook Zernio] 
    ↓ (armazena mensagem)
[Buffer 5 min de inatividade]
    ↓ (cliente parou de digitar)
[Classificação OpenAI] 
    ↓ (lead viável?)
[Extração OpenAI]
    ↓ (origem, área, advogado, etc)
[Cadastro Moskit]
    ↓ (contato + deal criado/atualizado)
[Briefing pré-consulta]
    ↓ (nota com resumo no CRM)
[Dupla confirmação de horário]
    ↓ (cliente + equipe confirmam?)
[Agendamento nas duas plataformas]
    ↓ (Google Calendar + Moskit Atividade)
[Progredindo de funil]
    ↓
[Concluído]
```

---

## ① Webhook: Receber e Armazenar a Mensagem

**Entrada:** `POST /webhook` (Zernio com assinatura HMAC-SHA256)

**Função principal:** `tratarWebhook()` → `processarMensagemRecebida()` ([index.js:5041](index.js))

**O que acontece:**
- Valida assinatura HMAC do Zernio
- Filtra números internos (TEAM_PHONES) — não cria lead/deal
- Normaliza mensagem com `normalizarMensagem()`
- Armazena em SQLite: `conversations.messages[]` (JSON array)
- Chama `agendarProcessamento(chatId)` com delay de 5 min

**Saída:** Conversa agendada para processamento após inatividade

**Rede de segurança:** `GET /sincronizar` (a cada 3 min) faz polling no Zernio para recuperar mensagens que o webhook pode ter perdido

---

## ② Processamento via IA: Classificação + Extração

**Trigger:** Timer de 5 minutos após a última mensagem (TEMPO_INATIVIDADE_MS)

**Função principal:** `processarConversaDirect(chatId)` ([index.js:3883](index.js))

### 2.1 Classificação do Lead

**Função:** `classificarConversa(historico, contextoCrm)` ([index.js:3436](index.js))

- **Modelo:** OpenAI `gpt-4o-mini` (temperatura 0 — determinístico)
- **Input:** Histórico completo da conversa + contexto do CRM
- **Decisão:** Lead viável para criar negócio?
  - `classificacao: 'criar_negocio'` → continua pipeline
  - `classificacao: 'inviavel'` → retorna (sem deal)
- **Motivos de descarte:** Spam, número errado, conversa interna, cliente desiste antes da hora

### 2.2 Extração de Dados Estruturados

**Função:** `extrairDadosAtendimento(historico, temDeal, dadosAnteriores, infoCliente, dataAtual)` ([index.js:3450](index.js))

- **Modelo:** OpenAI `gpt-4o-mini`
- **Extrai:**
  - `origem` — como conheceu o escritório (site, indicação, Instagram, etc)
  - `tipo_consulta` — Consulta Jurídica? Contrato? Consultoria?
  - `area_direito` — Família, Trabalhista, Administrativo, Imobiliário, etc
  - `advogado_responsavel` — derivado automaticamente da área
  - `captacao` — quem é o responsável pela captação
  - `pagamento_confirmado` — 0/1
  - `data_hora_consulta` — horário proposto pelo cliente
  - `email` — contato para envio de documentos
  - `resumo_atendimento` — narrativa estruturada em 6 seções

- **Saída:** `{acao, dados, justificativa, confianca}`
  - `acao`: `'criar'` | `'atualizar'` | `'nota'` | `'ignorar'` | `'aguardar'`
  - `confianca`: 1-10 (conforme julgamento do modelo)
  - **Gate:** Se `confianca < 6/10` → força `acao := 'ignorar'` (proteção contra alucinação)

---

## ③ Decisão: Criar, Atualizar ou Aguardar?

**Função principal:** `finalizarCiclo()` ([index.js:3572](index.js))

### 3.1 Aplicar Gates

**`deveEsperarCasoDescrito()`** ([index.js:1305](index.js))
- Valida: área do direito e advogado não são vazios?
- Se não: força `acao := 'aguardar'` (espera cliente descrever o caso melhor)
- **Exceção:** Já existe dupla confirmação de horário ou bloco de condições → libera mesmo sem caso descrito

**`aplicarGateCasoDescrito()`** ([index.js:1347](index.js))
- Anula `area_direito`, `advogado_responsavel`, `assunto` se não houver observação validada de caso descrito
- Garante: nenhum palpite sobre a área sai para o CRM

### 3.2 Criar ou Atualizar Deal no Moskit

**Buscar contato:**
```javascript
buscarOuCriarContato(phone, name)  // [index.js:1441]
  → GET /contacts?filter[phones]={ultimos8digitos}
  → Se não existe: POST /contacts (novo contato)
  → Retorna: contactId
```

**Criar novo deal:**
```javascript
criarNegocioMoskit(dados, contactId)  // [index.js:1635]
  → POST /deals {
      name: "{cliente} - {assunto}",
      contacts: [{id: contactId}],
      entityCustomFields: {
        [CF_ORIGEM]: opcaoId,
        [CF_TIPO_CONSULTA]: opcaoId,
        [CF_AREA_DIREITO]: opcaoId,
        [CF_ADVOGADO_RESPONSAVEL]: opcaoId,
        ...
      }
    }
  → Retorna: dealId
```

**Atualizar deal existente:**
```javascript
atualizarNegocioMoskit(dealId, dados, contactId)  // [index.js:1673]
  → PUT /deals/{dealId} {
      name: "{cliente} - {assunto}",  // ou mantém antigo se renomeado na mão
      entityCustomFields: {...},
      status: "OPEN",  // nunca "WON" / "LOST" (só `fecharNegocioSeAplicavel`)
      activities: [...],  // preserva atividades (caso contrário Moskit recusa 422)
    }
```

**Grava no banco:**
```javascript
db.conversations.deal_id = dealId
db.conversations.last_action = acao
db.conversations.last_data = {...}  // JSON serializado
```

---

## ④ Dupla Confirmação de Horário

**Função principal:** `apurarDuplaConfirmacao()` ([index.js:2673](index.js))

**Lógica:**
1. Coleta observações validadas do tipo:
   - `cliente_propos_horario` — cliente sugeriu um horário
   - `equipe_propos_horario` — equipe sugeriu
   - `cliente_aceitou_horario` — cliente confirmou
   - `equipe_aceitou_horario` — equipe confirmou
   
2. Procura pelo par mais recente `(cliente_confirmado, equipe_confirmado)`

3. Ambos confirmaram o MESMO horário?
   - **Sim** → `agendamento_apuracao.status := 'confirmado'`
   - **Não** → `agendamento_apuracao.status := 'pendente'` com `motivo` (ex: `'falta_cliente'`, `'horarios_diferentes'`)

4. Valida horário com `motivoHorarioImplausivel()` ([src/evidencia.js](src/evidencia.js)):
   - Formato válido? (AAAA-MM-DDTHH:MM:00)
   - Não é cópia da data-âncora? (eco da última mensagem)
   - Dentro do horário de atendimento? (HORA_MIN_ATENDIMENTO–HORA_MAX_ATENDIMENTO)
   - Não é passado? (não anterior ao timestamp da mensagem)
   - Sem segundos/milissegundos/offset? (valores limpos)

5. Grava no banco:
```javascript
db.conversations.agendamento_apuracao = {
  status: 'confirmado' | 'pendente',
  horario_iso: "2026-09-02T15:30:00",  // naive (hora do escritório)
  cliente: {...observacoes validadas...},
  equipe: {...observacoes validadas...},
  motivo: string  // se pendente
}
```

---

## ⑤ Agendamento nas Duas Plataformas

**Função principal:** `handleAgendamentoCalendar()` ([index.js:2672](index.js))

**Pré-requisitos:**
- Dupla confirmação fechada (`agendamento_apuracao.status === 'confirmado'`)
- Horário válido (passou por todas as validações)
- Comprovante verificado (cliente pagou, ou existe dupla confirmação/bloco de condições)

### 5.1 Google Calendar

**Função:** `criarEventoGoogleCalendar(dados, chatId, dealId, numeroReuniao)` ([index.js:2600](index.js))

```javascript
// Autenticação: OAuth2 com conta REAL da equipe
const calendar = google.calendar({version: 'v3', auth: googleAuth});

// Cria evento com Meet link automático
await calendar.events.insert({
  calendarId: 'primary',
  resource: {
    summary: `Consulta — ${nomeCliente} (${nomeAdvogado}) · #${dealId}`,
    description: `Telefone: ${telefone}\n[deal:${dealId}]`,
    start: {
      dateTime: horarioEmInstante,  // UTC absoluto
      timeZone: 'America/Fortaleza'  // fuso do escritório
    },
    end: {
      dateTime: horarioEmInstante + 1h,
      timeZone: 'America/Fortaleza'
    },
    conferenceData: {
      generateConferenceRequest: {
        conferenceSolutionKey: {key: 'hangoutsMeet'}
      }
    },
    attendees: [
      {email: emailCliente},  // se informou
      {email: emailEquipe}    // sócio responsável
    ],
    reminders: {useDefault: true}
  }
});

// Retorna: {id, conferenceData.entryPoints[0].uri}  (link Meet)
// Grava no banco:
db.conversations.evento_calendar_id = eventId
db.conversations.evento_calendar_data = dataHora  // naive para auditoria
```

**Remarcação:** `atualizarEventoSeRemarcado()` ([index.js:2795](index.js))
- `PATCH /events/{id}` em vez de POST (preserva link Meet)
- Só muda `start`/`end`, mantém `conferenceData`

### 5.2 Moskit: Atividade (Compromisso)

**Função:** `registrarConsultaNaAgendaMoskit()` → `criarAtividadeMoskit()` ([index.js:2521](index.js))

```javascript
// Ativa apenas se AGENDA_MOSKIT_DRY_RUN !== true (padrão: funciona)

await axios.post('https://api.moskitcrm.com/v2/activities', {
  title: `Consulta — ${nomeCliente} · #${dealId}`,
  description: `Responsável: ${nomeAdvogado}`,
  dueDate: horarioEmInstanteUTC,  // full timestamp, não naive
  deals: [{id: dealId}],
  type: 'consultation'
}, {
  headers: {
    apikey: MOSKIT_API_KEY,
    'X-Ollow-Origin': 'BOT_WHATSAPP'
  }
});

// Retorna: {id: atividadeId}
// Grava no banco:
db.conversations.atividade_moskit_id = atividadeId
db.atividades_sincronizadas.insert({  // dedup: impede duplicação
  atividade_id: atividadeId,
  evento_google_id: eventId
})
```

**Fuso horário:** `horarioNaiveParaInstante()` ([src/atividade-moskit.js](src/atividade-moskit.js))
- Converte horário naive do escritório (ex: "2026-09-02T15:30:00") 
- Para instante UTC absoluto usando `Intl.DateTimeFormat` (offset dinâmico)
- Moskit espera formato ISO 8601 com Z ou offset

### 5.3 Notificações

```javascript
// Telegram para equipe
await enviarTelegram(`
  ✅ Consulta agendada: ${nomeCliente}
  📅 ${dataFormatada} às ${horaFormatada}
  🔗 Meet: ${linkMeet}
  📋 Deal #${dealId}
`);
```

---

## ⑥ Progressão de Funil e Fechamento

**Funções principais:**
- `moverEstagioSeAvancar()` ([index.js:2216](index.js))
- `fecharNegocioSeAplicavel()` ([index.js:2237](index.js))

### 6.1 Mover Estágio

```javascript
if (FUNIL_DRY_RUN === true) {
  // Padrão: DRY_RUN ligado (não move de verdade)
  db.conversations.last_action_log = 'Moveria para estágio X'
  // POST nota no deal com "[dry-run]"
  return
}

// Se FUNIL_DRY_RUN === false: move de verdade
PUT /deals/{dealId} {
  stage: {id: stageId}  // ex: 4 = "Consulta Agendada"
}
```

**Estágios conhecidos (src/moskit-ids.js):**
- Negócios em aberto
- Consulta Agendada (após pagamento confirmado)
- Proposta enviada (aguardando posicionamento)
- Negociação (cliente quer ajustar preço)
- Contrato assinado
- Fechado (Ganho / Perdido)

### 6.2 Fechar Negócio

**Critérios:** Deal ganha quando cliente assinou contrato ou confirmou caso resolvido
```javascript
PUT /deals/{dealId} {
  status: 'WON',  // ou 'LOST'
  closeDate: hoje
}
```

**Flag:** `FUNIL_FECHAMENTO_DRY_RUN` (padrão true)
- Ligado: não fecha (aviso no Telegram + nota com [dry-run])
- Desligado: fecha de verdade

---

## Retry e Tratamento de Falhas

### Fila de Reprocessamento

**Arquivo:** `src/fila.js`

**Fluxo quando uma etapa falha:**
```javascript
try {
  await processarConversaDirect(chatId)
} catch (erro) {
  // Enfileira para retry
  await fila.adicionarConversa(chatId)
  // MAX_TENTATIVAS = 3 (padrão)
  // Backoff exponencial: 1x, 2x, 4x o intervalo base
}
```

**Worker:** `worker.js` (processo filho de index.js)
- Lê fila a cada FILA_INTERVALO_MS (padrão 30 seg)
- Chama `processarConversaDirect(chatId)` novamente
- Após 3 falhas: desiste e avisa Telegram

### Gates que Impedem Avanço

| Gate | Bloqueio |
|------|----------|
| **Número interno** | Descarta sem criar deal |
| **Lead inviável** | Retorna (sem conversa falhada) |
| **Confiança < 6/10** | Força `acao := 'ignorar'` |
| **Sem caso descrito** | Força `acao := 'aguardar'` |
| **Dupla não fechou** | Marca como pendente (avisa Telegram) |
| **Horário implausível** | Rejeita observação (inclui motivo na nota) |
| **Comprovante inválido** | Aguarda pagamento confirmado |
| **Google OAuth offline** | Pula Google, cria só no Moskit |
| **Moskit 429/timeout** | Enfileira com backoff |

---

## Integrações Externas

### Zernio (WhatsApp)

- **Entrada:** `POST /webhook` com assinatura HMAC-SHA256
- **Saída:** Mensagens armazenadas em `conversations.messages` (JSON normalizado)
- **Fallback:** `GET /sincronizar` (poll a cada 3 min)
- **Validação:** `comparacaoSegura()` (comparação de tempo constante, evita timing attacks)

### OpenAI

- **Modelo:** `gpt-4o-mini` (determinístico, temperatura 0)
- **Chamadas:**
  1. Classificação do lead
  2. Extração de dados de atendimento
  3. Análise de observações (dupla confirmação)
  4. Leitura de comprovante por visão (base64)
- **Wrapper:** `openaiChat(messages, responseFormat)` ([index.js:339](index.js))
  - HTTP direto (sem SDK) para evitar hangs
  - Timeout: TIMEOUT_HTTP_MS (padrão 30s)

### Moskit CRM

- **Base URL:** `https://api.moskitcrm.com/v2` (customizável em MOSKIT_BASE)
- **Operações:**
  - `GET /contacts?filter[phones]=...` → lista com paginação por `x-moskit-listing-next-page-token`
  - `POST /contacts` → novo contato
  - `GET /deals?filter[contact_id]=...` → deals do contato (paginado por `?start=`)
  - `POST /deals` → criar deal
  - `PUT /deals/{id}` → atualizar (requer corpo do GET anterior)
  - `POST /deals/{id}/notes` → nota (briefing)
  - `POST /activities` → atividade (consulta agendada)
  - `PUT /activities/{id}` → atualizar atividade (ex: remarcação)
- **Rate limit:** 6 req/s, 240 req/min (headers `x-ratelimit-*`)
- **Campos customizados:** Mapeados em `src/moskit-ids.js` (fonte única)

### Google Calendar

- **Autenticação:** OAuth2 (conta real da equipe, não service account)
- **Razão:** Gera link Google Meet + convida por email (service account não suporta)
- **Operações:**
  - `calendar.events.insert()` → criar evento com Meet
  - `calendar.events.patch()` → atualizar horário (remarcação)
- **Config files:** `google-oauth-client.json` + `google-oauth-token.json`
- **Refresh:** `node autorizar-google.js` (interativo, roda uma vez)

### Telegram

- **Função:** `enviarTelegram(texto)` ([index.js:7744](index.js))
- **Notificações:**
  - Comprovante confere/não confere
  - Consulta agendada (com link Meet)
  - Remarcação
  - Falhas de API (Moskit, Google, etc)
  - Negócio ganho/perdido
  - Avisos de reconciliação

---

## Checkpoints no Banco de Dados (SQLite)

Tabela: `conversations` (uma linha por chat/telefone)

| Campo | Tipo | Significado |
|-------|------|------------|
| `chat_id` | TEXT | Telefone (PK) |
| `deal_id` | INTEGER | ID do deal no Moskit (NULL = não criado ainda) |
| `messages` | JSON | Array de mensagens |
| `last_action` | TEXT | `'criar'` \| `'atualizar'` \| `'nota'` \| `'ignorar'` \| `'aguardar'` |
| `last_data` | JSON | Extração mais recente da IA + merge com dados anteriores |
| `evento_calendar_id` | TEXT | ID do evento no Google Calendar |
| `evento_calendar_data` | TEXT | Data/hora do evento (naive, para auditoria) |
| `atividade_moskit_id` | INTEGER | ID da atividade (compromisso) no Moskit |
| `agendamento_apuracao` | JSON | Resultado da dupla confirmação (horários, motivo) |
| `briefing_added` | INTEGER | 1 = nota pré-consulta já foi postada |
| `briefing_hash` | TEXT | Hash do conteúdo (dedup: não reposta se igual) |
| `bloco_condicoes_enviado` | INTEGER | 1 = equipe enviou termo de pagamento |
| `comprovantes` | (tabela) | Fotos de PIX/transferência com análise (match 0/1) |

---

## Referências Completas

| Recurso | Localização |
|---------|-----------|
| **Pipeline de uma mensagem (detalhado)** | [CLAUDE.md](CLAUDE.md) seção "Pipeline de uma mensagem (visão geral)" |
| **Integrações externas (quirks + troubleshooting)** | [CLAUDE.md](CLAUDE.md) seção "Integrações externas" |
| **As duas agendas (Google + Moskit)** | [CLAUDE.md](CLAUDE.md) seção "As duas agendas" |
| **Classificação do deal (gates + reconciliação)** | [CLAUDE.md](CLAUDE.md) seção "Classificação do deal" |
| **Cliente que volta (novo atendimento)** | [CLAUDE.md](CLAUDE.md) + [src/cliente-retorno.js](src/cliente-retorno.js) |
| **Reunião de retorno (2ª+ reunião)** | [CLAUDE.md](CLAUDE.md) + [src/reuniao-retorno.js](src/reuniao-retorno.js) |
| **Notas de reunião (Gemini)** | [CLAUDE.md](CLAUDE.md) + [src/notas-reuniao.js](src/notas-reuniao.js) |
| **POP oficial (versão 1.2)** | `/docs/pop/fluxo-bot-whatsapp-moskit.html` (HTML) ou PDF |
| **Moskit IDs (fonte única)** | [src/moskit-ids.js](src/moskit-ids.js) |
