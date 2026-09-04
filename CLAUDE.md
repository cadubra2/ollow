# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bot WhatsApp (via [Zernio](https://zernio.com)) → OpenAI → Moskit CRM, para o escritório de advocacia
Caballero, Rocha & Carvalho. Recebe mensagens de WhatsApp, usa a OpenAI para qualificar o lead e
extrair dados do atendimento, cadastra/atualiza o negócio no Moskit CRM, e agenda a consulta no
Google Calendar (com link do Meet) quando cliente e equipe confirmam o mesmo horário.

**A documentação de processo (POP) é a fonte da verdade sobre o fluxo de negócio**, não o código —
consulte antes de mudar comportamento de negócio: `docs/pop/fluxo-bot-whatsapp-moskit.html` ou o PDF
`docs/pop/Fluxo - Bot WhatsApp e CRM Moskit v1.2.pdf`.

## Commands

```bash
npm install
npm start                # roda o servidor (node index.js), porta padrão 3000
npm test                 # suíte determinística sem rede — roda em qualquer ambiente/CI
npm run test:ia          # chama a OpenAI de verdade (test-dupla-confirmacao.js) — custa créditos
node test-telefone.js    # roda um arquivo de teste isolado (mesmo padrão para os demais test-*.js)
```

`npm test` roda `rodar-testes.js`, que executa em sequência (parando no primeiro que falhar):
`test-telefone.js`, `test-chatwoot.js`, `test-moskit-ids.js`, `test-atividade-moskit.js`, `test-evidencia.js`,
`test-briefing.js`, `test-fila.js`, `test-payload.js`, `test-rotas.js`, `test-pipeline.js`,
`test-agenda-dry-run.js`, `test-bloqueio-campos-obrigatorios-dry-run.js`, `test-guards-internos.js`, `test-agendamento-bloco-mensagens.js`,
`test-transcricao.js`, `test-zapsign.js`, `test-notas-reuniao.js`,
`test-cliente-retorno.js`, `test-cliente-retorno-flags.js`, `test-reuniao-retorno.js`,
`test-reuniao-retorno-flags.js`, `test-chatwoot-flags.js`.
Todos usam `DB_PATH` apontando para um arquivo inexistente (banco descartável) —
**nunca** deixe um teste abrir `conversations.db` de produção.

**A suíte roda com `TZ=UTC`, o fuso da VPS** — é isso que o `rodar-testes.js` existe para garantir.
Antes ela rodava no fuso de quem executava, que na máquina de dev é `America/Fortaleza`, o *mesmo* do
escritório: todo bug de fuso passava batido porque o relógio do teste e o relógio esperado eram o
mesmo. Para investigar um caso específico, `TZ_TESTES=America/Fortaleza npm test` troca o fuso; rodar
um arquivo isolado (`node test-pipeline.js`) usa o fuso do sistema, então prefira o `npm test` antes
de commitar. A suíte passa em UTC, `America/Fortaleza`, `Asia/Tokyo`, `America/Los_Angeles` e
`Pacific/Kiritimati` — se um teste novo só passa num fuso, ele encontrou um bug de verdade.

### Scripts manuais — NUNCA rodar automaticamente/em CI

Escrevem em dados reais de produção (Moskit e/ou banco real):

- `test-moskit-put.js <dealId> [--aplicar]` e `test-moskit-real.js` — chamadas de escrita reais na
  API de produção do Moskit (criam/movem deals de verdade).
- `testar-briefing-unico.js` — idem, cria contato/deal reais no Moskit.
- `test-zapsign-real.js <email> [--aplicar]` — cria um documento REAL no ZapSign a partir do
  template de produção e dispara um e-mail de assinatura de verdade para o e-mail informado.
- `test-moskit-atividade-real.js <dealId> [--aplicar] [--manter]` — mede o contrato de `/activities`
  contra a API real. Sem `--aplicar` é só leitura (amostra real + o payload que seria enviado); com
  `--aplicar` varre rota × variante de payload até uma ser aceita, cria a atividade DE VERDADE na
  agenda do CRM, mede qual padrão de `PUT` move o `dueDate` e apaga a atividade no fim (`--manter`
  desliga a limpeza). É o script que valida a conversão de fuso antes de mexer no agendamento.
- `test-moskit-anexo-real.js <dealId> [--aplicar] [--url=...] [--subir-tunel] [--manter]` — mede o
  contrato de `/deals/{id}/attachments` e, principalmente, **se o PDF atravessa o túnel intacto até o
  Moskit**. Sem `--aplicar` é só leitura. Com `--aplicar` cria um anexo REAL num deal de teste,
  compara `size`/`mimeType`/primeiros bytes com o PDF original, tenta também um POST multipart (não
  documentado) e apaga tudo no fim. **`--subir-tunel` é explícito e não é o padrão**: no plano
  gratuito o ngrok aceita UMA sessão por conta, então subir um túnel aqui pode derrubar o de produção
  e o bot para de receber webhook do WhatsApp — sem erro nenhum neste script. Prefira `--url=` com um
  PDF já servido publicamente.
- `test-dedupe-agenda-real.js [--aplicar]` — prova, contra o Moskit e o Google reais, que a consulta
  não entra duas vezes na agenda: roda `POST /sincronizar-atividades` duas vezes, com e sem a linha
  em `atividades_sincronizadas`. Sem `--aplicar` é só leitura. Com `--aplicar` cria uma atividade e
  um evento de teste e apaga os dois no fim. Seguro por construção (`WORKER_MODE=1` carrega o
  `index.js` sem servidor e sem os `setInterval`, `DB_PATH` descartável, Telegram desligado, e toda
  atividade futura de cliente real entra pré-marcada para não virar evento) — mas ainda assim
  escreve em produção, então não é `npm test`.
- `GET /auditoria-classificacao?aplicar=1` — escreve nos deals reais (corrige a classificação). Em
  dry-run (sem `aplicar`) é só leitura e pode rodar à vontade.
- `varrer-agenda-horarios.js [inicio] [fim]` — varre o Google Agenda, as atividades do Moskit e o
  `conversations.db` de produção em busca de consulta em horário errado. **Só leitura, sem `--aplicar`
  nenhum** (nada foi deixado atrás de um `if`), mas lê três produções ao mesmo tempo, então fica fora
  do `npm test`. Diferente de `GET /auditoria-agenda`, que parte do banco, este parte da AGENDA — vê o
  que foi marcado direto no CRM ou na mão, inclusive evento que o banco não conhece (foi assim que
  apareceram dois casos de horário errado que a rota não enxergava). Para ler o banco de produção de
  dentro de um worktree, passe `CONVERSATIONS_DB=/caminho/conversations.db`.
- `replay-dupla-confirmacao.js [dealId...]` — replay de conversa REAL contra a OpenAI (custa créditos),
  para descobrir por que uma perna da dupla confirmação se perdeu. Mostra as observações que o modelo
  emitiu, o que foi descartado e por quê, e dá o veredito: regra de prompt, validação, ou horário
  recusado pela rede determinística (que é o comportamento correto). Só leitura — abre o banco de
  produção num handle readonly e usa `DB_PATH` descartável para o boot do `index.js`. Foi ele que
  revelou os dois defeitos descritos em "O eco da data-âncora" e "Propagação de dia corrigido".
- `avaliar-extracao.js [--so-gratis] [--limite N] [--concorrencia N] [--rubrica] [--sem-estado]
  [--so-com-desfecho] [--seed N] [--rotulo <txt>]` —
  **linha de base da qualidade da extração**, para que "melhorou" deixe de ser opinião. Duas camadas:
  a **camada 0 é grátis** e mede sobre o corpus inteiro o que ele já prova sozinho (silêncio por
  `last_action`, conversas acima de 100 mensagens que o polling trunca, mensagens que são só
  placeholder de anexo — **separando áudio, que é transcrito, do que de fato se perdeu** —,
  preenchimento dos 22 campos e o perfil dos resumos que a produção gravou, com a contagem dos
  literais "Não mencionado"); a **camada 1 chama a OpenAI** e atribui cada conversa ao portão que a
  engoliu, refazendo a cadeia de `processarConversaDirect` com as funções exportadas (B1 inviável,
  B2 confiança < 6, B3 sem caso descrito, **B4 briefing engolido por `pendentes.length`**). Só
  leitura, com as proteções do `replay-dupla-confirmacao.js` mais uma: `MOSKIT_BASE`/`ZAPSIGN_BASE`
  apontados para `127.0.0.1:9`, para que escrita acidental falhe alto em vez de gravar no CRM.
  **Concorrência 2, não mais**: com 4 o teto de tokens por minuto da conta derrubou 163 das 277
  conversas de uma rodada. A saída bruta tem telefone, nome e caso — está no `.gitignore`; só o
  `avaliacoes/agregado-*.json` (contagens) é versionado.
  **O EIXO DO TÍTULO, acrescentado em 02/09/2026 — e a falta dele era o buraco mais sério do
  instrumento.** A queixa do dono é sobre o *nome do negócio*, e o script media o resumo em detalhe e
  **descartava o assunto**: o replay guardava `resumo_novo` e o assunto era extraído, usado e
  esquecido. "O campo `assunto` está preenchido" é outra pergunta — `"Consulta jurídica"` está
  preenchido e não serve. Agora cada conversa sai classificada em `assunto_especifico` ·
  `titulo_generico` · `titulo_so_nome` · `assunto_igual_a_area`, com o título montado pela **função da
  produção** (`montarPayloadMoskit`, nunca uma cópia da regra `${nome} - ${assunto}`), mais
  `assunto_bruto` (antes de `rejeitarAssuntoQueEhArea`, para saber quantas vezes o modelo erra e a
  proteção pega), `assunto_ancorado` (fração dos tokens do assunto presentes **literalmente** no
  texto da conversa) e `linhas_uteis_do_resumo` (tópico com conteúdo, não com "não mencionado" —
  contar caracteres não distingue os dois). As observações passam a sair **emitidas × válidas por
  tipo**: a diferença é o que a conferência de trecho literal reprovou, e é ela que separa "o modelo
  não emite esse tipo" de "emite e é barrado" — consertos opostos.
  ⚠️ **`assunto_ancorado` é diagnóstico, NUNCA portão — e a primeira rodada do instrumento já provou
  por quê.** Havia a ideia de exigir "≥50% dos tokens do assunto presentes no texto" como proteção
  substituta para liberar evidência de *tema*. MEDIDO em 02/09/2026 (chat 558695411529): o cliente
  escreveu "os documentos necessário", "comprei uma casa da minha mãe", "acordo de compra e vendas";
  o modelo devolveu **"Documentação de Propriedade Imobiliária"** — caracterização jurídica correta e
  útil, com ancoragem **zero**, porque nenhuma dessas palavras foi dita. Na mesma rodada o
  **placeholder** "Consulta jurídica" pontuou **0,5**, porque "consulta" aparece em qualquer conversa
  de escritório. Um portão desses reprovaria a síntese boa e aprovaria o placeholder. A confusão era
  entre duas coisas diferentes: ancorar o **trecho da observação** (citação literal de uma mensagem,
  que `conferirTrecho` em `src/evidencia.js` já exige, e que é impossível fabricar a partir do prompt)
  e ancorar as **palavras do assunto**, que é síntese por natureza. A proteção correta é a primeira.
  A métrica continua valendo para o outro caso — invenção do nada, como o deal 48423360, em que o
  tema saiu do perfil de um sócio escrito **no prompt** — e é lida caso a caso, junto de
  `titulo_classe`.
  Duas correções de amostragem no mesmo passo: `--limite N` **sorteia pela seed** em vez de
  `slice(0, N)` sobre a ordem de `chat_id` (que é telefone — com 197 das 277 conversas `inviavel`,
  uma fatia de 30 virava ~22 B1 e media quase nada), e `--so-com-desfecho` exclui `inviavel`/`interno`
  sem deal. E a rubrica humana caiu de **40 para 20 linhas**: das 40, **18 tinham as duas colunas de
  resumo vazias** — só 16 comparavam. Agora só entra conversa com algo a julgar, estratificada por
  desfecho do título, com a coluna nova `titulo_do_deal_serve__sim_nao`. Vinte linhas julgáveis valem
  mais que 40 com 45% em branco: a atenção do dono é o recurso escasso, não o número de linhas.
- `test-cenarios-classificacao.js` e `test-simulacao.js` — chamam a OpenAI de verdade mas não têm
  asserção automática de pass/fail; servem para inspeção manual, não regressão.
- `sondar-chatwoot.js [--contato=<id>] [--paginas=N]` — mede, contra a instância REAL do Chatwoot, os
  cinco contratos que a sincronização de nomes assume e que **erram em silêncio**: se `page=N` pagina
  de verdade (paginação ignorada em silêncio já aconteceu 3× com o Moskit neste repo — o loop relê a
  primeira página, escreve 15 contatos e PARECE ter varrido 4 mil), em que formato o `phone_number`
  está gravado (é o que decide se `filter equal_to`, que é comparação de STRING, casa algo), quantas
  fichas têm nome vazio/telefone/humano (o tamanho do problema pelo lado do Chatwoot), se o
  `identifier` já é usado por outra integração, e — a pergunta mais perigosa — **se o PUT mescla ou
  SUBSTITUI `custom_attributes`**. Só leitura, e nada é gravado em disco. A sondagem do PUT é a única
  exceção: exige `--contato=<id>` explícito e o contato tem de ser um de TESTE criado à mão.
  **Rodar ANTES do backfill** — sem isso o resto é fé.
- `backfill-chatwoot-nomes.js [--aplicar] [--refrescar-espelho] [--sem-varredura] [--limite=N]
  [--so=<telefone>] [--db=<caminho>]` — preenche de uma vez o nome dos contatos que já existem no
  Chatwoot (a rotina periódica pega os novos). Sem `--aplicar` é só leitura: mede, imprime o perfil por
  fonte do nome e por classe do nome anterior, e escreve um CSV com uma linha por contato. Com
  `--aplicar` **escreve nas fichas do Chatwoot**. Reusa a função de produção
  (`sincronizarContatosChatwoot({detalhar:true})`), nunca uma cópia da regra.
  ⚠️ **Diferente dos outros scripts manuais, este NÃO usa `DB_PATH` descartável** — e é deliberado: o
  estado da sincronização (`nome_escrito`, `escrita_hash`, `travado_humano`) vive em
  `chatwoot_contacts`, e é a memória que a rotina periódica lê depois. Gravar num banco temporário
  faria o backfill rescanear o Chatwoot inteiro a cada execução, ignorar as travas de renomeação
  humana que a produção já registrou, e fazer a rotina refazer todo PUT no ciclo seguinte. O padrão é
  `conversations.db` — na VPS, o de produção, que é onde ele DEVE gravar. O script imprime o caminho e
  a idade do banco, e grita se passar de 7 dias (todo nome vem dele). A pasta `chatwoot-backfill/`
  está no `.gitignore`: telefone + nome + link do negócio de milhares de pessoas.
- `sondar-notas.js [dealId]` — mede, contra as APIs reais, os contratos que a rotina de notas de
  reunião assume: se `GET /deals/{id}/notes` devolve o texto (e como pagina), se `events.list` traz
  `attachments[]` pela credencial do bot, e qual a cobertura real do passo "Telefone:" da cascata.
  **Só leitura**, mas lê Moskit e Google de produção, então fica fora do `npm test`.
- `diagnosticar-classificacao.js [--sondar-crm]` — mede o tamanho de cada causa raiz de origem/área/
  advogado vazios (travado por edição manual, opção inválida nunca corrigida, fora da janela da
  reconciliação periódica, sem evidência de caso, suspeita do bug de merge histórico, deal criado fora
  do bot) antes de decidir o que vale corrigir — ver "Classificação do deal" acima. **Só leitura**: os
  5 primeiros buckets são 100% locais (zero chamada de rede); o 6º (deal fora do bot) sempre lê
  `/activities` paginado (~20 requisições) e só bate em `/deals/{id}` individualmente com a flag
  explícita `--sondar-crm` (o script imprime a contagem e o tempo estimado antes de pedir a flag). Lê
  Moskit de produção, então fica fora do `npm test`.
- `estudar-deals-sem-origem.js` — lista, deal por deal (não só contagem), todo negócio marcado pelo
  próprio Moskit com `origin: 'BOT_WHATSAPP'` (o CRM grava isso a partir do header `X-Ollow-Origin`
  que o bot manda em toda escrita — mais confiável que cruzar por `conversations.deal_id`, que fica
  incompleto: cliente-retorno zera `deal_id` da linha ao abrir atendimento novo, e deal criado fora do
  bot nunca tem linha) e que está sem o campo "Origem" no CRM real. Pagina `/deals` inteiro por
  `?start=` — MEDIDO em 21/08/2026 que, ao contrário do que o comentário antigo de
  `auditoria-funil-completo` registra (`limit`/`page` são ignorados), `start=` pagina de verdade, e
  cada página já vem com `entityCustomFields` completo (sem GET por deal). Cruza com `conversations`
  (linha atual + `deals_anteriores`) para tentar explicar a causa; sem correspondência local, reporta
  só o fato. "Sem origem" conta tanto campo ausente/vazio quanto a opção "Não identificado" (id
  `435777`) explicitamente marcada — decisão de negócio, não só técnica: ver "Classificação do deal"
  acima. **Só leitura**, mas varre a conta inteira (~300 requisições numa base de 3000+ deals), então
  fica fora do `npm test` — rodar direto na VPS evita reintroduzir latência de rede.
- `estudar-deals-duplicados.js [--db=<caminho>] [--sondar-crm] [--so-bot]` — duas fases de estudo de
  deal DUPLICADO (mais de um negócio pro mesmo atendimento/cliente por engano). **Fase 1** (padrão,
  100% local): reaplica `chaveArea`/`assuntoEspecifico` de `src/cliente-retorno.js` sobre toda cadeia
  já registrada em `conversations.deals_anteriores`, mais um sinal que a produção não usa
  (similaridade textual entre os dois assuntos), pra separar retorno legítimo de duplicidade
  disfarçada por assunto raso mudando. **Fase 2** (`--sondar-crm`, rede real): pagina `/deals` inteiro
  por `?start=` e clusteriza por nome+caso parecidos, com um filtro tipo IDF — token que aparece em
  muitos deals (`fies`, `remoção`, sobrenome popular) não conta como sinal de identidade sozinho,
  senão a maioria dos ~2793 leads do Moskit Boost gera falso positivo por "mesma área jurídica".
  `--so-bot` restringe a comparação aos deals `origin=BOT_WHATSAPP` — "desde que o bot existe", em vez
  da conta inteira (que tem leads desde 2021, irrelevantes pra medir duplicidade causada pelo bot).
  **Achado em 24/08/2026** (o que motivou os dois fixes em `buscarOuCriarContato`/`buscarDealPorContato`
  documentados em "Integrações externas" abaixo): 14 dos 102 deals que o bot já criou desde 23/07/2026
  estavam em pares duplicados — mesmo telefone, dois `contacts.id` diferentes no Moskit — 8 deles
  concentrados no dia 10/08/2026, quando o auto-deploy foi testado com vários `pm2 restart` em
  sequência. **Só leitura**, mas a Fase 2 varre a conta inteira (~300 requisições), então fica fora do
  `npm test`.
- `auditar-crm-coletar.js [--confirmar] [--retomar=<dir>] [--so-fases=A,B,C,D] [--notas-max=N]
  [--notas-paginas=N]` e `auditar-crm-relatar.js [<dir>] [--parado-dias=N] [--db=<caminho>]` — a
  auditoria do CRM em **dois** scripts, e a separação é o ponto: o coletor é a única coisa que toca a
  API (~1.260 requisições, ~20 min) e grava um snapshot cru em `auditoria-crm/<timestamp>/` (JSONL
  append-only, `manifesto.json` com cursor de retomada e os quirks medidos na rodada); o relatório é
  **100% offline** e deriva os CSVs em segundos. Assim calibrar um limiar ou mudar o corte de "deal
  parado" custa 3 segundos, não outra varredura. **Zero escrita, e a garantia não é a revisão de
  código:** o coletor instala um interceptor no axios que **lança em qualquer requisição que não seja
  `GET`** — e como `require('axios')` devolve sempre a mesma instância, a trava vale também para o
  código reusado de dentro do `index.js` (`acharEmColecaoDoDeal`, `listarAtividadesMoskit`). O
  relatório vai além e bloqueia *toda* requisição, de qualquer método. `test-auditoria-crm.js` verifica
  que a trava dispara — garantia que ninguém checa não é garantia. O coletor também lê os headers de
  rate limit (piso de 300ms, espera quando a cota da janela acaba, **429 com backoff 1/2/4/8/16s
  repetindo a MESMA página** — avançar o cursor num 429 pularia 10 registros em silêncio) e registra
  o mínimo observado no manifesto. A **fase D (notas) exige `--confirmar`**: é a mais cara, e sem ela
  o script imprime a contagem e o custo estimado e para. Duas ressalvas que o relatório repete no
  cabeçalho: notas existem só para o **conjunto candidato**, então deal sem nota lida sai como
  `nao_avaliado_nota_nao_lida` e **nunca** como "sem resumo"; e o `conversations.db` local sendo antigo
  subestima toda coluna do lado local — o relatório calcula a idade do banco e grita se passar de 7
  dias. Saída em `auditoria-crm/<ts>/relatorios/`: `00-inventario.csv` (um deal por linha, um booleano
  por problema — é o que se ordena) mais os drill-downs `01-duplicidade-deals` (com
  `MESMO_TELEFONE_CONTATOS_DIFERENTES`, a assinatura do bug de 24/08), `02-campos-obrigatorios`,
  `03-nome-generico` (a coluna decisiva é `assunto_no_last_data`: "Fulano - Consulta jurídica" cujo
  `last_data.assunto` diz "Abatimento do FIES" é **rename recuperável**, não dado faltando),
  `04-resumo`, `05-contatos-duplicados`, `06-deals-parados`, `07-por-origem` e
  `08-campos-personalizados`. **Só leitura**, mas varre a conta inteira, então fica fora do `npm test`.
  A pasta `auditoria-crm/` está no `.gitignore`: é o artefato mais sensível que este repositório
  produz — nome, telefone e caso de ~4.265 pessoas em texto puro.
