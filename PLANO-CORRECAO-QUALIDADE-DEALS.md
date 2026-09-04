> **Atualizado em 03/09/2026 depois de rodar contra o Moskit e o `conversations.db` de produção real
> (fresco, puxado da VPS — o local estava desatualizado desde 12/08).** Resultado por fase no final de
> cada seção. Resumo: **Fase 1 concluída** (1 deal corrigido); **Fases 2 e 3 não têm nenhum PUT
> seguro pra fazer** — viraram um worklist pra equipe revisar na mão (ver `worklist-qualidade-bot.js`).

# Plano — corrigir os deals que o bot deixou ruins

**Escopo decidido em 03/09/2026**: só os deals que o **bot** criou (106 no total), porque são os
únicos onde temos `conversations.db` local para confirmar cada correção com segurança, e são
realmente nossa responsabilidade (bug nosso causou o problema). O estoque bem maior do Moskit
Boost/cadastro manual (quase 3000 deals, ~77 pares duplicados, 627 sem campo obrigatório, 234 com
nome genérico) fica documentado mas **fora** deste plano — é uma decisão de negócio maior, sem dado
local pra confirmar nada, e não foi causado por nenhum bug que corrigimos.

Base: auditoria completa rodada em 02/09/2026 (`auditoria-crm/2026-09-02T18-41-08-335Z/`), 3096
deals, 106 do bot.

## Os três problemas, só no grupo do bot

| Problema | Quantos dos 106 | Fonte |
|---|---|---|
| Deal duplicado (par) | 13 deals (9 pares) | `01-duplicidade-deals.csv` |
| Campo obrigatório faltando | 62 deals | `02-campos-obrigatorios.csv` |
| Nome genérico no título | 45 deals (12 marcados "recuperável", precisa reconferir — ver Fase 3) | `03-nome-generico.csv` |

---

## Fase 1 — Duplicidade (9 pares, 13 deals)

Reusa o **mesmo padrão já aplicado e validado em 24/08/2026** (`corrigir-deals-duplicados-24-08-2026.js`):
marca o deal PERDEDOR como `LOST` + nota explicando o duplicado com link pro deal mantido. **Nunca
apaga nada, nunca mescla campos.**

Examinando os 9 pares um por um (nome, telefone, datas de criação), eles se dividem em dois grupos
bem diferentes — e tratá-los igual seria um erro:

### 1a. Alta confiança → aplicar automaticamente (4 pares, 8 deals)
Mesmo telefone, criados com **dias** de diferença, nome/caso praticamente idênticos — a assinatura
exata do bug de 10/08/2026 (`pm2 restart` em sequência durante teste de auto-deploy) já documentado
no `CLAUDE.md`:

| Par | Perdedor (já é o mais fraco) | Vencedor |
|---|---|---|
| Eric — Transferência de localidade | 48401150 (LOST, criado 10/08) | 48273067 (OPEN, criado 03/08) |
| Jailma — Direito Administrativo | 48403011 (LOST, 10/08) | 48272964 (OPEN, 03/08) |
| Regislane — Imóvel em leilão | 48401733 (LOST, 10/08) | 48346572 (OPEN, 06/08) |
| Washington (Wallace) Lins — Mandado de segurança | 48971188 (OPEN, 26/08) | 48474073 (WON, 14/08) |

Nos 3 primeiros o Moskit **já** marcou o duplicado como LOST sozinho (ou a equipe já fez) — a
correção é só postar a nota explicativa, sem mudar status. No do Washington, marcar 48971188 como
LOST (o WON já é o desfecho real) + nota.

### 1b. Precisa de revisão humana → NÃO aplicar sem olhar (5 pares, 5 deals do bot)
Todos cruzam com um deal do **Moskit Boost/manual**, criado **meses ou anos** antes — o sinal de
"mesmo nome" aqui é mais provável ser um **cliente que voltou anos depois com outro caso**
(retorno legítimo, não duplicata) do que um erro do bot:

| Par | Gap de tempo | Observação |
|---|---|---|
| Yago Pinto (Concurso UFPI, 2022) × Direito Administrativo (2026) | ~4 anos | mesmo contato no CRM, mas caso claramente diferente — parece retorno legítimo |
| Eliete (Compra de Imóvel, 2024) × Usucapião (2026) | ~2 anos | telefone DIFERENTE — pode nem ser a mesma duplicata |
| Hilton Charles (colação, 2025) × (colação, 2026) | ~1,7 anos | mesmo telefone, mesmo tipo de caso — mais suspeito, mas ainda não é o padrão do bug |
| Uriel (Vícios Construtivos, jun/26) × (Vícios Construtivos, ago/26) | ~7 semanas | telefone DIFERENTE apesar do caso idêntico |
| Jéssica (Distrato judicial, jul/26) × (mesmo texto, ago/26) | ~2 semanas | telefone DIFERENTE, texto quase idêntico |

Para estes, o script só **gera um relatório** (nome, telefone, datas, deal ids, link pros dois) pra
a equipe decidir caso a caso — nenhuma escrita automática.

### Resultado (executado em 03/09/2026)
Antes de escrever qualquer coisa, conferi os 9 pares AO VIVO contra o Moskit (não confiar no
snapshot de um dia atrás) e descobri que **3 dos 4 pares do grupo 1a original já tinham sido
corrigidos em 24/08/2026** (Eric, Jailma, Regislane — `corrigir-deals-duplicados-24-08-2026.js`,
já LOST com nota). A auditoria re-sinaliza porque ela ignora status. Sobrou só **1 par novo**:
Washington Lins (48474073, WON) × Washington Wallace Souza Lins (48971188, OPEN) — confirmado nas
notas dos dois (mesmo mandado de segurança por colação de grau, mesmo concurso), mesmo telefone,
`contactId` diferente no Moskit.

Script: `corrigir-deals-duplicados-bot-03-09-2026.js` — GRUPO A (1 par, aplicado) + GRUPO B (5 pares,
só relatório, nunca escreve). **✅ Aplicado**: deal 48971188 → LOST + notas nos dois lados, status
confirmado por GET depois do PUT.

---

## Fase 2 — Campos obrigatórios faltando (62 deals)

Mesmo espírito do `recuperar-origem-perdida.js` já existente: **usar a mesma função de produção**
(`aplicarGateCasoDescrito`/o merge de `mesclarParaCrm`) sobre o `last_data` já salvo em
`conversations.db`, nunca uma cópia da regra.

Para cada um dos 62 deals:
1. Ler `conversations.last_data` pelo `chat_id` (a coluna já existe no relatório `02-campos-obrigatorios.csv`).
2. Se o campo faltante JÁ está preenchido em `last_data` (bug de merge antigo, ou só nunca subiu pro
   CRM) → é candidato a correção automática.
3. Antes de escrever, **conferir de novo no CRM** (não no snapshot de 02/09, que já está velho) que o
   campo continua vazio — se a equipe já preencheu na mão nesse meio-tempo, pular sem barulho (mesma
   proteção do `recuperar-origem-perdida.js`).
4. Respeitar `campos_travados`/autoria — nunca sobrescrever campo que já foi corrigido manualmente.
5. Se `last_data` **também** não tem o valor (a conversa nunca capturou aquele dado) → não dá pra
   corrigir sozinho. Entra no relatório de "precisa perguntar ao cliente/equipe", não é aplicado.

### Resultado (verificado em 03/09/2026 contra o `conversations.db` de produção fresco)
Dos 43 campos faltando (29 assunto, 7 área, 7 advogado — origem fica de fora, já tem script
próprio e nem é gate de bloqueio), rodei a MESMA função de produção (`camposPendentes`) sobre o
`last_data` de cada um dos 20 deals envolvidos: **zero são recuperáveis**. Todo `assunto` que a
auditoria via como "tem algo no last_data" ou já era o placeholder `"Consulta jurídica"` na hora
da auditoria, ou (em 4 casos que tinham valor real em 02/09: Priscilla, Lucien Vitor, Jose Carlos,
Ianna) **regrediu para o placeholder depois** — sinal de um bug separado que vale investigar outro
dia, mas não é este plano. `area_direito`/`advogado_responsavel` nunca tiveram valor local: esses
deals nasceram pelas duas exceções do gate (dupla confirmação de horário ou bloco de condições
enviado) sem ninguém nunca ter descrito o caso depois — não é bug, é dado que realmente não existe.