- `recuperar-origem-perdida.js [--aplicar]` — dos deals sem origem, separa quem o modelo já examinou
  e genuinamente não achou nada (fallback correto) de quem teve `last_data` apagado pelo bug de
  `'inviavel'`/`'interno'` mas ainda tem a conversa intacta em `messages`. **Reescrito em 02/09/2026**
  para usar a MESMA função que roda em produção (`aplicarPadroesDeterministicosDeOrigem`, importada
  de `index.js`, em vez de uma cópia local de regex) — a mesma pergunta ("essa conversa tem sinal de
  origem?") não pode ter duas respostas diferentes dependendo de qual caminho de código a examina.
  Zero chamada de IA. Sem `--aplicar` é só leitura (o comportamento de sempre); com `--aplicar`
  **escreve no Moskit real**: para cada deal com sinal detectado, confere de novo no CRM (não no
  snapshot local) que o campo Origem ainda está vazio/"Não identificado" — se a equipe já corrigiu na
  mão nesse meio-tempo, pula sem barulho — e faz um PUT que só troca o campo Origem, preservando todo
  o resto do deal (mesmo padrão de `corrigir-tipo-consulta.js`: nunca reconstrói o payload do zero).
  Cuidado com falso positivo ao estender o vocabulário: "google" sozinho pega o convite do Google
  Meet/Calendar que toda consulta agendada insere no texto, termos sem `\b` (limite de palavra) pegam
  substring dentro de outra palavra ("danos materi**AIS**" bateu em `matéria`), e "artigo"/"amigo"/
  "parente" sozinhos são comuns em conversa jurídica sem ser sobre origem ("artigo 927 do código
  civil", "meu amigo teve um problema parecido") — por isso a versão que RODA (produção) exige mais
  contexto que a versão original só-leitura deste script (verbo de consumo — "vi/li um artigo" — ou
  substantivo de indicação explícito, nunca a palavra solta).
  **`--aplicar` exige `createdBy` e, em deal fechado, `closeDate`/`lostReason` no payload — MEDIDO em
  02/09/2026 na primeira rodada real contra os 17 candidatos.** Um PUT preservando nome/status/stage/
  responsible/contacts/activities mas **sem** `createdBy` volta `422 {"messageError":"Id cannot be
  null","field":"createdBy.id"}` (deal 48412103) — o Moskit exige o campo mesmo num PUT que só troca
  um custom field; `atualizarNegocioMoskit` (index.js) nunca sofre disso porque sempre manda um valor
  fixo (`LAYLA_USER_ID`), mas aqui o certo é preservar o criador ORIGINAL do GET, não forçar. Deal
  `LOST`/`WON` tem uma segunda exigência: sem `closeDate` e `lostReason` (quando aplicável) o PUT volta
  422 nos dois campos (deal 48317782) — mesmo padrão já documentado para `atualizarNegocioMoskit` em
  "Integrações externas" abaixo (`status`/`closeDate`/`lostReason` preservados do GET), só que faltava
  neste script. Das 17 correções da rodada real: 12 já estavam certas no CRM (o snapshot local do
  `conversations.db` estava atrasado — a proteção "confere de novo antes do PUT" pulou todas sem
  sobrescrever), e as 5 que precisavam de escrita batiam nesses dois 422 até os campos serem
  adicionados; as 5 fecharam com 200 depois da correção.
- `reprocessar-nota-reuniao.js <gmailMessageId> <dealId> [--aplicar]` — religa à mão uma nota de
  reunião que ficou órfã (o id vem no aviso do Telegram). Sem `--aplicar` só imprime a nota que
  iria; com `--aplicar` **escreve no CRM**.
- `religar-atividade.js <dealId> <atividadeId> [--aplicar]` — religa à mão uma Atividade do Moskit que
  ficou sem vínculo com o negócio e **limpa o estado terminal** (`vinculo_desistiu`) que a
  reconciliação deixou depois de desistir. O comando exato vem no aviso final do Telegram. Sem
  `--aplicar` só imprime o vínculo atual e o PUT que seria enviado; com `--aplicar` **escreve no
  CRM** (GET + PUT com o corpo do GET inteiro, `deals` corrigido) e zera o estado no banco para a
  rotina voltar a vigiar.
- `autorizar-google-notas.js` — OAuth interativo do Gmail/Drive para a rotina de notas (roda uma
  vez, porta 8092). Grava `google-oauth-token-notas.json`.
- `corrigir-*.js` — scripts pontuais de correção de dados já aplicados (histórico, não reexecutar).

### Gerar segredos

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Usado para `ADMIN_TOKEN`, `WEBHOOK_SECRET` e `DEPLOY_WEBHOOK_SECRET`.

## Architecture

Aplicação Express monolítica: **`index.js` (~6600 linhas) contém o servidor, todas as rotas e todo o
pipeline de negócio.** Não há camadas separadas de controller/service — funções são declaradas de
cima a baixo no mesmo arquivo e chamadas diretamente. Ao navegar o código, procure por nome de função
em vez de esperar uma estrutura de diretórios.

```
index.js                servidor Express: webhook, rotas administrativas, todo o pipeline
worker.js                processa a fila de conversas pendentes; roda como processo FILHO de index.js
                         (faz require('./index.js') e chama bot.processarConversaDirect)
processar_pendentes.js   reprocessamento manual de conversas presas
autorizar-google.js      gera google-oauth-token.json (rodar uma vez, interativo)
deploy.js                git pull + npm install + npm test + pm2 restart; disparado por POST
                         /deploy-webhook a cada push (processo filho DESACOPLADO — sobrevive ao
                         restart que ele mesmo provoca no processo que o gerou)
src/
  agendamento.js         dupla confirmação de horário (cliente + equipe precisam confirmar o mesmo slot)
  atividade-moskit.js    payload da Atividade (a consulta na agenda do CRM) + conversão do horário
                         naive do escritório para o instante absoluto que o Moskit espera
  bloco-condicoes.js     detecção do bloco de condições de pagamento enviado pela equipe
  evidencia.js           validação das observações extraídas pela IA
  fila.js                fila de retry em disco para o worker (MAX_TENTATIVAS, depois desiste e avisa Telegram)
  mensagens.js           deduplicação e ordenação cronológica de mensagens do WhatsApp
  moskit-ids.js          TODOS os IDs/campos do Moskit — fonte única, ver abaixo
  briefing.js            texto da nota de briefing pré-consulta (cabeçalho determinístico + hash)
  csv.js                 escrita de CSV — UMA implementação. Havia três cópias do escape espalhadas
                         pelos scripts de estudo e uma estava errada (misturava JSON.stringify, que
                         escapa aspas como \", com valores crus não citados): a planilha abria sem
                         erro mostrando dado na coluna errada. Regra única: todo campo sai citado
  duplicidade.js         detecção de deal duplicado por nome+caso (filtro tipo IDF, containment) —
                         lógica pura extraída de estudar-deals-duplicados.js para o relatório de
                         auditoria usar a MESMA regra calibrada em 24/08, em vez de uma cópia
  cliente-retorno.js     cliente que já foi atendido e volta com caso novo: se a consulta já aconteceu,
                         se o caso descrito é posterior a ela e se o tema mudou (tudo sem rede)
  notas-reuniao.js       notas do Gemini → nota no negócio: parse do assunto, cascata que escolhe o
                         deal, texto da nota (só o link da transcrição), nome do anexo (tudo sem rede)
  chatwoot.js            nome do contato no Chatwoot: se dá para escrever, qual nome, e o payload
                         (classificação do nome atual, cascata de fontes, autoria) — tudo sem rede
  telefone.js            normalização de telefone e detecção de números internos (equipe)
  transcricao.js         transcrição de áudios do cliente via OpenAI (contrato: nunca lança)
  zapsign.js             contrato de prestação de serviço: campos do template, valor por extenso,
                         criação do documento e leitura do webhook de assinatura
docs/pop/                POP oficial do processo de negócio (HTML + PDF) — fonte da verdade
```

### Classificação do deal: como o erro é evitado e como é corrigido

Área do direito / responsável / assunto / origem foram a maior fonte de dado errado no CRM (deal
48423360 entrou como LGPD sendo Direito Administrativo). Seis camadas, todas em `index.js` salvo nota:

1. **Evidência**: `aplicarGateCasoDescrito` só deixa área/advogado/assunto irem ao CRM se houver
   observação validada `cliente_descreveu_caso`/`equipe_descreveu_caso` ([src/evidencia.js](src/evidencia.js)).
   Sem caso descrito o lead nem vira deal (`deveEsperarCasoDescrito`), exceto com dupla confirmação
   de horário ou bloco de condições enviado.
2. **Merge sanitizado**: `mesclarParaCrm` aplica o gate ao objeto **mesclado** com `last_data` — sem
   isso um palpite antigo era ressuscitado e reenviado a cada ciclo.
3. **Regra de negócio em código**: `derivarAdvogadoDaArea` + `MOSKIT_IDS.ADVOGADO_POR_AREA_ID` — a
   área define o responsável, e `montarPayloadMoskit` reaplica isso em **todo** caminho de escrita.
4. **Correspondência exata**: `MOSKIT_IDS.buscarOpcao` (usado por `buscarIdOpcao` e por todos os
   scripts) só aceita chave canônica ou apelido declarado. Valor fora da lista deixa o campo vazio e
   gera nota + Telegram (`detectarOpcoesInvalidas`/`registrarOpcoesInvalidas`), nunca um chute.
5. **Reconciliação**: `reconciliarClassificacao` compara CRM x decisão do bot e corrige o que o
   próprio bot escreveu; roda a cada `RECONCILIACAO_INTERVAL_MS` (padrão 30 min) e sob demanda em
   `GET /auditoria-classificacao` (dry-run; `?aplicar=1`, `?incluir-legado=1`).
6. **Campos obrigatórios na CRIAÇÃO** (`deveEsperarCamposObrigatorios`, 02/09/2026): decisão do
   escritório depois de medir deals nascendo incompletos no CRM. Nenhuma das camadas acima impedia a
   *criação* em si — `criarNegocioMoskit`/`montarPayloadMoskit` nunca validaram nada, um campo vazio
   era simplesmente omitido do payload (`buscarIdOpcao` retorna `null`) e o deal nascia incompleto sem
   erro nenhum. `origem`/`tipo_consulta` em particular não tinham gate nenhum (só `area_direito`/
   `advogado_responsavel`/`assunto` tinham proteção parcial via `deveEsperarCasoDescrito`). Agora, no
   mesmo ponto de decisão de `deveEsperarCasoDescrito` (antes de `buscarOuCriarContato`, para não criar
   contato à toa em todo ciclo que vira `'aguardar'`), a criação também é bloqueada se qualquer um dos
   5 `CAMPOS_OBRIGATORIOS` estiver pendente (`camposPendentes`, calculado sobre os dados **mesclados**
   com o histórico, não os crus da rodada). **Mesmas duas exceções** de `deveEsperarCasoDescrito`:
   dupla confirmação de horário fechada ou bloco de condições enviado — nesses casos o deal ainda nasce
   incompleto de propósito, porque o evento no Google Calendar/Meet e o contrato ZapSign dependem de um
   `dealId` já existir.
   ⚠️ **`origem` na prática nunca aciona o gate**: `mesclarParaCrm` força `origem = 'Nao identificado'`
   sempre que fica vazia depois do merge (proteção anterior, 21/08/2026 — ver "Integrações externas").
   Isso significa que `camposPendentes` nunca vê `origem` vazia neste ponto — o gate novo protege de
   fato os outros 4 campos (`assunto`, `tipo_consulta`, `area_direito`, `advogado_responsavel`); origem
   continua podendo nascer como o fallback genérico "Nao identificado", nunca como campo ausente.
   **Nasce em dry-run** (`BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN`, padrão `true` — só loga
   `🔍 [dry-run] bloquearia...`, sem alterar `acao`): diferente do gate de caso descrito (já validado em
   produção), esta é uma regra nova cujo pior cenário — lead nunca sair de `'aguardar'` por um bug de
   merge/extração — é mais caro que o problema que resolve (deal incompleto, mas ao menos existente e
   rastreável). Setar `BLOQUEIO_CAMPOS_OBRIGATORIOS_DRY_RUN=false` liga o bloqueio de verdade; até lá,
   `grep "\[dry-run\] bloquearia"` no log mede quantos ciclos seriam bloqueados e por quais campos.
   Regressão em `test-pipeline.js` (bloqueio real, flag fixada em `'false'` no topo do arquivo — mesmo
   padrão de `AGENDA_MOSKIT_DRY_RUN`) e em `test-bloqueio-campos-obrigatorios-dry-run.js` (o modo
   padrão, detecta e loga mas cria mesmo assim — arquivo próprio pelo mesmo motivo de
   `test-agenda-dry-run.js`: a flag é lida como `const` no require, os dois valores não cabem no mesmo
   processo).

**Autoria**: `custom_fields_bot`/`campos_travados` guardam o que o bot escreveu (inclusive o nome do
deal, chave `__name`). Valor divergente disso = correção humana → campo travado para sempre, com nota.

**O título congelado no placeholder — corrigido em 02/09/2026, uma linha em `camposPendentes`.**
`assunto` está em `CAMPOS_OBRIGATORIOS` desde o início, e o comentário acima dele sempre disse por
quê: "para que um deal criado sem tema no nome seja cobrado nos ciclos seguintes". **O código
contradizia esse comentário.** `camposPendentes` tratava `assunto = "Consulta jurídica"` como
*preenchido* — mas esse é o **placeholder honesto que o prompt manda usar** quando ninguém descreveu
o caso, não um assunto. Consequência em cadeia: assunto nunca voltava a "pendentes" → o prompt
informava "nenhum campo pendente" → o modelo escolhia a ação `nota` → `nota` não faz `PUT` → **o nome
do deal ficava congelado no placeholder para sempre**, mesmo depois de `last_data` já ter o tema real.
MEDIDO no corpus: deal 48407608 chamado só "Rayra Pureza" com `last_data.assunto = "Abatimento do
FIES"`; o mesmo em 48287898 ("Adoção") e 48206720 ("Rescisão de contrato"). O dado existia e nunca
subia para o título. Agora `ASSUNTO_NEUTRO` conta como pendente (`ehAssuntoNeutro` normaliza acento e
caixa, então o `"consulta juridica"` sem acento que o prompt pede também casa), e a regra é **só do
assunto** — nenhum outro campo obrigatório muda. Efeito deliberado: essas conversas voltam de `nota`
para `atualizar_campos`, ou seja voltam a fazer `PUT`. Isso só é seguro porque a autoria por
`__name` preserva renomeação humana, e é exatamente isso que a regressão em `test-pipeline.js`
("assunto placeholder conta como PENDENTE" + "e o PUT que isso libera continua respeitando
renomeação humana") trava: se ela cair, a linha volta atrás.

**O placeholder do modelo apagava um assunto real herdado — achado em 03/09/2026, `mergeDados`.**
Investigando o [PLANO-CORRECAO-QUALIDADE-DEALS.md](PLANO-CORRECAO-QUALIDADE-DEALS.md) (Fase 2), 4
deals do bot tinham assunto real capturado numa auditoria de 02/09 e voltaram ao placeholder
`"Consulta jurídica"` num pull fresco do `conversations.db` de produção 1 dia depois — sem ninguém ter
corrigido nada na mão. Um dos quatro é **o próprio deal 48407608 (Rayra Pureza)**, citado ACIMA como
o exemplo que motivou a correção do título congelado (`last_data.assunto = "Abatimento do FIES"` em
02/09) — hoje seu `last_data.assunto` está **vazio**. A correção de 02/09 funcionou; um bug diferente
comeu o dado de novo depois.

Causa: `mergeDados(anteriores, novos)` só preserva o valor antigo quando o `novos[key]` é `null`/
`undefined`/`'null'` — mas o modelo **nunca omite** `assunto`, ele preenche com o placeholder neutro
sempre que a rodada não tem caso novo (é a própria instrução do prompt). O placeholder é uma string
não-nula, então `mergeDados` o tratava como dado novo de verdade e sobrescrevia um assunto real de uma
rodada anterior — silenciosamente, porque o único log de "descartado" fica em
`aplicarGateCasoDescrito`, que roda DEPOIS do merge (dentro de `sanitizarClassificacao`, chamada por
`mesclarParaCrm`) e só nula um assunto que NÃO é o placeholder — o placeholder sempre "passava",
inclusive por cima de um valor bom que ele acabara de substituir. **`_casoDescritoValidado` nunca
protegia isso**: ele impede o gate de renular *area_direito*/*advogado_responsavel* validados antes,
mas assunto placeholder nem chega a ser nulado pelo gate — o dano já tinha acontecido um passo antes,
no merge. REPRODUZIDO deterministicamente (sem chamada de IA): `mesclarParaCrm(rodada1, { assunto:
'Consulta jurídica' }, [])` sobre uma `rodada1` com assunto real devolvia o placeholder, apagando o
real. Fix: `mergeDados` agora trata o placeholder como "sem novidade" (mesmo efeito de `null`) só
quando já existe um assunto real herdado — placeholder sobre placeholder, ou assunto real novo sobre
assunto real antigo, continuam funcionando como antes. Regressão em `test-pipeline.js`
("mesclarParaCrm: placeholder do modelo nao apaga assunto real herdado", com os dois controles: sem
assunto anterior o placeholder passa normal, e assunto real novo continua substituindo o antigo).
⚠️ **O fix impede a corrupção dali pra frente — não recupera os deals já afetados.** Só os 4 achados
por acaso (por terem um snapshot de auditoria anterior pra comparar) têm o valor antigo conhecido; não
há como saber quantos outros na base de 106 deals do bot perderam assunto do mesmo jeito sem deixar
rastro.

**Dois buracos estruturais, achados em 21/08/2026 por `diagnosticar-classificacao.js` (script novo,
só leitura — mede 6 causas raiz de origem/área/advogado vazios antes de decidir o que corrigir):**

- **Bug de merge em 4 ramos sem `mesclarParaCrm`.** Os ramos `'ignorar'` (inclusive o downgrade
  automático `acao==='criar' && confianca<6`), `'nota'`/`'atualizar_campos'` sem `deal_id` ainda
  gravado, e o fallback de ação desconhecida persistiam em `last_data` a extração CRUA da rodada
  (`JSON.stringify(dados)`), nunca passando por `mesclarParaCrm` como o ramo `'aguardar'` e
  `finalizarCiclo` já faziam. Uma classificação válida de uma rodada anterior (com
  `_casoDescritoValidado`) era apagada em silêncio sempre que a rodada seguinte não reemitisse a mesma
  evidência — provavelmente a causa mais comum de deal que "estava classificado e ficou vazio".
  Corrigido: os 4 pontos agora persistem `mesclarParaCrm(dadosAnteriores, dados, obsValidas)`.
  Regressão em `test-pipeline.js` (seção "classificacao anterior sobrevive a rodada sem merge").
- **Janela fixa da reconciliação periódica nunca cobria o histórico completo.** `reconciliarClassificacao`
  sempre filtrava por `updated_at` dentro de `RECONCILIACAO_DIAS` (30d) `LIMIT` (100) — um deal parado
  há mais de 30 dias, ou fora do top-100 mais recentes, nunca era revisitado, e a reconciliação é um
  ESPELHO (só compara `last_data` x CRM; se `last_data` nunca teve a classificação, não há nada para
  comparar). Coluna nova `reconciliado_em` + modo `reconciliarClassificacao({ modo: 'antigos' })`
  (ordena por `reconciliado_em`, ignora a janela de dias, grava a hora atual em cada linha processada
  quando `aplicar=true`) — `rodarReconciliacaoPeriodica` alterna `'recentes'`/`'antigos'` a cada
  execução, sem aumentar a taxa de chamadas ao Moskit. Regressão em `test-pipeline.js` ("cursor
  antigos alcanca o que o modo recentes nunca revisita").

Nenhuma das duas correções relaxa a exigência de evidência real (`aplicarGateCasoDescrito` continua
intocado) — só fecham buraco que apagava ou nunca revisitava classificação que já tinha evidência.

### `src/moskit-ids.js` é a fonte única de verdade para IDs do Moskit

Antes esses mapas (origem, área do direito, tipo de consulta, lost reasons, stage IDs...) estavam
duplicados em seis arquivos diferentes e já tinham divergido silenciosamente, causando classificação
errada de deals reais. **Nenhum ID do Moskit deve ser escrito em nenhum outro arquivo** — sempre
importe de `src/moskit-ids.js`. Se uma opção mudar no CRM, o ajuste é só aqui.

### SQLite (better-sqlite3), schema em `index.js`

Tabelas: `conversations` (uma linha por chat/telefone, mensagens em JSON na coluna `messages`),
`moskit_contacts` (cache de contato por telefone), `comprovantes` (recibos de pagamento verificados
por IA de visão), `atividades_sincronizadas` (dedupe de sync de atividades do Moskit → Calendar).

- `conversations.agendamento_apuracao` (JSON) guarda a última decisão de dupla confirmação: as
  observações de horário validadas, as duas pernas escolhidas e o motivo quando não fechou. Existe
  porque essa decisão só vivia num `console.log` — quando o cliente do deal 47543238 esperou sozinho na
  sala e o do 48226006 ficou com a reunião no dia velho, não havia como saber, depois do fato, se a
  perna do cliente não foi emitida pelo modelo ou se foi descartada na validação, e as duas hipóteses
  levam a correções opostas. É o **estado atual**, uma linha por conversa, não histórico.

- `DB_PATH` (env var) sobrepõe o caminho padrão `conversations.db` — **testes sempre devem setar
  isso** para um arquivo inexistente; senão o `require('./index.js')` do teste abre o banco de
  produção e roda `ALTER TABLE`/writes nele.
- Colunas novas são adicionadas via `ALTER TABLE ... ADD COLUMN` dentro de `try {} catch {}` no
  boot — não há migrations versionadas, é tudo idempotente e cumulativo no topo de `index.js`.

### Pipeline de uma mensagem (visão geral, ver POP para o fluxo de negócio completo)

1. `POST /webhook` (Zernio) → `tratarWebhook` → `processarMensagemRecebida`: valida assinatura HMAC,
   filtra números internos (`ehInterno`/`TEAM_PHONES`), grava mensagem no SQLite, agenda
   processamento após inatividade (`agendarProcessamento`, padrão 5 min).
2. Áudio do cliente (incoming): vira placeholder `📎 [cliente enviou um audio]` na hora; depois
   `processarAudioCliente` baixa o anexo (`baixarAnexoAudio`, pasta `comprovantes/<phone>/`),
   transcreve via `src/transcricao.js` (OpenAI, `gpt-4o-mini-transcribe`) e substitui o placeholder
   por `🎧 Transcrição do áudio: ...` (`atualizarTranscricaoNaConversa`). Falha em qualquer etapa
   mantém o placeholder — nunca trava a conversa. Só áudio incoming é transcrito (áudio da equipe
   não). O polling (`sincronizarConversas`) é a rede de segurança: transcria áudios que o webhook
   perdeu.
2. `processarConversaDirect(chatId)`: monta histórico, chama a OpenAI (`classificarConversa` +
   `extrairDadosAtendimento`) para extrair dados estruturados, decide criar/atualizar deal no
   Moskit (`buscarOuCriarContato`, `criarNegocioMoskit`/`atualizarNegocioMoskit`).
   **Gate do caso descrito** (`aplicarGateCasoDescrito`/`deveEsperarCasoDescrito`): `area_direito`,
   `advogado_responsavel` e `assunto` só vão pro CRM se houver observação validada
   `cliente_descreveu_caso`/`equipe_descreveu_caso`; sem ela o lead nem vira deal (exceto se já
   houver dupla confirmação de horário ou bloco de condições enviado). Sem esse gate a IA deduzia a
   área do sócio que o lead mencionou — "consulta com o Dr. Berto" virava LGPD.
3. Agendamento: `apurarDuplaConfirmacao` (cliente E equipe confirmam o mesmo horário) →
   `handleAgendamentoCalendar` → `criarEventoGoogleCalendar` (OAuth2, precisa de conta Google real
   do escritório — service account não gera link de Meet nem convida participantes) e
   `registrarConsultaNaAgendaMoskit` → `criarAtividadeMoskit` (ver "As duas agendas" abaixo).
4. Progressão de funil (`moverEstagioSeAvancar`) e fechamento (`fecharNegocioSeAplicavel`) são
   guardados por flags `FUNIL_DRY_RUN`/`FUNIL_FECHAMENTO_DRY_RUN` — comece sempre com dry-run
   ligado (padrão) até validar as sugestões da IA na prática.
5. Se qualquer etapa falhar, a conversa cai na fila (`src/fila.js`) e é reprocessada pelo
   `worker.js`, que é lançado como processo filho do próprio `index.js`.

### As duas agendas: Google Agenda e agenda do Moskit

Toda consulta agendada existe em **dois** lugares, e os dois caminhos se cruzam — é aqui que nasce o
risco de evento duplicado.

- **Bot → as duas agendas.** Fechada a dupla confirmação, `handleAgendamentoCalendar` cria o evento
  no Google (`criarEventoGoogleCalendar`) e a Atividade no Moskit
  (`registrarConsultaNaAgendaMoskit` → `criarAtividadeMoskit`), guardando o id em
  `conversations.atividade_moskit_id`. Remarcação move as duas (`atualizarEventoSeRemarcado` +
  `atualizarAtividadeMoskit`).
- **Moskit → Google.** `sincronizarAtividadesMoskit` (a cada `SYNC_INTERVAL_MS`) cria evento no
  Google para atividades marcadas direto no CRM ou pelo Moskit Boost, que nunca passaram por
  conversa nenhuma.
- **A trava.** Logo após criar a Atividade, o bot grava a linha em `atividades_sincronizadas`
  apontando para o evento que ele mesmo acabou de criar. Sem isso, a sincronização acima veria a
  atividade nova como "ainda não sincronizada" e criaria um **segundo** evento no Google para a mesma
  consulta minutos depois. Se mexer nesse trecho, `test-pipeline.js` tem a regressão.
- **`PUT /activities/{id}` exige o corpo do `GET`.** Medido em 12/08/2026 contra a API real: um
  payload mínimo `{dueDate}` volta **422** — mesma peculiaridade do `PUT` de deal. `POST /activities`,
  ao contrário, aceita o payload construído normalmente. Sem o `GET` prévio em
  `atualizarAtividadeMoskit`, nenhuma remarcação chegaria à agenda do CRM.
- **Fuso.** O pipeline inteiro usa horário *naive* (`"2026-08-05T17:30:00"`), que significa sempre
  hora local do escritório. O Google aceita isso com `timeZone` ao lado; o Moskit **não** — `dueDate`
  é instante absoluto. A conversão é `horarioNaiveParaInstante` (`src/atividade-moskit.js`), que
  pergunta o offset ao `Intl` em vez de fixar `-03:00`. Errar aqui não quebra nada: só põe a consulta
  três horas fora do lugar na agenda, em silêncio.
- **O eco da data-âncora, e por que o horário é validado em código.** O maior defeito de horário
  medido em produção (13/08/2026) não era fuso: era o modelo **copiar a data-âncora**. O prompt
  entregava `- Data/hora da ultima mensagem desta conversa: 2026-08-10T18:54:58.000Z`, e quando o
  modelo não conseguia derivar o horário da conversa, devolvia essa string como horário da consulta.
  De 32 conversas com horário registrado, 5 (16%) gravaram o timestamp de uma mensagem, e 3 viraram
  reunião real na agenda (deals 48370184, 48407621, 48177138 — uma delas às 15:54:58). Duas defesas:
  `descreverAncora` (`index.js`) manda a âncora em **texto do escritório** (`"10/08/2026
  (segunda-feira), 15:54"`), que não se parece com o formato de saída, e `motivoHorarioImplausivel`
  (`src/evidencia.js`) recusa em código todo horário com `Z`/offset/milissegundos, com segundos ≠ `00`,
  igual ao horário de envio da última mensagem, fora da janela `HORA_MIN_ATENDIMENTO`–
  `HORA_MAX_ATENDIMENTO`, ou mais de 7 dias antes da âncora. O motivo é **nomeado** porque vai pra nota
  no deal e pro Telegram. Regressões em `test-evidencia.js`.
  **A checagem do eco roda no valor CRU, antes de `corrigirDataRelativa`** (`ehEcoDaAncora`): a correção
  de dia relativo reescreve a data e faria um timestamp copiado deixar de parecer com a âncora. Medido
  no replay do deal 47543238, onde o modelo devolveu `17:11:00` (a hora de envio da última mensagem) nas
  três observações e uma delas escapava por citar "amanhã". Eco não se corrige, se descarta. E o
  *relógio* da âncora em qualquer dia já conta como eco: consulta cair exatamente no minuto da última
  mensagem é 1 em 1440, o eco produz isso sempre.
- **Propagação de dia corrigido não anda pra trás.** `validarObservacoes` propaga a correção de dia
  para observações que citam o mesmo horário bruto sem repetir "amanhã" (a confirmação "Perfeito, está
  agendado!"). Só que **"mesmo valor bruto = mesmo compromisso" não vale quando o valor bruto é lixo** —
  aí todas as observações têm o mesmo valor e o sinal não quer dizer nada. No deal 47543238 a
  confirmação da equipe de **03/08** (o aceite da remarcação) herdava o 29/07 corrigido de uma proposta
  de 28/07; a apuração fechava no horário **antigo**, igual ao que já estava no Google, então a
  remarcação para 04/08 nunca acontecia — e o cliente esperou sozinho na sala. Agora a propagação é
  recusada quando colocaria a consulta antes do dia da mensagem que a afirma, e o caso vira pendência
  com aviso. Os dois lados têm regressão em `test-evidencia.js` (o bloqueio e a propagação legítima do
  deal 48346871).
- **Nenhuma falha de agendamento em silêncio.** Se a dupla confirmação aconteceu e o evento não
  existe, isso **sempre** vira nota no deal + Telegram (`registrarErroAgendamento`). Antes,
  `criarEventoGoogleCalendar` devolvia `null` e o chamador fazia `if (!evento) return`: o horário
  inválido era descartado e ninguém no escritório sabia que a consulta combinada não tinha ido pra
  agenda — o sintoma deixou de ser "reunião no horário errado" e passou a ser "reunião que ninguém
  marcou e ninguém soube", repetindo a cada 5 min só no console. Por isso a função **lança** em vez de
  devolver `null`. `registrarAgendamentoPendente` também avisa no Telegram, mas só no que é acionável
  (remarcação travada ou horário recusado pela validação) — pendência de rotina viraria ruído diário.
- **Dia relativo.** `corrigirDataRelativa` (`src/evidencia.js`) confere em código o dia que o modelo
  resolveu, contra o timestamp da **própria mensagem** citada: `hoje`/`amanhã`/`depois de amanhã` e
  também dia da semana pelo nome (`"na sexta"`, `"quarta-feira"`). No dia da semana a correção é
  conservadora de propósito: se o dia que o modelo escolheu já cai no dia da semana citado, a **semana**
  dele é respeitada ("sexta" e "sexta que vem" são as duas sextas, e a conversa pode ter dito qual com
  palavras que o código não lê). Cuidado ao mexer: em português o nome do dia também é ordinal, e
  `"segunda via"` já foi lido como segunda-feira (tem teste).
- **Atividade criada sem vínculo com o negócio.** MEDIDO em 14/08/2026 nos deals 48474073 e 48464876:
  o `POST /activities` com `deals: [{id: dealId}]` volta 2xx com `id` (passa como sucesso em
  `criarAtividadeMoskit`), mas quando o negócio tinha acabado de ser criado/escrito quase ao MESMO
  tempo (segundos a poucas horas antes), o Moskit às vezes não persiste esse vínculo — a atividade
  fica só ligada ao contato, some da tela do negócio, e o aviso "nenhuma atividade agendada" aparece
  mesmo com a consulta marcada.   `garantirVinculoAtividadeDeal` (`index.js`) confere logo após criar
  (GET + PUT com `deals` corrigido, mesmo padrão de `atualizarAtividadeMoskit`) e
  `reconciliarVinculoAtividades`/`rodarReconciliacaoVinculoAtividades` rodam na mesma cadência de
  `RECONCILIACAO_INTERVAL_MS` como rede de segurança para o que escapar da conferência imediata.
  **A reconciliação desiste — e avisa uma única vez.** MEDIDO 14-17/08/2026 em 6 negócios
  (48287898, 48292471, 48441223, 48447661, 48464876, 48474073): o Moskit responde 429/timeout de 30s
  quando a varredura bate forte, e a rotina antiga retentava a cada 30 min SEM religar nada, inundando
  o Telegram com o mesmo aviso (o dedup por string do resumo não segurava porque o subconjunto de
  falhas mudava a cada rodada). Agora cada linha tem estado próprio em `conversations`
  (`vinculo_falhas`, `vinculo_backoff_ate`, `vinculo_desistiu`, `vinculo_aviso_hash`): falha entra em
  cooldown exponencial (o dobro de ciclos a cada tentativa, sem chamar rede durante ele) e é
  **silenciosa** — 429/timeout não é "conferir na mão", é o Moskit dizendo calma; ao estourar
  `VINCULO_MAX_TENTATIVAS` (padrão 3) a linha desiste (estado terminal, nunca mais retenta sozinha) e
  recebe UM aviso final no Telegram com o comando exato. O aviso é deduplicado por
  `vinculo_aviso_hash` (por linha, não por resumo), e o estado terminal só é desfeito por
  `religar-atividade.js`. As três reconciliações também são escalonadas no boot (0/5/10 min) para não
  triplicar o burst de GETs no mesmo instante. Regressões em `test-pipeline.js`.
- **Remarcação tem que mover a Atividade também, mesmo quando ela acabou de nascer no mesmo ciclo.**
  `handleAgendamentoCalendar` recebe `row` como um snapshot lido ANTES do ciclo. Quando o ramo "evento
  já existia" roda a auto-cura (cria a Atividade que faltava) e, na MESMA rodada, a dupla confirmação
  também remarca o horário, `atualizarEventoSeRemarcado` — chamado logo em seguida com o mesmo `row`
  — não enxergava o `atividade_moskit_id` que acabou de ser gravado no banco (o objeto em memória
  continuava com o valor antigo, nulo), então nunca movia o `dueDate` da Atividade recém-criada: ela
  ficava presa no horário velho enquanto o Google Agenda já ia para o novo. Por isso, logo após a
  auto-cura criar a Atividade, o código relê `atividade_moskit_id` do banco e atualiza o `row` em
  memória antes de chamar `atualizarEventoSeRemarcado`. Regressão em `test-pipeline.js` (o cenário
  que cria E remarca no mesmo ciclo).
- **Auditoria.** `GET /auditoria-agenda` (só leitura, atrás de `exigeAdmin`) cruza as três fontes de
  horário de cada consulta — `conversations.evento_calendar_data`, o evento no Google e a Atividade no
  Moskit — e lista divergências, incluindo esse caso de atividade sem vínculo com o negócio e a
  divergência de perna validada x banco (bullet abaixo). `?todas=1` inclui consulta passada. Separa
  `problemas` (a consulta pode estar no horário errado agora, ou a atividade não aparece pro negócio)
  de `observacoes` (contexto): um alerta que dispara em toda linha afoga justamente os casos que
  importam.
- **Remarcação perdida quando a equipe propõe horário 2x em sequência, e por que o aviso agora escala
  por PROXIMIDADE em vez de só por conteúdo.** MEDIDO em 14/08/2026 nos deals 48292471 (Lia) e 48287898
  (Solange): a equipe propôs um horário novo (a Lia, inclusive duas vezes em sequência rápida, com uma
  mensagem `[edit]` do WhatsApp entre as duas) e o cliente aceitou claramente — mas o modelo não gerou
  NENHUMA observação (`equipe_propos_horario`/`cliente_aceitou_horario`) para essas mensagens na
  rodada que rodou de verdade; só enxergou a confirmação antiga. `validarObservacoes`/
  `apurarDuplaConfirmacao` processaram corretamente o que receberam — o problema é que receberam menos
  do que deviam (falha de extração do modelo, não bug de validação). A dupla confirmação corretamente
  registrou a pendência (`motivo: falta_cliente`) e `registrarAgendamentoPendente` já manda Telegram
  incondicional quando `remarcacao=true` — mas o dedup por hash (que só olha `horario relatado|motivo`)
  não tinha como saber que a urgência estava crescendo: a reunião ficou horas presa no horário velho,
  perto da hora do cliente aparecer, sem nenhum aviso NOVO. `registrarAgendamentoPendente` agora recebe
  `row` e reforça em duas frentes: (1) **escalada por proximidade** — reenvia o Telegram mesmo com hash
  igual quando `evento_calendar_data` está dentro de `AGENDAMENTO_URGENCIA_HORAS` (padrão 48h), a
  garantia que não depende do modelo acertar nada; (2) **enriquecimento por conteúdo** — quando a perna
  validada (`apuracao.equipe/cliente.horario_iso`) diverge do que já está na agenda (padrão Solange,
  cuja equipe confirmou "18/08" com trecho limpo mas o banco seguia em "16/08"), cita os dois horários
  explicitamente e entra no hash de dedup. Camada extra (defesa teórica, não confirmada em incidente
  real): `handleAgendamentoCalendar` monta `dadosEvento` substituindo `data_hora_consulta` por
  `apuracao.horarioIso` quando a confirmação fecha — se ela fechar com um par velho mas autoconsistente
  (já igual ao banco), isso registra a divergência entre o que o modelo entendeu e o que a apuração
  manteve (`agendamento_divergencia_hash`), mesmo sem Telegram (não é incidente confirmado). Regressão
  em `test-pipeline.js` (proximidade, divergência de conteúdo e o dedup normal quando nenhum dos dois
  se aplica).
- **A escalada por proximidade só roda se a conversa for reprocessada — conversa muda nunca é.**
  MEDIDO em 14/08/2026 no deal 48466404 (Teresinha): ela propôs um dia AMBÍGUO ("quarta ou quinta,
  15:30?"), deixou a escolha pra equipe, a equipe escolheu 19/08 e avisou, ela **pagou** e até pediu o
  endereço do escritório — claramente acha que está confirmado. Mas a dupla confirmação nunca fechou
  (ela nunca reafirmou a data específica escolhida — aqui a ambiguidade é real, diferente do bullet
  acima) e a conversa parou de receber mensagem no dia seguinte. A escalada por proximidade de
  `registrarAgendamentoPendente` **só roda dentro de um ciclo de `handleAgendamentoCalendar`**, chamado
  só quando a conversa é reprocessada — e nada neste código reprocessa uma conversa só porque o tempo
  passou (só mensagem nova via webhook, ou `sincronizarConversas` achando `updatedTime` mais recente no
  Zernio). Uma varredura achou **17 negócios** com `agendamento_pendente_hash` gravado, vários parados
  há mais de uma semana. `reconciliarPendenciasAgendamento` (mesmo padrão de `reconciliarClassificacao`,
  `RECONCILIACAO_INTERVAL_MS`) é a rede de segurança: relê `agendamento_pendente_hash` direto do banco
  (formato `horario|motivo|...` desde a criação da função — não depende de `agendamento_apuracao`, que
  fica `NULL` em conversa que nunca rodou um ciclo completo desde que essa coluna existe), com janela
  própria e maior (`AGENDAMENTO_PENDENCIA_SILENCIOSA_DIAS`, padrão 7 dias — a única chance de avisar
  sobre conversa muda, então precisa de mais antecedência que a escalada de conversa ativa). Comprovante
  já verificado (`comprovantes.match=1`) pro deal escala **incondicionalmente**, mesmo com horário fora
  da janela — é sinal de compromisso real, não hipótese. NÃO chama a OpenAI. Dedup por linha, coluna
  nova `agendamento_pendencia_avisada` (guarda o hash já avisado, separada de
  `agendamento_pendente_hash`/`agendamento_erro_hash`, que têm ciclo de vida diferente).
- **Responsável.** A atividade sai no nome da Layla (`LAYLA_USER_ID`), como todo contato, deal e nota
  criados pelo bot. Não confundir com `advogado_responsavel`, que é campo personalizado do deal.
- **Botão de emergência.** `AGENDA_MOSKIT_DRY_RUN=true` desliga a escrita na agenda do CRM sem
  redeploy (o evento no Google continua sendo criado; o deal recebe uma nota `[dry-run]`). O padrão é
  o **inverso** de `FUNIL_DRY_RUN`: sem a variável, a agenda funciona. Aquelas flags seguram palpite
  de IA sobre funil; esta guarda uma regra determinística, então nasce ligada.

### Notas no Moskit: só pendência vira nota, sucesso de rotina não

**Decisão de 02/09/2026.** O escritório reclamou do volume de notas no histórico de cada negócio.
Mapeados os 43 pontos do código que chamavam `criarNotaMoskit` (fora do Briefing e das notas de
reunião, cada um com seção própria), a resposta dividiu as notas em duas famílias e cortou uma delas:

- **Família A (fica)** — aviso de PROBLEMA ou PENDÊNCIA que exige ação humana: campo travado por
  correção manual, valor da IA fora da lista do CRM, falha ao criar/remarcar Atividade no Moskit,
  sugestão em modo dry-run (`FUNIL_DRY_RUN`/`FUNIL_FECHAMENTO_DRY_RUN`/`AGENDA_MOSKIT_DRY_RUN`/
  `REUNIAO_RETORNO_DRY_RUN`), pagamento confirmado SEM comprovante verificado, comprovante que não
  confere, contrato não gerado por falta de dado, falha real na API do ZapSign, pendência ou erro de
  agendamento, divergência entre o que a dupla confirmação apurou e o que a IA entendeu, aviso de
  cliente de retorno em caso ambíguo, recusa/falha de assinatura do contrato. Praticamente todas já
  disparavam Telegram no mesmo fluxo — a nota aqui é o registro que fica quando alguém abre aquele
  negócio específico depois, não a única forma de alerta.
- **Família B (saiu)** — confirmação de que uma ação **deu certo**, sem exigir nada de ninguém: deal
  movido de estágio, negócio fechado como GANHO/PERDIDO, pagamento confirmado com comprovante
  verificado, reunião agendada/remarcada com sucesso, atividade criada tardiamente pela auto-cura,
  contrato enviado/assinado, cliente de retorno detectado (nos dois call sites: no negócio antigo e
  no novo), campos preenchidos/atualizados, link do Meet adicionado, atividade religada ao negócio,
  classificação reconciliada. Em cada um desses ~18 pontos a **ação em si continua acontecendo** —
  só a linha `criarNotaMoskit(...)` foi removida; onde já existia Telegram, ele continua igual.

Duas exceções deliberadas dentro da família B, mantidas em A por decisão do usuário: pagamento
confirmado **sem** comprovante (sinal fraco, vale registrar) e os avisos de dry-run (que pedem
revisão manual explícita, mesmo sem ainda ter havido um "erro"). O Briefing pré-consulta e a nota de
reunião do Gemini (link da transcrição) ficaram de fora dessa varredura de propósito — são as duas
notas que o usuário pediu para manter, cada uma com sua própria seção abaixo.

**Decisão de 03/09/2026 — a Família A INTEIRA saiu do Moskit também.** O pedido seguinte do usuário
foi direto: "quero que os problemas só vá para o telegram". Os 19 pontos listados acima como Família A
deixaram de chamar `criarNotaMoskit` — **só Briefing e nota de reunião ainda postam no deal.** Em 9
desses pontos já existia um `enviarTelegram` cobrindo o mesmo evento (às vezes com o mesmo hash de
dedup da nota, às vezes incondicional): a nota simplesmente saiu, o Telegram continua igual. Nos outros
10, o Telegram teve que ser criado ou ajustado:
- **8 pontos sem Telegram nenhum** ganharam um `enviarTelegram` novo, equivalente ao texto da nota
  removida: campo travado por correção manual (`atualizarNegocioMoskit`), falha ao remarcar Atividade
  no Moskit nos 4 branches (`atualizarAtividadeMoskit`), pagamento sem comprovante e comprovante que
  não confere (`handlePagamentoConfirmado`), atividade não lançada por `AGENDA_MOSKIT_DRY_RUN`
  (`registrarConsultaNaAgendaMoskit`), recusa de assinatura e falha de e-mail do ZapSign
  (`processarWebhookZapSign`). Nenhum ganhou hash de dedup novo — mesma frequência que a nota tinha
  antes, só o canal mudou (a maioria é evento único, não polling repetido; a exceção é a sugestão de
  `FUNIL_DRY_RUN`, que repetiria a cada ciclo — aceitável porque `FUNIL_DRY_RUN=false` está ligado em
  produção e esse caminho fica inerte hoje).
- **2 casos eram deliberadamente silenciosos no Telegram** para não virar "ruído diário": a divergência
  entre o horário que a dupla confirmação fechou e o que a IA entendeu (`handleAgendamentoCalendar`,
  `agendamento_divergencia_hash`) e a pendência de agendamento de ROTINA — falta só a confirmação de um
  lado, sem remarcação/descarte/urgência (`registrarAgendamentoPendente`, a condição do Telegram em
  `if (hashMudou || urgente)`, antes restrita a `remarcacao || descartados.length`). Confirmado
  explicitamente com o usuário: agora os dois avisam no Telegram também, usando o MESMO hash que já
  gatava a nota — sem isso, remover a nota apagaria esses dois eventos de qualquer lugar visível.
- **Caso especial**: a nota híbrida de `handleAgendamentoCalendar` ("consulta marcada no Moskit mas
  Google falhou") foi apagada sem substituto próprio — `registrarErroAgendamento` (chamada logo depois,
  já tinha Telegram com `agendamento_erro_hash`) ganhou um parâmetro `naAgendaMoskit` para carregar essa
  nuance no texto, em vez de duplicar aviso.

`avisarRetornoUmaVez` perdeu o parâmetro `nota` (não é mais chamado por nenhum dos dois call sites,
`abrirNovoAtendimento` e o ramo `ambiguo` de `processarConversaDirect`) — só `telegrama` continua.
Regressões atualizadas em `test-pipeline.js`, `test-agenda-dry-run.js`, `test-reuniao-retorno-flags.js`
e `test-cliente-retorno-flags.js` (assertos de `notas()` trocados por `telegrams()` nos 19 pontos).

### Briefing pré-consulta: a nota "📋 Briefing · vN · data" no deal

O advogado abre o negócio no CRM minutos antes da consulta. Se a conversa parou no dia anterior, a
nota que ele lê não pode ser a da hora em que o cliente sumiu. `registrarBriefing` (`index.js`) posta
uma nota no deal com o estado atual da conversa, e o bot reprocessa de propósito antes do horário.

- **Trilha de notas nativa, não edição in place.** Cada mudança real posta uma nota NOVA com título
  versionado `📋 Briefing · v{n} · {dd/mm/aaaa hh:mm}` (data no fuso `TZ_ESCRITORIO`). A remarcação
  conta como mudança real. O histórico do Moskit é o histórico do briefing — não existe "última nota
  viva".
- **Texto composto em duas camadas** ([src/briefing.js](src/briefing.js), módulo puro sem rede):
  o **cabeçalho** é determinístico, montado em código (cliente, telefone, horário da consulta —
  esvazia o campo se não houver); a **narrativa** é o `resumo_atendimento` que a IA produz. A saída
  muda de formato sem depender de o modelo "aprender" o novo cabeçalho.
- **As 6 seções são VOCABULÁRIO, não teto** (`Caso` / `Objetivo` / `Urgencia·prazo` / `Ja tentou` /
  `Pendencias` / `Documentos citados`). Cada uma pode ocupar mais de uma linha quando o caso tem mais
  a dizer, e **seção sem informação é omitida por completo** — nada de "Nao mencionado". Era o
  contrário até 02/09/2026: o prompt mandava "estruture em 6 linhas" e mandava escrever o literal,
  e o **exemplo** do próprio prompt o escrevia três vezes (exemplo few-shot ensina mais que
  instrução — trocar a regra sem trocar o exemplo não teria mudado nada). Medido nos 74 resumos que a
  produção gravou: **105 literais, 1,46 por resumo de 6 linhas**, mediana de 330 chars. Depois:
  **0,07 por resumo**, mediana **472**. A regra copiada é a nº 4 do prompt de notas
  (`src/notas-reuniao.js`), que já resolvia isso no outro lado do sistema.
- **Hash sobre o texto final** (cabeçalho + narrativa, fora título/versão/data): valor novo,
  narrativa nova ou mudança de horário repostam; só a data do título passando para a frente não.
- **Aguardar mudança não basta.** O refresh da conversa depende de mensagem nova, e consulta marcada
  não gera mensagem. `refrescarBriefingsPertoDaConsulta` roda no intervalo de
  `RECONCILIACAO_INTERVAL_MS` (escalonado 15 min no boot) e reprocessa as conversas com consulta
  marcada nas próximas `BRIEFING_REFRESH_ANTECEDENCIA_HORAS` horas (padrão 4) — janela conservadora
  porque cada reprocessamento custa ~2 chamadas OpenAI. Dedup por linha com coluna
  `briefing_refresh_para` (o horário para o qual já refrescou): remarcação volta a processar. Teto de
  `BRIEFING_REFRESH_MAX_POR_CICLO` (padrão 5). `BRIEFING_REFRESH_ATIVO=false` desliga sem redeploy.
- **Migração.** Linhas com `briefing_added=1` e sem `briefing_hash` adotam o hash sem repostar (a
  nota já existe); linhas com hash do formato antigo (de 4 linhas) repostam naturalmente no próximo
  reprocessamento — virada de formato sem script de backfill.
- **Pendência é DITA, não é motivo para não postar** (`BRIEFING_SEM_PENDENTES`, padrão ligado).
  Quando falta campo obrigatório, o cabeçalho ganha uma última linha
  `⚠️ Ainda não confirmado: área do direito, advogado responsável` (rótulo legível, o mapa está em
  `src/briefing.js`), e a nota vai. **Isto consertou um beco sem saída que nascia de duas regras
  certas sozinhas:** `aplicarGateCasoDescrito` anula `area_direito` e `advogado_responsavel` de
  propósito quando ninguém descreveu o caso (`index.js:1301-1302`, decisão de 12/08/2026 — melhor
  vazio que adivinhado), os dois estão em `CAMPOS_OBRIGATORIOS`, e este ramo só chamava
  `registrarBriefing` com `pendentes.length === 0` — enquanto o ramo `criar` chamava sempre
  (`index.js:4209`). Conversa com deal e sem caso descrito **não podia receber briefing nenhum, por
  construção**: resumo pedido à OpenAI, pago, escrito e descartado sem uma linha de log. Medido em
  02/09/2026 (`node avaliar-extracao.js`, 277 conversas): **19 barradas, 14 com resumo pronto**, e em
  todas as 14 quem segurou foram exatamente esses dois campos. Depois do conserto: **0 barradas, 18
  postando com a lacuna anotada**. O gate do caso descrito ficou intacto de propósito — é ele que
  protege o CRM de palpite. `BRIEFING_SEM_PENDENTES=false` volta ao comportamento antigo sem
  redeploy, e o espelho do `avaliar-extracao.js` segue a mesma flag (é assim que a medição
  antes/depois continua possível).
- ⚠️ **O resumo anterior NÃO vai no prompt, e essa é a diferença entre melhorar o prompt e não
  melhorar nada.** A regra "atualize APENAS o que identificou agora" fazia o modelo **copiar o
  `resumo_atendimento` da rodada passada palavra por palavra**, e com ele o formato antigo inteiro.
  Medido em 02/09/2026 nas MESMAS 40 conversas, com o prompt novo em vigor nas duas rodadas: com o
  resumo anterior no prompt, **1,62** literal "não mencionado" por resumo e mediana **300** chars;
  sem ele, **0** literais e mediana **466**. Enquanto o texto velho viajava junto, toda melhoria era
  invisível para conversa que já tinha `last_data` — que é justamente o caso do
  `refrescarBriefingsPertoDaConsulta`, o briefing que o advogado lê minutos antes da consulta. Hoje
  `extrairDadosAtendimento` remove só essa chave do JSON que vai ao prompt (os outros campos
  continuam indo, e `mergeDados` segue preservando o resumo antigo se o modelo devolver `null`).
- **`processar_pendentes.js` reposta no mesmo formato** (mesmo `src/briefing.js`), para a nota
  religada nunca sair com cara diferente da rotina.
- Regressões em `test-briefing.js` (módulo puro) e `test-pipeline.js` (call sites, versão, migração,
  refresh perto da consulta).

### Notas de reunião do Gemini → nota no negócio

O que acontece **dentro** da consulta não voltava para o CRM. `sincronizarNotasReuniao` (`index.js`,
a cada `NOTAS_SYNC_INTERVAL_MS`, padrão 10 min) lê os e-mails de notas do Gemini, descobre a que
negócio pertencem e escreve uma nota no deal com o **link** da transcrição. A decisão fica em
[src/notas-reuniao.js](src/notas-reuniao.js) (puro, sem rede); o `index.js` só busca o que ela pede.

**Decisão de 02/09/2026 — a nota deixou de ser uma extração por IA em 5 seções e virou só o link.**
Até aqui a nota era o "BRIEFING DE ATENDIMENTO E ALINHAMENTO ESTRATÉGICO": um prompt convertia o
corpo do e-mail + a transcrição do Doc em 10 campos (perfil do cliente, objeto, estratégia jurídica,
honorários, contexto pessoal), com um filtro de ancoragem numérica sobre a saída do modelo. O
escritório pediu para reduzir o volume de notas no deal, e a instrução final foi específica: só o
link do resumo/transcrição da reunião (a extração por IA sai do fluxo inteiramente), mais o resumo do
atendimento comercial por WhatsApp que o Briefing pré-consulta já cobre (ver seção própria, sem
mudança nenhuma). Achado que reforçou a decisão: em produção `NOTAS_REUNIAO_DRY_RUN=true`, então
aquela extração rodava — e **pagava** OpenAI/Gemini a cada ciclo — sem nunca chegar a escrever a
nota de verdade no CRM; a simplificação também elimina esse custo. `montarTextoNota` agora é só:
título (com o número da reunião, quando identificado, e a data), `📎 Transcrição completa anexada na
aba Arquivos deste negócio` (só quando o anexo em PDF — inalterado, ver seção seguinte — já foi
confirmado no CRM), `Fonte: {link do Google Doc}` e `Vínculo: {método} (confiança X)` para auditoria.
Removidos de `src/notas-reuniao.js`: `CAMPOS`, `PROMPT_SISTEMA_NOTAS`, `montarMensagensExtracao`,
`validarExtracao`/`conferirAncoragem` (o filtro de ancoragem numérica) e `ehExtracaoAtual`; de
`index.js`: `extrairComIaDeNotas` (a escolha OpenAI/Gemini com fallback), `geminiChat` e o arquivo
`src/gemini.js` inteiro (tradução de mensagens pro formato Gemini — sem consumidor depois da
extração sair). **Reunião sem transcrição não gera nota nenhuma**: sem `docId` (nenhum Doc
referenciado no evento nem no e-mail), ou com `docId` presente mas o Drive confirmando que o Doc não
existe/não está acessível (`anexarDocNoDeal` devolvendo `motivo: 'export_falhou'` — veredito
permanente, não uma falha transitória que a retomada ainda vai tentar), a linha vai para o estado
terminal novo `SEM_TRANSCRICAO` sem escrever nada no deal — postar um link morto não é "útil". O
resto da máquina de estados (cascata de identificação, dedup por marcador, retomada de `POSTANDO`,
Doc duplicado, `registrarFalhaNota`/`NOTAS_MAX_TENTATIVAS`, `conferirSilencioNotas`) é a mesma
infraestrutura de idempotência de antes — só o que vira texto da nota mudou.

- **O e-mail é o gatilho; o evento da agenda é o enriquecimento.** Assunto real:
  `Notas: "Consulta — Lia 🇧🇷💛💚 (Berto)" de 14/08/2026`, de `gemini-notes@google.com`. O evento
  correspondente traz o Doc das notas em `attachments[].fileUrl` (campo estruturado, sem parsear
  HTML) e o telefone em `description` (`Telefone: 558681876734`), que é a chave de
  `conversations.chat_id` → `deal_id`. Desde que o número do negócio passou a viajar no título (ver
  abaixo), o evento deixou de ser indispensável para *identificar* — continua sendo o que traz o Doc.
  **Não confundir com `meetings-noreply@google.com`**, que manda
  `Problema com as notas: ...` quando o Gemini FALHA — esse e-mail não tem nota nenhuma dentro e
  viraria uma nota vazia no negócio do cliente.
- **Candidato único ou órfão, sem exceção.** Duas consultas às 15h com advogados diferentes fariam a
  nota do caso de um cliente cair no negócio de outro — dentro do CRM isso é vazamento de sigilo, e
  ninguém detecta lendo, porque a nota parece plausível no negócio errado. Quando um passo devolve
  DOIS candidatos a cascata **para ali** em vez de tentar o passo seguinte: dois resultados não
  significam "sinal fraco, tente outro", significam "este sinal aponta para dois negócios reais".
  O método usado vai **impresso no rodapé da nota** (`Vínculo: evento_telefone (confiança alta)`) —
  é o que permite descobrir qual regra corrigir quando uma nota aparecer no lugar errado.
- **O fallback não é caso raro.** MEDIDO em 16/08/2026 (`sondar-notas.js`): dos 6 eventos que geraram
  notas nos últimos 30 dias, 4 tinham `Telefone:` (criados pelo bot) e 2 não (`"Consulta online -
  Berto e Aurinete"`, `"Consulta online- Iury e Arthur"`, criados na mão). ~1/3 do volume depende do
  fallback e parte vai terminar em órfão mesmo — por isso o órfão é desfecho de primeira classe, com
  Telegram, diagnóstico do que a cascata viu e o comando `reprocessar-nota-reuniao.js` pronto.
- **Dois marcadores no evento, e o do TÍTULO é o que vale mais.** `montarResumoEvento` põe
  `· #48292471` no fim do título e `montarDescricaoEvento` põe `[deal:48292471]` na descrição. O do
  título é o mais valioso porque **o assunto do e-mail do Gemini reproduz o título entre aspas**
  (`Notas: "Consulta — Lia (Berto) · #48292471" de 14/08/2026`) — ou seja, o número chega dentro do
  próprio assunto e o bot identifica o negócio **sem precisar achar o evento na agenda**. Isso tira o
  Google Calendar do caminho crítico: evento apagado, renomeado, movido de calendário ou fora da
  janela de busca deixa de derrubar a identificação. Também é o único marcador que uma reunião criada
  na mão tende a ganhar, porque o título é onde as pessoas digitam.
- **O número é SUFIXO, nunca prefixo.** A rota que adiciona link do Meet reconhece consulta na agenda
  com `/^Consulta\s*—/.test(ev.summary)` — casamento por **início**. Com o número na frente ela
  simplesmente pararia de enxergar qualquer consulta, sem erro nenhum. Regressão explícita em
  `test-pipeline.js`.
- **`dealId` sempre por parâmetro, nos três call sites.** `sincronizarMetadadosEvento` **compara** o
  título e a descrição que monta com os que estão no Google para decidir se dá `patch`. Derivar o
  `dealId` de fontes diferentes na criação e na comparação faria toda rodada ver "mudou" e repatchar o
  evento para sempre. Ler do banco seria exatamente esse caso: `stmtFinalizarCiclo` só grava
  `conversations.deal_id` DEPOIS de `handleAgendamentoCalendar`, então na criação de um deal novo o
  banco ainda traz `null`. O terceiro call site é o título da Atividade do Moskit
  (`registrarConsultaNaAgendaMoskit`), e não é opcional: `test-pipeline.js` já afirma que ele é igual
  ao `summary` do evento — é o mesmo compromisso nas duas agendas.
- **Marcadores explícitos que discordam = órfão, com motivo próprio.** Se o título disser `#48111111`
  e a descrição `[deal:48222222]`, `decidirDeal` para antes da cascata e devolve
  `marcadores_divergentes`. Não há desempate honesto: é evento copiado de outro cliente com só um dos
  dois atualizado, e escolher qualquer um poria a nota do caso de um cliente no negócio de outro. O
  motivo é separado da ambiguidade comum porque o conserto é diferente — aqui alguém precisa arrumar o
  **evento**, não a regra, e o aviso do Telegram diz isso com todas as letras.
- **A extração do `#NNNNN` só olha título e assunto**, nunca o corpo do e-mail nem a transcrição
  (`RE_DEAL_TITULO`, mínimo de 5 dígitos). Em texto de fala corrida, `#` seguido de número é ruído
  provável — "o protocolo #99887766" numa transcrição não pode virar vínculo com um negócio.
- **Nota duplicada é pior que nota atrasada.** A última linha de toda nota é um marcador
  `[ollow-notas:xxxxxxxx]` derivado da origem. O POST fica entre dois commits (`POSTANDO` → POST →
  `POSTADA`): se o processo morrer no meio, a retomada **não reposta às cegas** — procura o marcador
  em `GET /deals/{id}/notes` e só posta se não achar. Não conseguindo conferir, vira `REVISAR_MANUAL`
  + Telegram. Medido em 16/08/2026: esse GET devolve `description` íntegra (sem truncagem), pagina
  por `?start=` e **ignora `limit`** (sempre 10 por página) — o deal da Lia já tinha 40 notas, então
  olhar só a primeira página responderia "não achei" para uma nota existente, que é exatamente o caso
  em que o código postaria a segunda. Bater no teto de páginas **lança**, nunca devolve "não achei".
- **`is:unread` não é a fila.** O seletor é a AUSÊNCIA dos rótulos `Notas/Processado`, `Notas/Orfao`
  e `Notas/Erro`. Se fosse "não lido", alguém abrindo o e-mail no celular faria o bot nunca mais ver
  aquela reunião — e nada avisaria. Os três rótulos são **criados no início de cada ciclo**, antes de
  montar a busca: a query é feita de `-label:"Notas/..."`, e um `-label:` de rótulo inexistente não
  tem comportamento garantido — se não casar nada, o primeiro ciclo volta vazio e a rotina parece
  funcionar sem fazer nada.
- **Nada reprocessa para sempre, e nada fica em silêncio.** Duas defesas que faltavam e que o
  `tentativas` da tabela sozinho não dava:
  - `registrarFalhaNota` **desiste** após `NOTAS_MAX_TENTATIVAS` (padrão 3, o mesmo de
    `src/fila.js` e pelo mesmo motivo: cada tentativa custa uma chamada de IA com o texto inteiro).
    Antes a coluna era incrementada e **nunca lida** — um e-mail com deal apagado voltava a cada 10
    min para sempre, sem avisar ninguém. Ao desistir: estado terminal, rótulo
    `Notas/Erro` e Telegram com o comando de religar.
  - `conferirSilencioNotas` avisa após `NOTAS_SILENCIO_DIAS` (padrão 10) **sem nenhum e-mail novo**.
    Repare no que é medido: a última vez que a busca devolveu ALGUMA mensagem, gravada em
    `notas_reuniao_saude` — nunca "este ciclo veio vazio", que é o estado normal da maioria dos ciclos.
    Silêncio prolongado tem a mesma cara de "não houve reunião", "o token morreu" e "o Google mudou o
    formato do assunto".
- **Estado terminal nunca é reprocessado — é a trava contra nota duplicada.** O rótulo do Gmail é
  aplicado DEPOIS de o estado virar terminal, e o `messages.list` do mesmo ciclo roda logo em seguida.
  Se o índice de busca do Gmail atrasar, ou se a retomada falhar antes de conseguir rotular, a mesma
  mensagem volta na lista — e os dois `if` de retomada de `processarNotaReuniao` não casam mais (o
  estado deixou de ser `POSTANDO`), então ela seria reprocessada do zero: uma **segunda nota** no
  prontuário do cliente. O marcador não cobre isso, porque só é consultado dentro
  do ramo `POSTANDO`. Por isso a guarda de `ESTADOS_TERMINAIS` é a primeira coisa da função.
  `dealIdForcado` atravessa de propósito (é o único jeito de ressuscitar um órfão) — menos em
  `CONCLUIDO`, onde religar **lança**, porque só criaria a segunda nota.
- **`ambiguo` não é "o POST falhou".** Só a *retomada* de um `POSTANDO` que não conseguiu descobrir se
  a nota já existe escala direto para `REVISAR_MANUAL`. Um POST que falha deixa o estado em `POSTANDO`
  e o ciclo seguinte reconcilia sozinho pelo marcador — inferir a ambiguidade do estado faria uma
  queda de rede comum virar trabalho manual à toa.
- **Doc duplicado é barrado em QUALQUER estado da primeira cópia**, não só em `CONCLUIDO`. O índice
  único em `doc_id` é o que impede a segunda nota; sem cobrir os outros estados, um reenvio cuja
  primeira cópia virou órfã batia na constraint, lançava, e o e-mail voltava a cada ciclo para sempre.
  A cópia canônica continua sendo a primeira, e é lá que o religamento manual acontece.
- **Nenhum sinal de identidade sai do corpo nem da transcrição.** `#NNNNN` só de título e assunto;
  `ID NNNNN` só do assunto. O corpo é o resumo que o Gemini escreveu **a partir da fala** — "o ID
  12345678 do processo administrativo", um número que o cliente leu em voz alta, viraria vínculo de
  confiança *alta* com um negócio qualquer. A transcrição nem chega em `extrairSinais`: não existe
  parâmetro para ela, e há teste garantindo que continue assim.
- **Credencial separada.** `google-oauth-token-notas.json`, cliente OAuth próprio, porta 8092
  (`autorizar-google-notas.js`). O token do bot tem escopo só de Calendar; somar Gmail/Drive a ele
  exigiria refazer o consentimento, e um consentimento refeito pode invalidar o refresh token em uso
  — derrubar o agendamento para ligar uma funcionalidade nova. **Conferir o publishing status da tela
  de consentimento**: em "Testing" o refresh token expira em 7 dias e a rotina para em silêncio.
- **Botão de emergência.** `NOTAS_REUNIAO_ATIVO=false` (padrão) desliga; `NOTAS_REUNIAO_DRY_RUN=true`
  (padrão) roda o ciclo inteiro e imprime a nota sem escrever nada, gravando o estado em
  `notas_reuniao_dryrun` — tabela **separada** de propósito: se o dry-run gravasse na tabela real, a
  primeira execução de verdade acharia tudo `CONCLUIDO` e não faria nada.
- **Inspeção:** `GET /notas-reuniao/amostrar?limite=N` (só leitura, atrás de `exigeAdmin`) mostra o
  que a cascata decidiria para cada e-mail, sem extrair nem escrever. É o teste de regressão manual
  quando o Google mudar o formato do e-mail. `POST /notas-reuniao/sincronizar?aplicar=1` força um
  ciclo real.

### O PDF da transcrição na aba "Arquivos" do negócio

A nota traz o resumo; o Doc que o Gemini gera vira **anexo** no mesmo negócio (`anexarDocNoDeal`,
`index.js`). Desligado por padrão (`NOTAS_ANEXO_ATIVO`).

- **O Moskit não aceita upload — ele BAIXA de uma URL que a gente dá.** Medido em 18/08/2026 na doc
  oficial (que hoje é "Ollow API V2", `moskit.stoplight.io`): `POST /deals/{id}/attachments` tem
  corpo `{"url": "..."}` em `application/json`, e o `Content-Type` é um enum de um valor só — não há
  `multipart/form-data`. A doc ainda avisa que *"o arquivo não fica disponível instantaneamente"*, ou
  seja, o Moskit copia para o storage dele de forma assíncrona. Os quatro endpoints (`GET` lista com
  paginação por `start`, `POST`, `GET` por id, `DELETE`) usam o mesmo header `apikey` do resto.
- **Por isso existe uma rota pública sem autenticação.** `GET /arquivo-nota/:token/:nome` serve o PDF
  para o Moskit, que não tem como mandar `ADMIN_TOKEN`. É a única rota aberta além do health check, e
  o conteúdo é a transcrição de uma consulta jurídica — o que a protege é token de 256 bits, TTL
  curto (`NOTAS_ANEXO_TTL_HORAS`) e **invalidação imediata assim que o Moskit confirma a cópia**.
  `:nome` é **decorativo e nunca toca o disco**: existe só porque o Moskit deriva o `filename` da
  URL. O caminho real vem do banco — montar caminho com pedaço de URL é o que abriria path traversal
  (`test-rotas.js` tem a regressão, inclusive a tentativa de `../`).
- **O interstício do ngrok grátis é o risco principal, e é silencioso.** O plano gratuito devolve uma
  **página HTML de aviso** para quem ele julga navegador; o bypass é o header
  `ngrok-skip-browser-warning`, que **não controlamos** — quem faz o GET é o Moskit. Nesse caso o
  POST responde 2xx, o anexo aparece na aba com o nome certo, e só quem **abrir** descobre que é um
  HTML. Por isso `conferirAnexoNoMoskit` compara `size` e `mimeType` do que o CRM guardou com o PDF
  enviado e manda Telegram na divergência. Medir antes de ligar: `test-moskit-anexo-real.js`.
- **O nome do arquivo É a chave de deduplicação.** O POST não aceita marcador dentro do arquivo (o
  corpo é só uma url), então, depois de um crash entre "vou anexar" e "anexei", a única pergunta
  possível ao CRM é *"existe anexo com este nome?"*. `nomeAnexoNota` (`src/notas-reuniao.js`) deriva
  o sufixo do mesmo hash de `marcadorNota` — mesma origem, mesmo nome, sempre. Nome instável faria a
  resposta ser sempre "não achei" e poria uma segunda cópia da transcrição no prontuário do cliente.
  A retomada usa o `anexo_nome` **já gravado** (`nomeForcado`), nunca recalcula.
- **Bracket próprio.** O `POSTANDO → POSTADA` da nota não cobre este segundo efeito não-idempotente:
  `ANEXANDO → ANEXADO`, em colunas separadas (`anexo_*`). Separadas de propósito — a guarda de
  `ESTADOS_TERMINAIS` e a query `pendentes` são a trava contra nota duplicada, e um estado novo
  circulando por elas mudaria esse comportamento sem ninguém ter pedido. `anexoComNomeExiste`
  **lança** ao bater no teto de páginas, igual a `notaComMarcadorExiste` e pelo mesmo motivo.
- **O bracket abre antes de QUALQUER rede, e a tentativa é contada uma vez só.** Abrir só antes do
  `POST` deixava um buraco: uma falha na listagem de deduplicação — e o Moskit responde 429/timeout
  de 30s quando a varredura bate forte, como já documentado na reconciliação de vínculo — caía no
  `catch` com `anexo_estado` ainda `NULL`, e `anexosPendentes` só casa `'ANEXANDO'`. O PDF daquela
  reunião sumia para sempre, sem retry e sem rastro. Pelo mesmo motivo o `catch` **não** incrementa
  `anexo_tentativas`: contar nos dois lugares fazia UMA falha custar DUAS tentativas, o defeito já
  corrigido em `e78156f` para `erros_transitorios`.
- **`SEM_DOC` só pode significar "esta reunião não tem transcrição".** É um estado que a rede de
  segurança nunca retoma, então `exportarPdfDoDoc` devolve `{ bytes, transitorio }` e separa os dois
  mundos: 404/403 é veredito (o Doc não existe ou está fora do alcance da credencial) e vira
  `SEM_DOC`; 5xx, 429, timeout e DNS ficam em `ANEXANDO` para nova tentativa. Sem essa distinção, um
  Drive piscando gravaria no banco a afirmação contrária e perderia de vez o PDF de uma consulta que
  existia — enganando também quem fosse auditar depois.
- **`anexarDocNoDeal` NUNCA lança**, e roda **antes** do bracket da nota — é o que permite o rodapé
  afirmar "transcrição anexada" com honestidade. Se lançasse, trocaria um bônus ausente por um
  prontuário sem registro nenhum da consulta.
- **Sem Doc, sem anexo.** Não geramos PDF do resumo do e-mail: ele já está inteiro dentro da nota.
- **Desistir é silencioso.** Anexo faltando não é incidente — a consulta está registrada. Telegram a
  cada falha viraria ruído diário; só a divergência de tamanho (o sintoma do interstício) avisa.
- **Nenhum `db.prepare` no topo do arquivo pode depender dessa migração.** A consulta da rota pública
  é preparada **sob demanda** (`stmtNotaPorAnexoToken()`), e isso não é estilo: os `ALTER TABLE` vivem
  em `try {} catch {}` como todo o boot, e um prepare no carregamento do módulo transformava esse
  catch numa armadilha. Migração falhando por qualquer motivo que não "coluna já existe" — disco
  cheio, banco travado, arquivo corrompido — fazia o `require` lançar `no such column`, o processo
  morrer com **exit 1** e o pm2 entrar em loop de restart: o bot inteiro (WhatsApp, agenda, CRM) fora
  do ar por causa de uma coluna de uma funcionalidade que nasce **desligada**. Medido antes da
  correção. Preguiçoso, o pior caso é um 404 na rota de anexo. Regressão em `test-rotas.js`, que
  simula a migração impossível com uma VIEW chamada `notas_reuniao` (o `CREATE TABLE IF NOT EXISTS`
  pula em silêncio e o `ALTER` falha de verdade).
- **A migração é `ALTER TABLE`, não linha nova no `CREATE`.** As tabelas `notas_reuniao` /
  `notas_reuniao_dryrun` usam `CREATE TABLE IF NOT EXISTS`: em banco que já existe — produção
  inclusive — o `CREATE` não roda e as colunas novas simplesmente não apareceriam.
- **`drive.readonly` já basta** para exportar em PDF: nenhum consentimento OAuth novo, o que evita
  invalidar o refresh token em uso e derrubar o agendamento. `exportarPdfDoDoc` confere a assinatura
  `%PDF-` antes de aceitar os bytes — o Drive responde 200 com corpo HTML em algumas falhas de
  permissão, e um HTML salvo como `.pdf` entra no CRM parecendo anexo legítimo.
- Regressões em `test-notas-reuniao.js` (nome e rodapé, puros), `test-pipeline.js` (fluxo, dedup,
  retomada, TTL, interstício) e `test-rotas.js` (a rota pública).

### Cliente que volta: o segundo atendimento do mesmo telefone

A conversa é **uma linha por telefone, para sempre** — nada nela é encerrado quando o atendimento
termina. Cliente que já foi atendido e volta meses depois com um caso NOVO caía na mesma linha, com o
`deal_id` antigo, o histórico antigo do WhatsApp e todos os checkpoints herdados. A decisão fica em
[src/cliente-retorno.js](src/cliente-retorno.js) (puro, sem rede); o `index.js` só busca o que ela pede.
Desligado por padrão (`CLIENTE_RETORNO_ATIVO`) e, quando ligado, em dry-run (`CLIENTE_RETORNO_DRY_RUN`).
**No dry-run o ciclo segue como hoje** — decide, loga, posta nota `[dry-run]` e avisa no Telegram, mas
não corta nada e não impede a escrita no negócio antigo. Isso é de propósito: dry-run que já mudasse o
comportamento não mediria o status quo.

- **O que era estragado, em silêncio, nas quatro frentes:** o PUT reabria negócio GANHO (ver o bullet
  do `status` em "Integrações externas"); `mesclarParaCrm` arrastava área/assunto do caso velho para o
  caso novo (com `_casoDescritoValidado` já marcado); `bloco_condicoes_enviado = 1` do primeiro
  atendimento tornava a consulta nova PAGA sem ninguém ter cobrado; e `contrato_zapsign_criado`,
  `evento_calendar_*`, `atividade_moskit_id`, `campos_travados`, `briefing_*` continuavam do
  atendimento anterior.
- **"Já foi cliente" = consulta REALIZADA**, não contrato assinado (decisão do escritório em
  19/08/2026). Duas fontes, ambas locais: `conversations.evento_calendar_data` no passado e a nota do
  Gemini `CONCLUIDO` do deal (que só existe se a reunião ocorreu, e cobre a consulta marcada direto no
  CRM). Vale a mais recente. `evento_calendar_data` é **naive** do escritório: a conversão é
  `horarioNaiveParaInstante`, nunca `new Date()` cru — em UTC isso erraria a fronteira por 3h.
- **A folga de `RETORNO_FOLGA_HORAS` (padrão 2) depois do fim da consulta** existe porque mensagem
  trocada durante a reunião, ou logo depois ("esqueci de dizer que tenho o contrato X"), é o MESMO
  atendimento.
- **Nenhum campo novo de IA.** A evidência de caso novo são as observações que já existem e já são
  validadas contra a mensagem real (`cliente_descreveu_caso`/`equipe_descreveu_caso`,
  [src/evidencia.js](src/evidencia.js)); o código acrescenta *quando* elas valem (mensagem posterior ao
  fim da consulta, pelo timestamp da própria mensagem) e a corroboração determinística: assunto **ou**
  área diferentes. Área comparada por ID da opção do CRM — "Direito Digital" e "LGPD" são a mesma área,
  e compará-las como texto abriria um segundo negócio para o mesmo caso.
- **Assunto igual e área igual = `ambiguo`, e ambíguo NÃO abre negócio.** Depois de uma consulta, o
  cliente continuar falando do mesmo caso é o comportamento *normal*; um segundo negócio para o mesmo
  caso duplica o cliente no funil e espalha a história dele em dois lugares, sem que ninguém detecte
  lendo — os dois parecem legítimos. No ambíguo o bot também zera `area_direito`/`advogado_responsavel`/
  `assunto` da rodada (mesma técnica de `aplicarGateCasoDescrito`), avisa uma vez
  (`retorno_aviso_hash`) e não reclassifica nada.
- **O ciclo que detecta o retorno NÃO cria o negócio.** Nessa rodada a IA leu o histórico do caso
  ANTIGO, então o que ela extraiu está contaminado por ele. `abrirNovoAtendimento` empilha o negócio em
  `deals_anteriores`, grava o corte, zera o estado numa única `UPDATE` (meia limpeza é pior que
  nenhuma) e **reagenda** — `agendarProcessamento`, ou `enfileirar` em `WORKER_MODE`. Sem esse
  reagendamento a conversa ficaria muda com um atendimento aberto e vazio: nada aqui reprocessa uma
  conversa só porque o tempo passou (o defeito do deal 48466404).
- **A janela é um corte de exibição com índices ABSOLUTOS.** `montarHistorico(mensagens, { inicio })` e
  `detectarBlocoCondicoes(mensagens, { inicio })` pulam o atendimento anterior mas continuam numerando
  pelo array inteiro, porque é contra ele que `validarObservacoes` confere `mensagens[msg_idx]`.
  Reindexar faria toda observação apontar para outra mensagem. Observação com `msg_idx` antes do corte
  é descartada (o modelo não a viu). A janela vale também em `reconciliarClassificacao`, que recalcula
  a cobrança das MENSAGENS — sem ela, a reconciliação reintroduzia o bloco do atendimento anterior; a
  query de lá precisa trazer `atendimento_inicio_msg_idx`, senão a coluna chega `undefined` e o corte
  volta a ser 0 (tem regressão com controle).
- **Não há teto de atendimentos.** Cliente de escritório volta mais de uma vez, e todo sinal usado na
  decisão se refere ao atendimento ATUAL (`evento_calendar_data` e `last_data` foram zerados no corte
  anterior, e `obsValidas` já vem filtrado pela janela), então o 3º caso abre o 3º atendimento e o corte
  novo cai sempre depois do atual. Uma guarda do tipo "só se ainda não houve corte" faria o 3º caso
  voltar a cair dentro do negócio do 2º — o mesmo defeito, uma volta mais tarde. Regressão em
  `test-pipeline.js`.
- **O que NÃO é limpo:** `atividades_sincronizadas` (a linha do atendimento antigo é a trava que impede
  um segundo evento no Google para a consulta velha) e `comprovantes` (chaveado por deal, então o
  negócio novo já nasce sem comprovante).
- **Responsável pela regra normal da área** (`ADVOGADO_POR_AREA_ID`), como qualquer lead — o retorno não
  herda o advogado do caso anterior. O aviso do Telegram é que liga os dois para a equipe, e o negócio
  novo nasce com uma nota citando o anterior (lida de `deals_anteriores`, sem chamada ao CRM).
- **Migração e prepares preguiçosos.** As quatro colunas novas (`atendimento_inicio_msg_idx`,
  `atendimento_num`, `deals_anteriores`, `retorno_aviso_hash`) entram por `ALTER TABLE` em
  `try {} catch {}`, e **nenhum `db.prepare` do topo do arquivo pode depender delas** — mesmo motivo de
  `stmtNotaPorAnexoToken()`. `janelaAtendimento` devolve 0 para coluna ausente, que é o comportamento
  de antes desta funcionalidade existir.
- **Inspeção:** `GET /clientes-retorno/amostrar?limite=N` (só leitura, sem IA, atrás de `exigeAdmin`)
  lista as conversas com consulta realizada e mensagem posterior a ela. É como medir a prevalência
  antes de ligar.
- Regressões em `test-cliente-retorno.js` (módulo puro), `test-cliente-retorno-flags.js` (os dois modos
  com que isto vai a produção — desligado e dry-run — cada um no seu processo, porque as flags são
  `const` lidas no require, mesmo motivo de `test-agenda-dry-run.js` existir) e `test-pipeline.js` (o ciclo do corte, o ciclo
  que cria o segundo negócio com `price 0`, o caminho ambíguo e o dedup do aviso). O dublê da OpenAI
  desse arquivo (`https.request`) nasceu aqui e tapou um buraco antigo: `processarNotaReuniao` chamava a
  OpenAI de verdade na suíte.

### Reunião de retorno: a 2ª+ reunião do mesmo caso

Diferente de "Cliente que volta" (caso NOVO, negócio diferente): aqui o cliente já atendido volta
para uma **segunda reunião do mesmo caso** — alinhamento pós-consulta, acompanhamento processual.
Mesmo negócio, mesma classificação, só o **compromisso** (evento/Atividade/briefing) é novo. A
decisão fica em [src/reuniao-retorno.js](src/reuniao-retorno.js) (puro, sem rede); o `index.js` só
busca o que ela pede. Desligada por padrão (`REUNIAO_RETORNO_ATIVO`) e, quando ligada, em dry-run
(`REUNIAO_RETORNO_DRY_RUN`).

- **O que era estragado, em silêncio.** `handleAgendamentoCalendar` só conhecia UMA consulta por
  conversa (`evento_calendar_criado`/`evento_calendar_id`/`atividade_moskit_id`/`briefing_*` são
  campos únicos por linha de `conversations`). Cliente+equipe confirmando um horário novo para uma
  reunião de acompanhamento caía sempre no ramo "evento já existe" e era tratado como **remarcação**:
  `atualizarEventoSeRemarcado` dava `PATCH` em `start`/`end` do evento **que já aconteceu**, apagando
  o registro da reunião anterior (e o evento a que a nota do Gemini estava ancorada), e a reunião nova
  nunca entrava na agenda do Moskit (`registrarConsultaNaAgendaMoskit` sai na guarda de
  `atividade_moskit_id` já existente). Se a Atividade antiga já tivesse sido concluída, o `PUT` da
  remarcação batia no `422 "Completed activity cannot be updated"` — o Google movia, o Moskit não.
- **A tolerância de 24h separa no-show de reunião nova.** Cliente que fura o horário e a equipe
  remarca logo depois é a MESMA reunião que deslizou — não uma reunião nova. `classificarReuniao`
  (`src/reuniao-retorno.js`) só decide "retorno" quando a consulta anterior **já aconteceu** (reuso
  direto de `clienteRetorno.consultaJaRealizada`) **e** a dupla confirmação fechou o horário novo
  **depois** de `REUNIAO_TOLERANCIA_REMARCACAO_HORAS` (padrão 24h) do fim da reunião anterior.
  `confirmadoEm` é o timestamp da **mensagem** que fechou a perna mais recente da dupla confirmação
  (`timestampConfirmacao`, `index.js`) — nunca `Date.now()`, senão um reprocessamento dias depois
  (fila, `processar_pendentes.js`, refresh de briefing) recalcularia a mesma conversa com um relógio
  diferente e inverteria o veredito.
- **Vocabulário: "Consulta" continua "Consulta"; a 2ª reunião em diante é "Retorno N".**
  `rotuloCompromisso` é a fonte única — `montarResumoEvento(dados, dealId, numeroReuniao)` ganha um
  3º parâmetro, sempre lido de `row.reuniao_num` e **nunca recalculado**, pelo mesmo motivo do
  `dealId` no comentário da própria função: `sincronizarMetadadosEvento` **compara** o resumo com o
  que já está no Google, e duas fontes diferentes para o mesmo número repatchariam o evento pra
  sempre. O sufixo `· #dealId` continua sufixo, e o backfill do Meet (`eDeConsulta`) passa a
  reconhecer também `[deal:\d+]` na descrição e `/^Retorno\s+\d+\s*—/` no título.
- **Abrir a reunião nova é uma única `UPDATE`** (`abrirNovaReuniao`, `index.js`, mesmo padrão de
  `stmtAbrirAtendimento`): arquiva a reunião atual (`{numero, horarioIso, evento_id, atividade_id,
  encerrada_em}`) em `reunioes_anteriores`, incrementa `reuniao_num`, e zera **só** o estado do
  compromisso (`evento_calendar_*`, `atividade_moskit_id`, `briefing_*`, os hashes de
  pendência/erro/divergência). **Preserva de propósito** `deal_id`, `bloco_condicoes_enviado`,
  `contrato_zapsign_*`, `custom_fields_bot`/`campos_travados` — é o MESMO caso, nada disso deveria
  mudar. A chamada recursiva de `handleAgendamentoCalendar` com o `row` relido do banco cai no ramo de
  criação normal (evento + Atividade novos), reusando o caminho já testado em vez de duplicá-lo.
  `atividades_sincronizadas` **não é tocada** — a linha da reunião anterior continua sendo a trava
  contra evento duplicado para ela; a reunião nova ganha a sua própria.
- **No dry-run, o evento anterior nunca é movido** — desvio deliberado da convenção de
  `CLIENTE_RETORNO_DRY_RUN` ("segue como hoje"): aqui "como hoje" seria mover o evento da consulta
  que já aconteceu, e medir não justifica destruir esse registro. O dry-run só posta nota
  `[dry-run]` + Telegram (dedup por `reuniao_aviso_hash`) e retorna.
- **`autorizacaoParaAgendar` ganha o motivo `'retorno'`**: deal que já teve uma reunião realizada
  (`consultaJaRealizadaPorDeal`, a mesma pergunta de `consultaDoAtendimento` para quem só tem o
  `dealId`) é liberado sem comprovante — sem isso, uma Atividade de acompanhamento criada direto no
  Moskit (sem chat) ficaria travada em "aguardando_pagamento" para sempre, esperando um comprovante
  de uma consulta que já foi paga. Determinístico por desenho: o critério é a consulta realizada, não
  o título que a equipe digitou (que abriria um contorno do gate de pagamento).
- **A nota do Gemini ganha o número da reunião no título** (`— REUNIÃO N`), calculado por
  `numeroDaReuniao(reunioes, dataIso)` a partir da **data** do assunto do e-mail (que não tem hora) —
  nunca do contador atual, porque o e-mail da reunião 1 pode chegar depois de a reunião 2 já estar
  aberta. Dia com mais de uma reunião é ambíguo de propósito e não numera nada (mesmo "candidato
  único ou nada" de `decidirDeal`). Desde 02/09/2026 a nota é só o link (ver seção própria) — a
  numeração é a única coisa que este recurso ainda acrescenta a ela.
- **O briefing pré-reunião também é numerado, mas por um vocabulário diferente do da agenda.**
  O título usa contagem simples e sequencial (`Reunião 1`, `Reunião 2`, ...) — é o que o usuário pediu
  — enquanto o cabeçalho da nota usa o mesmo `rotuloCompromisso` da agenda (`Consulta:`/`Retorno N:`).
  `briefing_versao` reinicia em 0 no `abrirNovaReuniao`, então cada reunião tem sua própria trilha de
  versões e a primeira nota da reunião nova sempre reposta (o horário mudou, o hash muda).
- **Interação com "Cliente que volta": o ramo `ambíguo` não pode travar uma reunião já confirmada.**
  Hoje, consulta realizada + caso descrito depois com mesmo assunto/área força `acao = 'aguardar'`,
  que retorna **antes** de `finalizarCiclo` — `handleAgendamentoCalendar` nunca roda, e o retorno
  nunca seria agendado. Quando a dupla confirmação já fechou num horário posterior ao fim da consulta
  realizada, a ambiguidade "caso novo ou continuação?" está resolvida (é reunião nova do mesmo caso) e
  o ramo deixa de anular `area_direito`/`advogado_responsavel`/`assunto` e de forçar `aguardar`. Só se
  aplica com `REUNIAO_RETORNO_ATIVO` ligado — sem a rotina saber abrir a reunião nova corretamente, o
  comportamento mais seguro é o de hoje (congelar e avisar).
- **Migração e prepares preguiçosos.** As três colunas novas (`reuniao_num`, `reunioes_anteriores`,
  `reuniao_aviso_hash`) entram por `ALTER TABLE` em `try {} catch {}`, mesmo motivo de
  `stmtNotaPorAnexoToken()`/`stmtAbrirAtendimento()`.
- Regressões em `test-reuniao-retorno.js` (módulo puro: tolerância, `numeroDaReuniao`,
  `rotuloCompromisso`) e `test-reuniao-retorno-flags.js` (os três modos com que isto vai a produção —
  desligado, dry-run e ligado-aplicando — cada um no seu processo, mesmo motivo de
  `test-cliente-retorno-flags.js`: prova, através do pipeline real, que desligado continua movendo o
  evento antigo como sempre fez, dry-run não move nada, e o modo ligado abre a reunião nova, cria o
  evento/Atividade com o título certo e preserva a anterior).

### Chatwoot: o nome do contato, para a busca por nome funcionar

O escritório atende pelo Chatwoot. Quando o número do cliente **não está salvo na agenda do WhatsApp**,
o Chatwoot mostra a ficha só com o telefone — e pesquisar pelo NOME não encontra o cliente. O nome já
existe do outro lado (o bot o extrai da conversa e grava no Moskit, mais o espelho local
`moskit_contacts`): esta rotina leva um para o outro, casando por telefone. A decisão fica em
[src/chatwoot.js](src/chatwoot.js) (puro, sem rede); o `index.js` só faz rede e banco. Desligada por
padrão (`CHATWOOT_ATIVO`) e, quando ligada, em dry-run (`CHATWOOT_DRY_RUN` — chave mestra: nem
`?aplicar=1` na rota vence).

- **A decisão é de DANO, não de completude.** Deixar de preencher um nome mantém o status quo (o
  atendente pesquisa pelo número). Preencher o nome ERRADO põe o nome de um cliente na ficha de
  **conversa** de outro, com o histórico de mensagens do segundo à vista — e ninguém descobre lendo,
  porque as duas fichas parecem plausíveis. Por isso o casamento é `mesmoClienteTelefone`
  ([src/telefone.js](src/telefone.js)), que exige o DDD, e **não** `mesmoTelefone`: medido na base real,
  22 pares de contatos compartilham os 8 dígitos finais sendo **pessoas diferentes**. Para *escrever*
  há uma exigência extra — ≥10 dígitos nos dois lados, porque `mesmoClienteTelefone` casa por sufixo
  quando um lado é curto ("não dá pra exigir o que não foi informado"), o que é correto para ler e
  arriscado para escrever. E **ambiguidade não decide**: duas fichas com telefone equivalente viram
  item acionável (merge manual), nunca um palpite — mesmo "candidato único ou nada" de `decidirDeal`.
- **Import por CSV do Chatwoot está DESCARTADO.** Seria a rota sem código, e **cria contato duplicado
  por telefone** (não há constraint de unicidade em `phone_number`; issue chatwoot#12325) — pioraria
  exatamente a busca que estamos consertando.
- **Não existe webhook de contato.** O Chatwoot só emite `conversation_*`/`message_*`. Logo o estado
  local (`chatwoot_contacts`) é a **única** memória de "onde está esta ficha", "eu já escrevi isto" e
  "alguém mexeu depois de mim" — e é por isso que a tabela existe em vez de a rotina ser sem estado.
  (A assinatura HMAC de webhook do Chatwoot, `X-Chatwoot-Signature`, existe no branch de
  desenvolvimento mas **não em release estável** — outro motivo para não haver webhook aqui.)
- **`204` é sucesso, não 200.** O `PUT /contacts/{id}` responde 204. Código novo que testar `=== 200`
  trata sucesso como falha, retenta para sempre e nunca grava o estado — `interpretarRespostaPut`
  existe como função nomeada e com teste só por isso.
- **Precedência (decisão do escritório): só preenche o que está vazio, é o próprio telefone, ou é
  genérico.** Nome digitado por pessoa nunca é sobrescrito. O que sustenta isso *ao longo do tempo* é
  a coluna `nome_escrito` (autoria, o mesmo desenho de `custom_fields_bot`/`campos_travados`): no 1º
  ciclo o campo estava vazio e o bot escreveu; se a equipe corrigir depois para o nome de casada, sem
  memória de autoria "o Chatwoot tem um nome humano" e "o Chatwoot tem o nome que eu mesmo pus" são
  indistinguíveis, e o bot desfaz a correção da equipe. Divergiu do que gravamos ⇒ `travado_humano`,
  permanente.
- **Cascata de fontes do nome, decidida por MEDIÇÃO:** `moskit_contacts.name` → `last_data.nome` →
  `conversations.contact_name`. O espelho do Moskit tem **0 nomes vazios e 0 nomes que são telefone** em
  3.828 linhas, enquanto **91 dos 277 `contact_name` do WhatsApp (33%) são o próprio número** — o
  próprio sintoma que o dono relata. Por isso o perfil do WhatsApp entra por último e passa pelo mesmo
  filtro. Teto da funcionalidade: ~12,6% das conversas não têm nome utilizável em nenhuma fonte — é
  lacuna, não bug.
- **A lista de nomes genéricos era DUAS no `index.js`** (a sanitização do nome que a IA extrai e o
  fallback para o nome de perfil) **e já tinham divergido**: só a segunda rejeitava `teste` e número
  puro, e nenhuma das duas pegava "Não informado" **com acento** — a grafia natural em português, e
  portanto a que o modelo devolve. Agora é uma só (`nomeUtilizavel`, em [src/chatwoot.js](src/chatwoot.js))
  e o `index.js` importa de lá. Ela também tira o `*` do nome vindo do Moskit — **antes** de aplicar
  os genéricos, de propósito: assim `*Cliente sem nome` vira `Cliente sem nome`, bate na lista e sai
  como `null`, nunca escrito. O `*` fica no Moskit (`auditar-crm-relatar.js` depende do literal) e
  nunca chega à tela do atendente.
- **Duas decisões de payload que cortam dano de graça.** `phone_number` **nunca** vai no PUT: achamos a
  ficha *pelo* telefone, não há o que corrigir nele, e reescrevê-lo pode mexer no que amarra o contato
  ao canal do WhatsApp. E `custom_attributes` é **mesclado, nunca substituído**
  (`montarPayloadContato` recebe `atributosAtuais`) — se o PUT substituir o objeto, mandar só a nossa
  chave apagaria todo atributo personalizado do escritório, em toda a base, sem erro nenhum.
  `additional_attributes` não é tocado.
- **`identifier` = `moskit:<contactId>`, e só se o campo estiver vazio ou já for nosso** — outro valor
  ali é de outra integração, e sobrescrever a quebra em silêncio. Colisão (o campo é único por conta,
  então há outra ficha do mesmo cliente já marcada): **não retenta e não libera o identifier da outra**
  (mutilar um cadastro para consertar outro); degrada para `{name, custom_attributes}` — o nome é o que
  o dono pediu, o atalho é bônus — e avisa uma vez, dizendo quais fichas precisam de merge manual.
- **Custom attribute sem definição: MEDIDO, e o resultado contraria a suposição.** A doc e os relatos
  da comunidade dizem que chave sem definição em Settings → Custom Attributes é descartada em
  silêncio. Na instância do escritório (Chatwoot 4.17.1), **não é**: um `PUT` gravou
  `custom_attributes: {moskit_contato_id: "16497274"}` num contato cuja conta **não tem nenhuma
  definição de atributo de contato** (`GET /custom_attribute_definitions` devolveu lista vazia), e o
  `GET` seguinte trouxe o valor íntegro. O jsonb aceita a chave de qualquer jeito.
  **O que continua valendo:** sem a definição, o atributo provavelmente não é *renderizado* na tela do
  atendente — isso NÃO foi verificado, porque exige olhar a interface. Então criar as duas definições
  (`moskit_contato_id` texto, `moskit_negocio_url` link, escopo Contact) segue sendo o certo para o
  atalho ser útil a quem atende; o que caiu foi o medo de perder o dado. A conferência por
  `GET /contacts/{id}` continua sendo a única prova de qualquer coisa aqui.
- **Nunca cria contato no Chatwoot, e a garantia é estrutural.** O cliente HTTP expõe só
  `chatwootGet`/`chatwootPut`; `chatwootRequisicao` **lança** em qualquer POST fora de
  `/contacts/filter` (que é leitura apesar do verbo — a guarda é sobre o CAMINHO, não sobre o método) e
  em qualquer método fora de GET/PUT/POST. `test-pipeline.js` afirma que nenhuma chamada da suíte é
  `POST /contacts`. `ehInterno` é a **primeira** coisa avaliada, antes de casar, montar payload ou
  tocar a rede: `TEAM_PHONES` nunca vira lead, deal, contato — nem nome no Chatwoot.
- **A credencial só vai para o host de `CHATWOOT_BASE`** (`ehHostChatwoot`, molde de `ehHostZernio`):
  hostname exato ou sufixo **com ponto**, porque `endsWith('chatwoot.com')` ingênuo entregaria o token
  para `malchatwoot.com` — este repositório já vazou credencial exatamente assim.
- **Respostas:** 2xx grava estado; colisão degrada e avisa 1×; **403/401 encerra o ciclo** (é global,
  não por contato — insistir nos candidatos seriam milhares de 403); 404 apaga a linha do espelho;
  429/5xx/timeout entram em cooldown exponencial e, ao estourar `CHATWOOT_MAX_TENTATIVAS`, a linha
  desiste (estado terminal). Erro transitório **não** avisa — é o servidor pedindo calma, não "conferir
  na mão" (a lição dos 6 negócios que inundaram o Telegram em agosto). Telegram só no acionável, um
  resumo por ciclo deduplicado, e **zero nota no Moskit** (decisão de 03/09/2026).
- **Idempotência:** `escrita_hash` sobre o payload inteiro (chaves ordenadas em profundidade). Nada
  mudou ⇒ zero PUT. Medido contra um Chatwoot de mentira local: 1ª rodada escreve 35, 2ª escreve 0
  (todos `sem_mudanca`). `deal_id` mudando (cliente-retorno zera a coluna) muda o hash e o link passa
  a apontar para o negócio atual — comportamento desejado, e a razão de o hash cobrir o payload todo.
- **Paginação ignorada em silêncio é ERRO ALTO.** `varrerContatosChatwoot` **lança** quando uma página
  inteira não traz nenhum id novo. Aconteceu 3× com o Moskit neste repo (`/deals`, `/activities`,
  `/contacts` ignoram `limit`/`page` e respondem 200 com a primeira página): o loop releria os mesmos
  registros, escreveria 15 contatos e pareceria ter varrido a base inteira.
- **Migração e prepares preguiçosos.** `chatwoot_contacts` nasce com `CREATE TABLE IF NOT EXISTS` **em
  try/catch** e todos os statements passam por `stmtsChatwoot()` — mesmo motivo de
  `stmtNotaPorAnexoToken()`: um `db.prepare` no topo do arquivo transformaria o catch numa armadilha
  (o `require` morre com "no such table/column", exit 1, pm2 em loop de restart, e o bot inteiro sai
  do ar por causa de uma funcionalidade **desligada por padrão**). Preguiçoso, o pior caso é a rota do
  Chatwoot devolver 500. Regressão em `test-rotas.js` (o cenário da migração impossível, com uma VIEW
  ocupando o nome).
- ⚠️ **O nginx na frente do Chatwoot DESCARTA o header `api_access_token`, e o sintoma é 401 eterno.**
  MEDIDO em 04/09/2026 na instância do escritório (`chatwoot.64-181-190-28.sslip.io`, Chatwoot 4.17.1
  em Docker atrás de nginx nativo): o MESMO token dá **200 direto no container** (`127.0.0.1:3001`) e
  **401 pelo domínio**. Causa: o padrão do nginx é `underscores_in_headers off`, que joga fora em
  silêncio todo header cujo nome tem `_` — e o header de autenticação do Chatwoot tem dois. Perdemos
  uma hora achando que era token vencido, e regeneramos o token duas vezes à toa.
  **Por isso `CHATWOOT_BASE` em produção aponta para `http://127.0.0.1:3001`**: o bot roda na MESMA
  VPS que o Chatwoot (ver a memória do projeto), então a chamada não precisa de proxy, nem de TLS, nem
  de nginx configurado — e deixa de depender de uma configuração que ninguém lembra que existe. A
  alternativa é `underscores_in_headers on;` no nginx, que serve para qualquer outra integração que
  venha depois, mas exige mexer em produção. Para rodar de fora da VPS (dev), use um túnel:
  `ssh -N -L 3001:127.0.0.1:3001 ubuntu@<vps>` e `CHATWOOT_BASE=http://127.0.0.1:3001`.
- ⚠️ **`query_operator` do `/contacts/filter` tem de ser `null`, nunca `'AND'`.** MEDIDO no mesmo dia:
  a instância está em **português** e o Chatwoot valida esse campo contra a string **traduzida** —
  `'AND'` devolve `422 {"error":"Operador de consulta deve ser \"E\" ou \"OU\"."}`. `null` significa
  "este é o último filtro, não encadeia" e é aceito em qualquer idioma. O sintoma era **mudo**: a
  cascata caía para `/contacts/search`, que funciona e acha o contato — só queimava uma requisição
  recusada por candidato, em todo ciclo, para sempre. Regressão em `test-pipeline.js`.
- ⚠️ **O `identifier` JÁ ESTÁ OCUPADO pela Evolution API** — 89 de 90 fichas da amostra têm
  `identifier` no formato `558681416526@s.whatsapp.net` (o container `chatwoot-evolution-1` na mesma
  VPS é quem alimenta o WhatsApp do Chatwoot). A guarda "só escreve se estiver vazio ou já for
  `moskit:`" é o que impede o bot de quebrar o vínculo WhatsApp↔ficha de 89 contatos em silêncio —
  ela **funcionou**, e por isso o atalho para o Moskit vive apenas no custom attribute
  `moskit_negocio_url`, não no `identifier`. Não "consertar" isso liberando a escrita.
- **Números medidos da instância (04/09/2026), para calibrar sem chutar:** 122 contatos na conta,
  **15 por página** (`page=N` pagina de verdade) ⇒ varredura completa em **9 requisições**, não
  centenas. **Nenhum header de rate limit** é devolvido, então só a pausa fixa
  (`CHATWOOT_PAUSA_MS`) protege. `phone_number` vem em `+E164` (78 de 90 com 12 dígitos, 5 com 13,
  1 com 15, 1 com 6, e 5 fichas sem telefone nenhum). `/contacts/search` casa telefone em qualquer
  formato, inclusive só o sufixo de 8 dígitos. **O tamanho do problema do dono: de 90 fichas
  amostradas, 27 têm o telefone no lugar do nome e 4 têm nome genérico — 31 ganhariam nome; 59 já têm
  nome humano e nunca serão tocadas.**
- **A escrita foi validada em UM contato real (04/09/2026, ficha 78).** Antes:
  `name: "558681810093"`. Depois: `name: "Sérgio Benvindo"`, com `identifier` da Evolution API
  (`558681810093@s.whatsapp.net`) **preservado** e `custom_attributes.moskit_contato_id` gravado.
  `GET /contacts/search?q=Sérgio` e `?q=Benvindo` passaram a encontrar a ficha, e a busca pelo
  **número continua funcionando** — nada foi perdido. Segunda execução: **zero PUT** (`sem_mudanca`).
  ⚠️ **A busca do Chatwoot é sensível a ACENTO**: `q=Sergio` devolve 0 resultados para
  "Sérgio Benvindo". Não há o que fazer do nosso lado (é o `ILIKE` do Chatwoot sobre o nome, e gravar
  uma versão sem acento poria um nome errado na ficha) — a equipe precisa digitar com acento, ou parte
  do sobrenome.
- **Inspeção e operação:** `POST /chatwoot/sincronizar-contatos` (`exigeAdmin`, dry-run por padrão,
  `?aplicar=1`, `?limite=N`); `sondar-chatwoot.js` mede a instância antes de qualquer lote;
  `backfill-chatwoot-nomes.js` corrige o acumulado. Rotina periódica na **fase 20** de
  `agendarReconciliacao` — 0/5/10/15 já estão ocupadas, e somar burst no mesmo minuto foi o que fez o
  rate limit derrubar a reconciliação de vínculo em agosto.
- Regressões em `test-chatwoot.js` (módulo puro), `test-pipeline.js` (rede/banco: interno, nenhum
  `POST /contacts`, nome humano, autoria, hash, colisão, 403, 404, 429, cascata de busca, paginação
  falsa, resumo do Telegram) e `test-chatwoot-flags.js` (os dois modos com que isto vai a produção —
  desligado e dry-run — cada um no seu processo, mesmo motivo de `test-agenda-dry-run.js`).

### O Chatwoot NUNCA escreve mensagem de conversa — decisão de 04/09/2026, do dono

`chatwootRequisicao` (`index.js`) recusa **qualquer** método que não seja GET contra **qualquer**
caminho que toque `/messages` — criar, editar ou apagar mensagem de conversa está fora do escopo,
incondicionalmente, para sempre. A guarda é por regex sobre o caminho
(`/\/messages(\/|$|\?)/`), não por revisão de código: o mesmo desenho de `CHATWOOT_POSTS_PERMITIDOS`
("a garantia fica no código, não na memória de quem escreve o próximo commit").

Nasceu de um incidente real: uma tentativa de **recuperar** mensagens perdidas na janela do incidente
abaixo (com o dono tendo pedido a recuperação) escreveu em conversas de cliente de verdade sem avisar
que apareceriam com o timestamp de **agora** e a autoria do **usuário logado** (porque toda escrita
usa o `CHATWOOT_API_TOKEN` pessoal) — e pareceu, do lado de quem estava vendo o Chatwoot ao vivo, um
bot descontrolado mandando mensagem sozinho pro cliente. A frase final do dono foi literal: **"eu não
quero, nunca mande mensagem pros meus clientes."** As 53 mensagens recuperadas antes dessa decisão
**ficaram como estavam** (16 foram apagadas manualmente pelo próprio dono ao notar a atividade) — não
foram nem completadas nem desfeitas depois, por decisão dele.

`GET .../messages` continua permitido — é como o monitor abaixo e qualquer investigação futura leem
o que está acontecendo numa conversa; só a **escrita** é proibida. A sincronização de nome de contato
(`PUT /contacts/{id}`, seção "Chatwoot" acima) continua sendo a única exceção nomeada de escrita
neste cliente — é campo de contato, nunca mensagem, e nasceu deliberada e testada antes deste
incidente. Regressão em `test-pipeline.js` ("NUNCA escreve mensagem").

### Monitor da Evolution API — nunca mais ficar mudo

**O incidente, medido:** em 04/09/2026 um Access Token pessoal do Chatwoot apareceu exposto numa
conversa e foi regenerado por segurança. A Evolution API (`chatwoot-evolution-1`, o serviço Docker
que conecta o WhatsApp real ao Chatwoot, **na mesma VPS do bot**, instância `"escritorio"`) continuou
configurada com o token **antigo**, agora inválido. Por **58 minutos** (12:27:10–13:25:13 UTC,
medido pelos timestamps reais do container) **nenhuma mensagem de WhatsApp virou conversa no
Chatwoot** — a equipe via a mensagem no WhatsApp normal, mas ela nunca chegava a quem atende pelo
Chatwoot. O log da Evolution mostrava, repetido 111 vezes, só isto: `[ChatwootService] ERROR Error in
createConversation: ApiError: Unauthorized`. **Nenhum alarme disparou** — só foi descoberto porque o
dono notou manualmente. A correção pontual (religar o token certo via
`POST http://127.0.0.1:8080/chatwoot/set/escritorio`) foi feita e verificada ao vivo; as mensagens
perdidas na janela **não foram recuperadas** (ver seção acima) — decisão fechada, fora de escopo.

- **Cinco sinais, com early-exit** (`src/evolution.js:avaliarSaudeEvolution`) — cada motivo vira uma
  string estável, usada tanto pro dedup quanto pra escolher o texto do aviso: (1) Evolution
  inacessível (`GET /instance/fetchInstances` falha) — os outros sinais nem foram medidos, não dá pra
  confiar neles; (2) a instância `"escritorio"` sumiu da lista; (3) `connectionStatus !== 'open'` — a
  sessão do WhatsApp caiu, causa **diferente** de hoje mas mesmo sintoma; (4) `enabled: false` em
  `GET /chatwoot/find/escritorio` — mesmo GET que já traz o token, sinal de graça; (5) **o token que a
  Evolution tem configurado não autentica mais** (`GET {CHATWOOT_BASE}/api/v1/profile` → 401) — o
  causador de hoje. Testa o token que **veio da Evolution**, nunca `CHATWOOT_API_TOKEN` do bot — são
  credenciais possivelmente diferentes, testar a errada validaria a coisa errada.
- ⚠️ **"Não consegui medir" NUNCA vira "está quebrado" — sem `CHATWOOT_BASE` o 5º sinal é ignorado, não
  reportado como falha.** Achado ao preparar o deploy em 04/09/2026: o `.env` da VPS tinha (e ainda
  precisa ganhar) a seção da Evolution **sem** a do Chatwoot. Nesse estado `chatwootTokenValido`
  montava a URL `"/api/v1/profile"` (base vazia), o `new URL()` falhava e a função devolvia `false` —
  que `avaliarSaudeEvolution` lê como `token_invalido`. Ou seja: **um deploy num `.env` incompleto
  dispararia um alarme falso de token inválido a cada 5 minutos**, no monitor cuja razão de existir é
  que um aviso signifique incidente de verdade (alarme que cria ruído é como o incidente real passa
  batido depois). Agora `medirSaudeEvolution` sai com `tokenValido: null` quando `CHATWOOT_BASE` está
  vazio — `null` é "não medido" no contrato de `avaliarSaudeEvolution`, e os 4 primeiros sinais
  continuam valendo — e `chatwootTokenValido` **lança** em vez de devolver `false`, para que nenhum
  outro chamador (o `sondar-evolution.js`) confunda ausência de configuração com credencial inválida.
  Regressão no modo `sem_chatwoot` de `test-evolution-flags.js` (processo próprio, `CHATWOOT_BASE=''`
  fixado **antes** do require — `delete` não serviria: o `dotenv` do `index.js` preencheria a variável
  apagada a partir do `.env` de quem roda, e o teste passaria a depender da máquina).
- ⚠️ **O token nunca é persistido, nunca vai a log, nunca aparece no texto do Telegram** — fica só em
  memória dentro da chamada que o testa e é descartado no fim do ciclo. É o mesmo tipo de credencial
  que já vazou uma vez (o próprio causador do incidente); repetir isso no texto de um alerta seria o
  oposto do que a funcionalidade existe pra evitar. `pareceConterSegredo` em `src/evolution.js` é a
  regressão dessa garantia.
- **Dedup por hash em SQLite, não variável de processo** (`evolution_saude`, uma linha só,
  `ultimo_hash`/`avisado_hash`/`mudou_em`) — **precisa sobreviver a restart do pm2**: se a falha ainda
  está ativa quando o processo reinicia, uma variável em memória esqueceria o estado e, na volta, não
  saberia avisar "voltou ao normal", ou pior, reenviaria o mesmo aviso a cada restart. Um único hash
  (`'ok'` ou `'falha:<motivo>'`) resolve as duas pontas — avisar quando quebra **e** quando volta —
  com uma comparação: `hash !== avisado_hash` dispara e grava. Cobre também troca de causa em falha
  contínua (`falha:token_invalido` → `falha:sessao_fechada` avisa de novo, mesmo sem passar por
  `'ok'`). Nunca manda "voltou" na primeira execução (`avisado_hash IS NULL` + `hash='ok'` é estado
  normal, não evento) — e por isso `avisado_hash` fica `NULL` enquanto tudo está saudável, só passa a
  existir na primeira vez que há algo a decidir. **Provado com dois processos reais, não simulado**:
  `test-evolution-flags.js` dispara uma falha num processo, mata o processo, sobe um processo NOVO
  contra o mesmo banco (é exatamente o que o pm2 faz) e confirma que o aviso não repete.
- **Cadência própria, 5 minutos, não `agendarReconciliacao`/`RECONCILIACAO_INTERVAL_MS`** (30 min): a
  Evolution roda em `127.0.0.1`, sem rate limit de terceiro a proteger (diferente do Moskit, cujo 429
  é o motivo do deslocamento de fase existir), e amarrar a 30 min reproduziria uma janela cega grande
  demais — o incidente durou 58 min mudo por checar **zero** vezes. Primeira checagem poucos segundos
  depois do boot, não espera o intervalo cheio: um deploy que já sobe com o token quebrado não pode
  esperar 5 min pro primeiro aviso.
- **Nasce LIGADO** (`EVOLUTION_MONITOR_ATIVO !== 'false'`) — a **única** exceção à convenção deste repo
  de toda funcionalidade nova nascer desligada. Essa convenção existe para conter o dano de uma
  **escrita** errada (nome errado numa ficha, nota indevida no CRM); este monitor é estritamente
  leitura contra Evolution e Chatwoot, então o pior caso de estar ligado por engano é um Telegram a
  mais, deduplicado. Sem `EVOLUTION_API_KEY` configurada vira no-op silencioso e documentado, não erro
  martelado a cada 5 min.
- **Cliente HTTP só faz GET, e um ÚNICO POST liberado** (`evolutionRequisicao`,
  `EVOLUTION_POSTS_PERMITIDOS = /^\/chat\/findMessages\/[^/]+$/`) — mesma exceção de
  `CHATWOOT_POSTS_PERMITIDOS`/`/contacts/filter` e pelo mesmo motivo: é busca (leitura) apesar do
  verbo, porque a Evolution exige um corpo (paginação) que GET não carrega. Nenhum PUT, nenhum DELETE,
  nenhum outro POST — a Evolution nunca é escrita por este monitor. `ehHostEvolutionLocal` exige
  **duas coisas ao mesmo tempo**: o host estar na família loopback (`127.0.0.1`/`localhost`/`::1`) **e**
  bater exatamente com o hostname configurado em `EVOLUTION_BASE` — um redirect que trocasse a string
  do host (mesmo dentro da família loopback, ex. `127.0.0.1` → `localhost`) não passa batido.
- **Texto do alerta, por motivo, sempre acionável, nunca com payload fixo de correção.** O aviso de
  `token_invalido` orienta buscar a config atual via `GET /chatwoot/find/escritorio` antes de repostar
  — em vez de embutir um corpo de `POST /chatwoot/set` pronto no texto, que correria o risco de faltar
  um campo que o endpoint exija (o schema completo nunca foi 100% documentado) e criar um **segundo**
  jeito de quebrar a integração. O aviso de recuperação confirma que voltou e por quanto tempo ficou
  fora — e **nunca** sugere recuperar as mensagens perdidas dentro do Chatwoot, decisão já fechada e
  fora de escopo (ver a seção acima, "O Chatwoot NUNCA escreve mensagem de conversa").
- **Relatório de mensagens recebidas durante a falha — pedido do dono em 04/09/2026, DEPOIS do
  incidente.** Numa recuperação de verdade (`falha:*` → `ok`, nunca no "já estava ok"), uma SEGUNDA
  mensagem no Telegram (`montarRelatorioRecuperacaoEvolution`) lista quem escreveu enquanto a
  integração estava quebrada — **por número (quando confirmado), nome e horário, nunca o conteúdo da
  mensagem**: é o time indo conferir manualmente no WhatsApp normal, não o bot tocando no Chatwoot.
  Só mensagem **recebida** (`fromMe: false` — o pedido foi literal, "mensagens recebidas"), nunca de
  **grupo** (`@g.us`, vários participantes, não cabe num relatório "por número") e nunca de número da
  equipe (`ehInterno`, quando o telefone é resolvido).
  ⚠️ **O identificador da Evolution (`remoteJid`) é frequentemente um `@lid` — um ID de privacidade do
  WhatsApp, NÃO o telefone** — e a própria Evolution não expõe o telefone por trás dele em nenhum
  endpoint medido (nem `/chat/findContacts`); só mensagem de **grupo** traz o telefone real
  (`participantAlt`). Por isso o telefone de cada contato é resolvido buscando o **nome** (`pushName`,
  o perfil do WhatsApp) na API do Chatwoot (`resolverTelefoneChatwoot`) — que já resolveu esse
  telefone quando criou o contato, por um canal que a Evolution não expõe pra fora. **Só aceita
  candidato ÚNICO** — mesmo "ambiguidade não decide" do resto do projeto (`buscarOuCriarContato`,
  `decidirDeal`); nome comum ou dois contatos parecidos não elegem um telefone por palpite. Sem
  resolver, o relatório mostra só o nome, marcado como "telefone não confirmado" — melhor um cliente
  sem número que um número errado. Janela do relatório capada em `EVOLUTION_RELATORIO_MAX_JANELA_MS`
  (48h) e contatos exibidos capados em `RELATORIO_MAX_CONTATOS` (25, com "...e mais N" — mesmo padrão
  do resumo do Chatwoot).
- **Inspeção manual:** `node sondar-evolution.js` — molde de `sondar-chatwoot.js`, só leitura, mesmo
  bracket de proteção (`WORKER_MODE=1`, `DB_PATH` descartável, Telegram desligado). Mostra o token
  **mascarado** (nunca inteiro), testa se autentica, e imprime o texto exato que o Telegram receberia
  usando a mesma função pura do monitor real — sem mandar. Nunca chama `POST /chatwoot/set` — é ação
  de escrita, fora do escopo "sondar", mesmo espírito do script irmão nunca criar contato.
- Regressões em `test-evolution.js` (módulo puro: os 5 motivos, prioridade entre motivos simultâneos,
  `pareceConterSegredo`, `montarRelatorioMensagensPerdidas` — cabeçalho, ordenação por horário mais
  cedo, teto de contatos, nunca conteúdo de mensagem), `test-pipeline.js` (rede/banco: ciclo saudável,
  cada motivo, dedup, troca de motivo em falha contínua, recuperação, guardas de host/verbo,
  `buscarMensagensEvolutionNaJanela` excluindo grupo/`fromMe`/fora-da-janela,
  `resolverTelefoneChatwoot` com candidato único × ambíguo × nenhum, e o fluxo completo — recuperação
  manda o "voltou" E o relatório em mensagens separadas, exceto quando a janela está vazia) e
  `test-evolution-flags.js` (o modo desligado, e a prova de persistência com dois processos reais
  compartilhando o mesmo banco).

### Segurança das rotas

- Rotas administrativas (`/sincronizar`, `/processar/:chatId`, backfills, auditorias) exigem
  `ADMIN_TOKEN` via middleware `exigeAdmin` (header `X-Admin-Token` ou `?token=`). Sem
  `ADMIN_TOKEN` definido, essas rotas respondem 503.
- `POST /webhook` exige assinatura HMAC-SHA256 (`WEBHOOK_SECRET`, header `X-Zernio-Signature`,
  validada em `assinaturaValida`/`comparacaoSegura` com comparação de tempo constante). Sem
  `WEBHOOK_SECRET`, a rota aceita qualquer origem sem checar assinatura. A URL do webhook no
  Zernio é sempre `/webhook` (não há caminho customizado) — o mesmo segredo precisa estar
  cadastrado no painel do Zernio.
- `GET /arquivo-nota/:token/:nome` é **pública de propósito** (ver "O PDF da transcrição na aba
  Arquivos"): o Moskit precisa baixar o arquivo e não tem como mandar `ADMIN_TOKEN`. Quem segura a
  porta é o token de 256 bits + `anexo_expira_em`, ambos conferidos na própria consulta SQL, mais a
  invalidação imediata após o CRM confirmar a cópia. Token desconhecido, expirado e arquivo ausente
  respondem **o mesmo 404** — distinguir contaria a quem sondasse que aquele token já existiu.
- `TEAM_PHONES` (env, comparado pelos últimos 8 dígitos via `ehInterno`) nunca deve virar
  lead/deal/contato no CRM.
- `POST /deploy-webhook` exige assinatura HMAC-SHA256 (`DEPLOY_WEBHOOK_SECRET`, header
  `X-Hub-Signature-256`, formato do GitHub, validada em `assinaturaGithubValida`/
  `comparacaoSegura`). Sem `DEPLOY_WEBHOOK_SECRET`, a rota fica **desabilitada** (503) — ao
  contrário de `/webhook`, aqui a ausência do segredo nunca abre a rota. Só dispara para push no
  branch `DEPLOY_BRANCH` (padrão `main`); a execução real (`git pull --ff-only` → `npm install` →
  `npm test` → só então `pm2 restart`) é isolada em `deploy.js`.

### Integrações externas (todas via `axios`, timeout global `TIMEOUT_HTTP_MS`)

- **OpenAI**: chamada HTTPS direta (`openaiChat`), sem SDK — decisão deliberada para evitar hangs.
  **Os pedaços de rede são acumulados como `Buffer` e só decodificados UTF-8 uma vez no fim**
  (`Buffer.concat`). MEDIDO contra a API real em 21/08/2026: o padrão antigo (`data += chunk`, que
  força `toString()` a cada pedaço) corrompeu um caractere multi-byte ("Educaç��o") numa resposta real
  do `gpt-4o-mini` — o caractere caiu bem na fronteira entre dois pedaços TCP. Risco raro mas presente
  em toda chamada à OpenAI do sistema, não só notas de reunião.
- **Moskit CRM** (`MOSKIT_BASE`): `PUT` de deal precisa reenviar o corpo do `GET` (peculiaridade da
  API); `GET` logo após um `PUT` pode retornar dados em cache por até ~4s; `limit` de paginação
  sempre retorna 10 independente do valor pedido. Em `/activities` (medido em 12/08/2026, um
  parâmetro por vez) **o único que pagina é `?start=`** — offset real; `page`, `pageToken`, `offset`,
  `skip`, `from`, `maxId` e `beforeId` são todos **ignorados em silêncio**, respondendo 200 com a
  primeira página de novo. Um loop errado aqui não quebra: relê os mesmos 10 registros e parece ter
  varrido tudo. Ver `listarAtividadesMoskit`. Atenção: em `/contacts` quem pagina é o
  `x-moskit-listing-next-page-token` (`buscarOuCriarContato`) — o mecanismo **difere por endpoint**,
  não assuma. `deal.status` só aceita `OPEN`/`WON`/`LOST`.
  MEDIDO em 02/09/2026 (`auditar-crm-coletar.js`), fechando três incógnitas que estavam em aberto:
  **`/contacts` também ignora `limit=100`** — devolve 10 como todo o resto, então o `limit: 100` de
  `importarContatosMoskit` nunca teve efeito e uma varredura de contatos custa ~427 requisições, não
  ~43. **Os headers de rate limit existem e são úteis**: `x-ratelimit-limit-second` = 6,
  `x-ratelimit-limit-minute` = 240, com `x-ratelimit-remaining-second`/`-minute` e `ratelimit-reset`
  em toda resposta — **nenhum código de produção os lê** (só o coletor da auditoria, que registra o
  mínimo observado no manifesto justamente para embasar a decisão de retrofitar isso ou não).
  E existem **três rotas de metadados** que o projeto nunca usou: `GET /customFields` (7 campos, com
  `module` DEAL/CONTACT e `type`), `GET /pipelines` (2) e `GET /stages` (9, cada um com
  `pipeline: {id}` — é o que liga stage a funil, porque o deal traz só `stage: {id}` e nenhuma
  referência ao funil). `GET /customFields/{id}` **não** lista as opções do campo, então rótulo de
  opção continua vindo só de `src/moskit-ids.js`; id desconhecido tem de sair como `id:NNN`, nunca
  como nome inventado. Duas consequências diretas: `MOSKIT_IDS.CF` conhece 5 dos 7 campos da conta
  (falta `CF_y5lm56iyiY7rKDwW`, "Tipo de ação de massa" de DEAL, e `CF_oJZmPVS9iGBykqgv`, o homônimo
  de CONTACT), e `MOSKIT_IDS.STAGE` conhece 7 dos 9 (falta os dois do funil "Consulta Jurídica"
  `93725`). Apareceu também um valor de `origin` fora da lista conhecida: **`'API V2'`**, em deals de
  2021.
  **Sobre o `CF_y5lm56iyiY7rKDwW`, cuidado com a conclusão fácil.** A suposição natural — "o código
  não conhece, então está vazio, então é esperado" — foi MEDIDA na varredura completa de 02/09/2026 e
  **é falsa**: o campo está preenchido em **1.669 dos 3.096 deals** (58,1% dos do Moskit Boost, 21,7%
  dos manuais), com **20 ids de opção distintos**, em deals criados de 2022 a 2026. Ele é usado
  ativamente pelo escritório. Quem NÃO o preenche é o bot: 2 dos 106 deals `BOT_WHATSAPP`. Isso
  inverte a leitura — num deal criado pelo bot, esse campo vazio pode ser lacuna real, e não ruído,
  porque todo o resto da operação o preenche. Se ele deve entrar em `CAMPOS_OBRIGATORIOS` é decisão
  do dono; o que não se pode é tratá-lo como campo morto. Nenhum dos 20 ids de opção está em
  `src/moskit-ids.js`, e `GET /customFields/{id}` não os lista — para rotulá-los alguém tem de ler as
  opções na tela do CRM.
  **Em `/deals` (listagem) o mesmo padrão se repete, e por anos ninguém tinha testado `?start=`.**
  `page`/`limit` são ignorados em silêncio (sempre os ~10 mais recentes) — por isso
  `auditoria-funil-completo` e o comentário antigo diziam "não há paginação real para `/deals`". MEDIDO
  em 21/08/2026 (`estudar-deals-sem-origem.js`): `?start=` pagina de verdade, igual a `/activities`, e
  cada página já vem com `entityCustomFields` completo — uma varredura da conta inteira (3080+ deals)
  não precisa de GET por deal, só de iterar `start += 10` até a página vir incompleta. Isso também
  revelou que o campo nativo `origin` do deal (não é custom field) grava sozinho, pelo Moskit, o valor
  do header `X-Ollow-Origin` que toda escrita do bot já manda (`'BOT_WHATSAPP'`) — é a forma mais
  confiável de achar "todo deal que o bot tocou", mais confiável que cruzar por
  `conversations.deal_id` (que fica incompleto: cliente-retorno zera esse campo ao abrir atendimento
  novo, e deal criado fora do bot nunca teve linha). Varredura completa em 21/08/2026: dos 3081 deals
  da conta, só 101 são `origin=BOT_WHATSAPP` — a enorme maioria (2793) é `'Moskit Boost'`, uma fonte de
  lead alheia ao bot, com 174 `'Moskit'` (manual) — 13,1% da conta inteira está sem "Origem".
  **A definição de "sem origem" importa, e muda o resultado por uma ordem de grandeza.** Contando só
  campo ausente/vazio, 3 dos 101 deals do bot estavam sem origem. Mas "Não identificado" (id `435777`,
  `src/moskit-ids.js:36`) é o fallback que o próprio prompt manda usar quando não acha o canal
  (`index.js:3051`) — tecnicamente preenchido, mas tão inútil pra análise de captação quanto vazio.
  Contando os dois como "sem origem" (decisão de negócio, não só técnica): **49 dos 101 (48%)**. Causa
  por trás dos 46 casos de "Não identificado" explícito: 24 eram o modelo genuinamente não achando a
  origem na conversa (fallback correto, não é bug — mesmo padrão dos 3 originais); **12 tinham
  `last_action='inviavel'` com `last_data` zerado** — prova em produção de que o bug de merge do
  ramo `'inviavel'` (`index.js:3663-3665,3725-3727`, wipe para `{}` independente de já existir
  deal_id/classificação) não tinha sido coberto pela correção anterior (só tratava
  `'ignorar'`/`'nota'`/`'atualizar_campos'` sem deal/fallback desconhecido); os outros 13 eram "sem
  correspondência em `conversations`" (deal antigo, sem linha nem em `deals_anteriores`). **Corrigido
  em 21/08/2026**: os dois ramos agora persistem `dadosAnteriores` em vez de `{}` — não há `dados`
  novo pra mesclar (`classificarConversa`/a checagem de número rodam ANTES da extração), então o
  conserto certo é simplesmente não apagar o que já existia, não mesclar nada. Regressão em
  `test-pipeline.js` ("ramo inviavel"/"ramo interno: area sobrevive").
  **O bug não perdia o dado de verdade — só escondia.** Zerava `last_data` pra `{}`, mas NUNCA tocava
  `messages`: a conversa inteira continuava salva. Medido em 21/08/2026
  (`recuperar-origem-perdida.js`, regex sobre o texto das mensagens, zero chamada de IA): dos 29 deals
  com `last_action` em `('inviavel','interno')`, **12 (41%) ainda tinham o sinal de origem no texto**
  — instagram/"página do sócio", site do escritório, indicação, vídeo/Youtube. Controle: numa amostra
  de TODOS os 27 deals restantes onde o modelo já tinha examinado a conversa e concluído "Não
  identificado" (sem o bug), só **2 (7%)** tinham sinal real que o modelo deixou passar — o GAP
  REAL de reconhecimento do modelo, bem menor que o do bug. Um deles era inequívoco: a equipe
  perguntou "Você pode nos contar como conheceu o nosso escritório? 1.Indicação 2.Artigo 3.Instagram
  4.Youtube" e o cliente respondeu "verifiquei no instagram" (deal 48317782) — o modelo não usou a
  resposta. "Muitos deals sem origem" no CRM ainda é majoritariamente da base fora do bot (Moskit
  Boost), mas a fatia do próprio bot era maior do que a primeira medição sugeriu.
  **Extração determinística de origem, mesmo espírito de `derivarAdvogadoDaArea`.** A regra de
  "página/Instagram do sócio" (agora `aplicarPadroesDeterministicosDeOrigem`, extraída de dentro de
  `processarConversaDirect` pra virar testável isoladamente) tinha um bug próprio, achado no mesmo
  levantamento: comparava contra `"pagina"` **sem acento**, e o texto real do cliente quase sempre
  vem com acento ("página") — a regra nunca acionava pra essa grafia, a mais comum em português (deal
  48206716). Corrigido com `removerAcentos` no texto antes de testar. Mesma função ganhou uma regra
  nova pro "site do escritório" (deals 48412103/48359253, outro sinal claro que o modelo também
  deixava passar) — determinístico é mais confiável que esperar o modelo lembrar a cada rodada.
  `mesclarParaCrm` ganhou um fallback final: se, DEPOIS do merge com `dadosAnteriores`, a origem
  continuar vazia, força `"Nao identificado"` — nunca antes do merge (forçar em `dados` cru
  ressuscitaria o mesmo bug do 48423360, mesclando um valor forçado por cima de uma origem real de
  rodada anterior). Fecha o caso dos 3 deals de 21/08/2026 que ficaram com o campo literalmente
  ausente no CRM, não só "Não identificado". Regressão em `test-pipeline.js`
  ("aplicarPadroesDeterministicosDeOrigem").
  **Vocabulário ampliado e três frentes, 02/09/2026 — decisão do escritório: "Não identificado" pode
  continuar sendo aceito na criação (não é gate de bloqueio, ver `deveEsperarCamposObrigatorios`
  acima), mas a automação deve tentar ao MÁXIMO identificar antes disso.** `aplicarPadroesDeterministicosDeOrigem`
  só cobria Instagram (via sócio) e "site do escritório" — um subconjunto pequeno perto do que já
  era demonstrável por regex. Três frentes, todas usando o MESMO vocabulário (nenhuma duplicação):
  (1) **mais padrões deterministicos** — JusBrasil, Youtube, Instagram genérico, Artigo/Matéria/
  Notícia, indicação de amigos/parentes/clientes, VSL-Tráfego pago, Landing Page, e "achei/pesquisei
  no Google" com contexto de busca — cada um **mais conservador** que a heurística de auditoria que
  já existia em `recuperar-origem-perdida.js` (que era pensada para revisão humana, não para forçar
  campo sem revisão): "artigo"/"matéria"/"notícia" sozinhos ficaram de fora (em conversa jurídica é
  bem mais provável ser "artigo da lei" que "artigo de blog" — só conta com verbo de consumo, "vi/li
  um artigo"), "amigo"/"parente" sozinhos também ficaram de fora (comuns sem ser sobre origem — só
  conta com indicação explícita), e "google" isolado continua de fora (mesma armadilha do convite do
  Meet). (2) **`detectarRespostaPerguntaOrigem`** — o gap real medido acima (deal 48317782) vira regra
  determinística: reconhece a pergunta da equipe ("como você conheceu...") e usa a resposta
  IMEDIATAMENTE seguinte do cliente, sem depender do modelo lembrar a cada rodada. Chamada **antes**
  dos padrões genéricos (mais específico primeiro) e o texto dos padrões genéricos passou a
  considerar **só as mensagens do cliente** — sem essa restrição, a própria pergunta da equipe
  listando as opções ("1.Indicação 2.Artigo 3.Instagram 4.Youtube") acionaria o padrão de Instagram
  antes mesmo de o cliente responder qualquer coisa. (3) **regra 2 do prompt reforçada** com os
  exemplos que faltavam (JusBrasil, Artigo, VSL, Landing Page) e a instrução explícita de que "Não
  identificado" só é aceitável quando a conversa REALMENTE não tem nenhum sinal, nunca por não ter
  procurado — ganho esperado pequeno (o gap medido do modelo já era só 7% quando ele processa a
  conversa inteira), mas soma com as duas camadas de código acima. **`recuperar-origem-perdida.js`
  ganhou `--aplicar`** (ver "Scripts manuais" acima) para corrigir o histórico com a MESMA função que
  passou a rodar em produção. Regressão em `test-pipeline.js` ("vocabulario ampliado" e
  "detectarRespostaPerguntaOrigem", incluindo os quatro casos de falso-positivo evitado).
  **`PUT /deals/{id}` tem que reenviar `activities`, senão o Moskit recusa o negócio inteiro.** MEDIDO
  em 19/08/2026 no deal 48441223: o PUT é *full replace*, e **omitir** `activities` significa para o
  Moskit "desvincule estas atividades" — o que ele recusa quando alguma já foi concluída, devolvendo
  `422 {"messageError":"Completed activity cannot be updated","field":"oldActivities"}`. O campo
  `oldActivities` não existe em nenhum payload nosso: é o nome interno com que ele compara o corpo
  recebido contra o estado atual. Experimento controlado (mesmo payload, só trocando a presença do
  campo): **422 sem, 200 com**. O sintoma em produção: a consulta de 13/08 foi marcada concluída na
  mão em 17/08 e, a partir dali, **toda** atualização daquele negócio falhou — o chat 553799437737
  queimou as 3 tentativas da fila e foi descartado em silêncio. Não é caso raro: consulta concluída é
  o caminho **normal** de sucesso, então o defeito atingia justamente os negócios bem atendidos.
  `putDealComVerificacao` nunca sofreu disso porque envia o corpo do `GET` inteiro;
  `atualizarNegocioMoskit` monta o payload do zero e por isso precisa preservar o campo à mão, como já
  fazia com `name` e `stage`. Regressão em `test-pipeline.js`.
  **`status`, `closeDate` e `lostReason` também são preservados do `GET`, e por isso um PUT de campos
  não reabre negócio fechado.** `montarPayloadMoskit` sempre monta `status: 'OPEN'` (é o payload de
  criação), e como o PUT é full replace, qualquer atualização de campo num negócio GANHO o devolvia para
  aberto e apagava `closeDate`/`lostReason` — atingindo justamente os negócios bem atendidos, que são os
  que ficam fechados. O caminho mais provável de disparar isso é o cliente antigo voltando a escrever
  (ver "Cliente que volta"). Fechar e reabrir é decisão exclusiva de `fecharNegocioSeAplicavel`, que já
  se recusa a tocar em deal fora de `OPEN`: o caminho de campos não podia fazer pelas costas o que a
  função de fechamento se proíbe de fazer. Regressão em `test-pipeline.js` (GANHO, PERDIDO e o caminho
  comum de negócio aberto).
  **Rate limit: 6 req/s e 240/min** (documentado em "Limite de requisições"), com headers
  `X-RateLimit-Remaining-Second`/`-Minute` que **nenhum código nosso lê ainda**. O 429 aparece com
  facilidade — bastaram três requisições quase simultâneas numa sondagem de leitura. É por isso que
  toda varredura tem pausa entre itens (`VINCULO_PAUSA_MS`, `SYNC_ATIVIDADES_PAUSA_MS`,
  `NOTAS_ANEXO_PAUSA_MS`).
  **Autoria dos campos personalizados**: o bot guarda em `custom_fields_bot` o último valor que ele
  mesmo escreveu; se o CRM divergir disso, alguém corrigiu na mão — o campo entra em
  `campos_travados` e o bot nunca mais o sobrescreve (`filtrarCamposPorAutoria`). `TIPO_CONSULTA`
  fica de fora: nele quem manda é o checkpoint do bloco de condições.
  **Rede instável não é prova de "não existe" — tratar como se fosse duplicava contato e deal.**
  MEDIDO em 24/08/2026 (`estudar-deals-duplicados.js --sondar-crm --so-bot`): 14 dos 102 deals que o
  bot já criou desde 23/07/2026 formavam pares duplicados — mesmo telefone, dois `contacts.id`
  diferentes no Moskit —, 8 deles concentrados no dia 10/08/2026, quando o auto-deploy foi testado com
  vários `pm2 restart` em sequência (o cenário que faz o Moskit devolver 429 sob rajada de
  reprocessamento). Duas funções tratavam falha de busca como "não existe, pode criar":
  `buscarOuCriarContato` (`index.js`) — um `break` silencioso em qualquer status fora de 200-299 (o
  `validateStatus: s<500` faz o axios devolver 429 como resposta normal, **não** como exceção — nem
  passava pelo `catch`) ou qualquer exceção de rede caíam direto no `POST /contacts`, criando um
  SEGUNDO contato para o mesmo telefone. `buscarDealPorContato` tinha o mesmo defeito **mais** um bug
  de paginação (`params:{page:1}` sem `limit` — a API ignora esse parâmetro em silêncio e sempre
  devolve os ~10 deals mais recentes de TODA a conta, não do contato). Agora as duas lançam em vez de
  concluir "não existe" numa falha (mesmo raciocínio de `garantirDealExiste`, que já fazia isso para
  deal por id), e só uma paginação que chega ao FIM DE VERDADE da lista (página incompleta / sem token
  de próxima página) autoriza criar. `buscarDealPorContato` também passou a paginar `/deals` de
  verdade por `?start=` (`MAX_PAGINAS_BUSCA_DEAL`, padrão 20 páginas = 200 deals mais recentes — a
  conta inteira, 3000+, é impraticável dentro de um ciclo síncrono de mensagem) e a ler `contacts[]`
  direto da própria listagem (confirmado que já vem populado), eliminando o GET extra por deal que
  existia antes. Regressão em `test-pipeline.js` ("buscarOuCriarContato: falha na busca..." e
  "buscarDealPorContato: pagina de verdade..."). Os 14 pares já criados continuam duplicados no CRM —
  correção de código não desfaz o que já aconteceu; religar/mesclar é trabalho manual da equipe.
  **A SEGUNDA causa de contato duplicado, achada em 03/09/2026: o telefone era comparado INTEIRO, e o
  mesmo número com e sem DDI não casava.** A correção de 24/08 tratou "rede instável ≠ contato novo";
  esta trata "formato diferente ≠ pessoa diferente". `buscarOuCriarContato` usava
  `phoneDigits.slice(-13)` como chave do espelho e `.includes(phoneDigits)` na busca da API — e
  `.includes` só casa quando o número SALVO é igual ou mais longo que o buscado. Um lead que já
  existia no Moskit Boost gravado em formato local (`8694751616`) nunca casava com o número que chega
  do WhatsApp (`558694751616`): virava contato novo + deal duplicado, toda vez. MEDIDO: na aba
  "Agendamento de Consulta", **46 dos 87 negócios abertos tinham outro negócio no mesmo telefone pelos
  últimos 8 dígitos, contra 20 pela comparação inteira** — e os 8 pares que sobreviveram à checagem
  manual eram todos "lead antigo do Boost + deal que o bot criou sem reconhecê-lo". Achado por acaso:
  um par (Jéssica) que a primeira análise classificou como "telefone diferente" era `558694751616` x
  `8694751616`. **A comparação certa já existia no projeto e não era usada aqui**: `mesmoTelefone`
  (`src/telefone.js`) compara os últimos `SUFIXO_COMPARACAO` (8) dígitos, e o comentário dela diz
  literalmente "sobrevivem a diferenças de DDI/nono dígito" — é a mesma regra que `ehInterno` usa pra
  decidir se um número é da equipe. Duas respostas diferentes para "esses dois telefones são a mesma
  pessoa?" dependendo do caminho de código é exatamente o que `src/moskit-ids.js` existe pra evitar.
  Agora: a busca na API usa `mesmoTelefone`, e o espelho local tenta a chave exata primeiro (índice da
  PK) e só então um fallback por sufixo — que **desiste quando é ambíguo**, porque dois contatos
  diferentes com o mesmo sufixo não elegem vencedor por palpite (mesmo "candidato único ou nada" de
  `decidirDeal`); nesse caso segue para a busca na API, que sabe desempatar. A chave da tabela
  continua sendo `slice(-13)` de propósito: `moskit_contacts.phone` é PRIMARY KEY e já tem ~4k linhas
  gravadas nesse formato — trocar o formato exigiria migração sem ganho nenhum, já que o fallback
  cobre o caso. Regressões em `test-pipeline.js` ("mesmo telefone com e sem DDI e o MESMO cliente":
  espelho, ambiguidade e busca na API).
- **Google Calendar**: OAuth2 com conta real do escritório (`autorizar-google.js`, roda uma vez,
  interativo) — necessário para gerar link de Meet e convidar participantes por e-mail.
- **Telegram**: notifica comprovantes recebidos e conversas descartadas da fila após
  `MAX_TENTATIVAS` falhas.
  **O `parse_mode: 'Markdown'` é uma tentativa, não um requisito.** MEDIDO em 19/08/2026: `400` do
  Telegram repetido nos logs de produção. Basta o texto interpolar um nome de arquivo com `_`
  desbalanceado — e comprovante de WhatsApp se chama `comprovante_pix_18.pdf` — para o Telegram
  recusar a **mensagem inteira**. O aviso de comprovante recebido, que é o único jeito de o escritório
  saber que o cliente pagou, sumia em silêncio. `enviarTelegram` agora reenvia sem formatação quando
  o erro é `400`; `401`/`403` (token errado, bot bloqueado) **não** são reenviados, porque tirar o
  Markdown não conserta credencial. Regressão em `test-pipeline.js`.
- **Download de anexo do WhatsApp** (`baixarParaArquivo`): valida a URL **antes** do axios e o log
  identifica o **host** (nunca a URL inteira — é mídia de cliente), o status e **qual credencial foi
  usada**. Foi esse log que fechou o caso dos `401`.
  **A causa raiz era o esquema de autenticação, e o sintoma era mudo.** MEDIDO em 19/08/2026 contra a
  API real, mesma rota e mesma chave, só trocando o header: `Authorization: Bearer` responde **200** e
  `apikey` responde **401**. `baixarParaArquivo` era a **única** chamada ao Zernio do arquivo inteiro
  que mandava `apikey` — `sincronizarConversas` e a leitura de mensagens sempre usaram Bearer, e por
  isso nunca falharam, o que fazia a chave parecer boa. Efeito medido em produção: 113 erros no log e
  **nenhum comprovante verificado desde 24/07** (o último registro em `comprovantes`). A foto do PIX
  nunca chegava na IA de visão, então o negócio não avançava para "Consulta agendada" e o Telegram não
  avisava que o cliente pagou; áudio do cliente cai no mesmo caminho e também parou de ser transcrito.
  Nada disso aparecia como erro de negócio — só como uma linha de log sem host.
  **A credencial só vai para o próprio Zernio** (`montarHeadersAnexo`/`ehHostZernio`). A URL vem do
  webhook, e link assinado de CDN (Meta) não precisa de auth: mandar a chave do escritório para um host
  de terceiro é vazamento de credencial — e era o que o código fazia, para qualquer URL que chegasse.
  A comparação é por hostname exato ou sufixo **com ponto**, porque `endsWith('zernio.com')` ingênuo
  entregaria a chave para `malzernio.com` (tem regressão). Daqui para a frente, `401`/`403` em host do
  Zernio significa chave inválida de verdade; em CDN de terceiro, link expirado.
  **E a URL da mídia vem RELATIVA.** MEDIDO no mesmo dia: 9 de 9 anexos das conversas recentes
  chegaram como `/api/v1/whatsapp/media/<id>?accountId=...`. `new URL()` recusa isso, então o
  download morria em "Anexo com URL inválida" **antes** de tocar a rede — por isso
  `sincronizarConversas`, que é a rede de segurança para o que o webhook perde, nunca baixou nada.
  Os dois caminhos estavam quebrados por motivos diferentes, com o mesmo sintoma de "nada acontece":
  o webhook entrega a mídia absoluta e caía no 401; o polling entrega relativa e caía no parse.
  `resolverUrlAnexo` resolve **apenas** caminho que começa em `/api/` contra `https://zernio.com` —
  resolver qualquer string contra a base transformaria lixo em requisição, e `"/caminho/local"` e
  `"nao-e-url"` continuam recusados sem tocar a rede. Regressões em `test-pipeline.js`.

## Environment

Ver `.env.example` para a lista completa e comentada. Sem process manager configurado (pm2/systemd/
Docker) — supervisionar o processo em produção é responsabilidade de quem faz o deploy. Em dev,
exponha a porta local com ngrok ou `node start-lt.js` (localtunnel).