**Não há script `--aplicar` para esta fase** — não existe PUT seguro pra fazer. Os 20 deals entram
no worklist único (ver final do documento).

---

## Fase 3 — Nome genérico (45 deals, mas os "12 recuperáveis" precisam de reconferência)

**Achado ao investigar para este plano**: a coluna `recuperavel_por_rename` da auditoria só checa se
`last_data.assunto` existe e não é o placeholder `"Consulta jurídica"` — ela **não** verifica se esse
assunto é ele mesmo só o nome da área (`rejeitarAssuntoQueEhArea`, a proteção que já existe em
produção). Exemplo real do relatório: deal 48212403 "Virna - Direito Imobiliario" está marcado
`recuperavel_por_rename=true` com `assunto_no_last_data="Direito Imobiliario"` — **exatamente igual**
ao que já está no título. Renomear com esse valor não mudaria nada.

Por isso a Fase 3 não pode confiar direto na coluna do relatório:
1. Para cada um dos (até) 12 marcados recuperável, rodar `rejeitarAssuntoQueEhArea` (a mesma função
   de produção) sobre `assunto_no_last_data` — só sobra candidato real se ela não rejeitar.
2. Para o que sobrar, montar o novo título com `montarPayloadMoskit` (a função de produção, nunca uma
   cópia da fórmula `${nome} - ${assunto}`).
3. Checar autoria (`__name` em `campos_travados`) — se o nome já foi editado manualmente, pular.
4. Confirmar no CRM que o nome ainda é o genérico esperado antes do PUT (mesma proteção das outras
   fases).

Os outros 33 (marcados `false`) e qualquer um dos 12 que cair no passo 1 vão para um relatório de
"nome genérico sem dado local pra corrigir sozinho" — a equipe decide se vale perguntar ao cliente.

### Resultado (verificado em 03/09/2026 contra o `conversations.db` de produção fresco)
Rodei o passo 1 (`rejeitarAssuntoQueEhArea`, agora exportada de `index.js` para este uso) sobre os
12 marcados `recuperavel_por_rename=true`: **nenhum sobrevive**. Todos os 12 tinham
`assunto_no_last_data` igual ao nome da própria área (Virna, Jailma, Marcos Vinicius, Ricardo,
Wdson, Matheus, Aline — renomear não mudaria nada) ou já tinham voltado para o placeholder / ficado
vazio. **Zero candidatos reais em toda a Fase 3.**

**Não existe `corrigir-nomes-genericos-bot.js`** — não haveria nenhum PUT pra ele fazer. Os 45 deals
entram no mesmo worklist da Fase 2.

### Worklist único (Fases 2 + 3)
`worklist-qualidade-bot.js` (sem `--aplicar` — é só leitura, não há nada pra aplicar) cruza os dois
relatórios da auditoria com o `conversations.db` mais fresco disponível, reconfere cada campo com as
mesmas funções de produção (`camposPendentes`, `ehAssuntoNeutro`, `rejeitarAssuntoQueEhArea` — nunca
uma cópia da regra) e gera `auditoria-crm/<timestamp>/worklist-qualidade-bot.csv`: **45 deals**, com
link do negócio, telefone, o(s) campo(s) faltando e as 3 últimas mensagens do cliente (pra quem for
revisar não precisar abrir o WhatsApp e o Moskit ao mesmo tempo). Rodar de novo a qualquer momento —
não escreve nada, só relê o estado atual.

---

## Fase 4 — religar a prevenção

As Fases 1–3 mostraram que a maior parte do estoque ruim (43 campos + 45 nomes genéricos) **não tem
correção automática possível** — é dado que a conversa nunca capturou. A Fase 4 deixou de ser
"depois de aplicar" e virou a prioridade real: sem ligar a prevenção, esse mesmo padrão (deal nasce
sem caso descrito, ninguém nunca completa) continua se repetindo a cada novo lead. Isso já está
escrito no código local (não commitado ainda — ver conversa anterior sobre "onde paramos"), falta
decidir:
- Deploy do que já está pronto localmente (vocabulário de origem ampliado, correção do "título
  congelado no placeholder", `deveEsperarCamposObrigatorios`).
- Decidir quando tirar `BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN` do dry-run (hoje só loga, não bloqueia
  nada de verdade) — recomendo observar os logs por alguns dias de produção real antes de ligar.
- Dado o worklist de 45 deals, vale a equipe ter um processo leve pra fechar essas lacunas assim que
  aparecem (ex.: revisar o worklist semanalmente), em vez de deixar acumular até a próxima auditoria.

## Fase 5 — limpeza da aba "Agendamento de Consulta" (03/09/2026)

Pedido separado do usuário, depois das Fases 1–4: analisar os 87 deals abertos naquele estágio,
cruzar pra achar duplicata "com nome diferente e caso igual", e separar o que já pode ser fechado.
Ferramenta: `limpeza-agendamento-consulta.js` (offline, 3 eixos — duplicidade em 3 forças de sinal,
abandono por quem-falou-por-último, e recusa explícita por varredura de frase do cliente).

**Duplicidade — 7 pares mesclados e aplicados** (`corrigir-duplicidade-agendamento-03-09-2026.js`):
todos confirmados como MESMO TELEFONE com `contacts.id` DIFERENTE — a assinatura exata do bug de
`buscarOuCriarContato`; 4 dos 7 nasceram em **10/08/2026**, o dia dos `pm2 restart` em sequência.
Regra aplicada: mantém o mais avançado no funil, complementa os campos VAZIOS dele com o valor do
perdedor (nunca sobrescreve valor existente), e fecha o perdedor como LOST + nota nos dois lados.
O caso mais rico foi a Hedina: o deal mais avançado estava com título genérico e sem área/advogado,
e recebeu os três do duplicado, mais o nome real do caso.

**Achado que mudou uma conclusão**: 15 deals ficaram mudos no MESMO dia (11/08), todos depois de um
follow-up em massa da equipe. Antes de recomendar fechar, medi duas coisas: a ingestão de mensagens
estava saudável no período (100+ msgs de cliente/dia até 02/09), e a campanha teve **45% de resposta**
(17 de 38). Ou seja, foi entregue e funciona — quem não respondeu, não respondeu mesmo. Sem essa
checagem a recomendação de "fechar 24 como perdido" seria um chute em cima de uma possível falha de
sistema.

**Par Martha Luiza (48423360 × 49298706) — analisado a fundo e DEIXADO COMO ESTÁ, por decisão do
usuário em 03/09/2026.** A análise apontou mesmo caso (o briefing dos dois descreve "remoção por
motivo de saúde" da mesma servidora federal; o nome completo do 2º deal só apareceu na conversa em
25/08, ao preencher o contrato; existe **um único** comprovante de R$1.500, de 25/08; nenhum dos dois
tem atividade própria; e a nota de 27/08 do deal novo mostra o bot re-lendo a confirmação da consulta
que já tinha ocorrido). Mesmo assim o usuário optou por não mexer, por considerar um caso
excepcional. **Consequência conhecida e aceita**: o CRM segue reportando R$3.000 para uma cliente que
pagou R$1.500. Não reabrir esta discussão sem pedido dele.

**A 2ª leva, e a causa raiz que ela revelou.** Ao conferir um par que a análise tinha classificado
como "telefone diferente" (Jéssica), os dois números eram o mesmo com e sem DDI. Refazendo o
cruzamento pelos últimos 8 dígitos, o número saltou de 20 para **46 dos 87** negócios com par no
mesmo telefone. A causa está documentada em detalhe no `CLAUDE.md` (seção do Moskit CRM): a busca de
contato comparava o telefone inteiro, então todo lead que já existia no Moskit Boost em formato local
virava contato novo + deal duplicado. **Corrigido no código** (`buscarOuCriarContato` passa a usar
`mesmoTelefone`, com fallback por sufixo que desiste quando ambíguo) + 3 regressões.

Aplicado depois disso: **8 pares Boost×bot mesclados** (`corrigir-duplicidade-boost-03-09-2026.js`),
mantendo o deal do BOT — porque `conversations.deal_id` aponta pra ele e fechá-lo deixaria a
automação escrevendo num negócio perdido. Dois deles (Virna, Aline) só ficaram certos porque o teste
de "título genérico" passou a usar `rejeitarAssuntoQueEhArea`: sem isso o merge manteria
"Virna - Direito Imobiliario" e descartaria "Virna - Recebimento de valor de imóvel leiloado".
Os sobreviventes ficaram ABERTOS de propósito, mesmo os marcados como "cliente sumiu": o silêncio
está só na thread do bot, e a conversa pode ter seguido no registro do Boost — que não tem espelho
local pra eu enxergar. Fechar os dois lados com meia informação seria pior que deixar pra equipe.

**Resultado da aba**: 87 → **52 negócios abertos** (-40%). 35 fechados, todos com ` [bot limpeza]` no
fim do nome (marcador pedido pelo usuário, no fim e não no começo pra não quebrar o corte em
" - " que `extrairNomeCaso` e a auditoria usam pra separar pessoa de caso).

## Status final (03/09/2026)

| Fase | Resultado | Escrita real |
|---|---|---|
| 1 — duplicidade | 1 par corrigido (Washington), 5 pares no relatório pra equipe (precisam de julgamento humano — ver abaixo) | ✅ 1 PUT + 2 notas |
| 1.5 — bug de regressão do assunto | achado, corrigido no código (`mergeDados`) e os 4 deals conhecidos restaurados | ✅ 4 PUTs no Moskit + 4 UPDATEs no `conversations.db` de produção |
| 2 — campos obrigatórios | 0 recuperáveis — todos os 20 deals no worklist | nenhuma |
| 3 — nome genérico | 0 recuperáveis — os 45 deals no worklist | nenhuma |
| 4 — prevenção (deploy + ligar bloqueio) | **fora de escopo por decisão deliberada** — ver nota abaixo | nenhuma |

**Por que a Fase 1b (5 pares) e a Fase 4 continuam sem ação, mesmo depois de "resolver tudo":**
- Os 5 pares de duplicidade restantes cruzam com deals do Moskit Boost meses/anos mais velhos —
  marcá-los como duplicata automaticamente arrisca derrubar como "perdido" o negócio de um cliente
  que só está voltando com um caso novo (o que a própria funcionalidade "Cliente que volta" existe
  pra tratar direito). Errar aqui prejudica um cliente de verdade; a decisão precisa de alguém que
  conhece o caso.
- A Fase 4 inclui rodar `pm2 restart` na VPS (o deploy termina com isso) — e o bot está **parado por
  pedido explícito seu em outra conversa hoje** ("apenas desligue a automação"). Religar ele como
  efeito colateral de um deploy sem confirmar contradiria esse pedido. Avise quando quiser religar e eu
  sigo com o deploy.

**Arquivos gerados**: `corrigir-deals-duplicados-bot-03-09-2026.js` (já executado, não reexecutar,
mesma convenção dos `corrigir-*.js` anteriores), `worklist-qualidade-bot.js` (reexecutável a
qualquer momento, só leitura) e `auditoria-crm/2026-09-02T18-41-08-335Z/worklist-qualidade-bot.csv`
(a lista pra equipe — 45 deals, link + telefone + campo faltando + últimas mensagens do cliente).

Nenhum passo aqui roda em CI/automático — os scripts seguem a convenção do projeto (dry-run por
padrão quando há algo pra aplicar, `--aplicar` explícito, nunca em `npm test`). Para verificar de
novo no futuro: `CONVERSATIONS_DB=<copia fresca de produção> node worklist-qualidade-bot.js` sobre
uma auditoria nova (`auditar-crm-coletar.js` + `auditar-crm-relatar.js`).

Próximo passo real: decidir a Fase 4 (deploy do que já está pronto localmente + ligar o bloqueio de
campos obrigatórios de verdade) — é isso que impede o worklist de crescer de novo.
