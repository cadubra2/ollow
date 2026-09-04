// Invariantes de src/moskit-ids.js. Puro, sem rede. Rodar com:
//   node test-moskit-ids.js
//
// Este modulo nasceu porque as tabelas de ID estavam copiadas em SEIS arquivos e ja tinham divergido:
// 'direito empresarial' apontava para 235234 ("outros") em testar-briefing-unico.js, que escreve deal
// de verdade no CRM. Um ID errado aqui nao quebra nada em tempo de execucao — ele grava dado errado
// no CRM em silencio. Por isso o teste e de invariante, e nao de comportamento.

require('dotenv').config();

const IDS = require('./src/moskit-ids');
const {
  CF, ORIGEM, TIPO_CONSULTA, CAPTACAO, AREA_DIREITO, RESPONSAVEL_PROCESSO,
  LAYLA_USER_ID, PRODUTO_CONSULTA_PAGA_ID, ATIVIDADE_TIPOS_CONSULTA,
  TIPO_CONSULTA_GRATIS_ID, TIPO_CONSULTA_PAGA_ID,
  STATUS_DEAL, LOST_REASON, LOST_REASON_PADRAO_ID,
} = IDS;

let passou = 0;
let falhou = 0;

function checar(nome, condicao, detalhe) {
  if (condicao) {
    passou++;
    console.log(`  ✅ ${nome}`);
  } else {
    falhou++;
    console.log(`  ❌ ${nome}${detalhe !== undefined ? ` — obtido: ${JSON.stringify(detalhe)}` : ''}`);
  }
}

const igual = (nome, obtido, esperado) => checar(nome, obtido === esperado, obtido);

const TABELAS = { ORIGEM, TIPO_CONSULTA, CAPTACAO, AREA_DIREITO, RESPONSAVEL_PROCESSO };

// ============================================================
console.log('\n=== Regressao do bug de origem ===');
// O ID que gravou deal errado no CRM.
igual("'direito empresarial' aponta para 228787", AREA_DIREITO['direito empresarial'], 228787);
checar(
  "'direito empresarial' NAO e o mesmo que 'outros'",
  AREA_DIREITO['direito empresarial'] !== AREA_DIREITO['outros']
);

console.log('\n=== Aliases de Direito Medico ===');
// Estavam presentes em apenas 2 das 6 copias; nas outras, "Direito Medico" caia em null. Hoje vivem em
// APELIDOS e sao resolvidos pelo INDICE_BUSCA — as tabelas canonicas tem uma chave por opcao.
igual("'solucoes medicas' e a chave canonica", AREA_DIREITO['solucoes medicas'], 577809);
for (const alias of ['direito medico e da saude', 'direito da saude', 'direito medico', 'Direito Médico', 'DIREITO MEDICO']) {
  igual(`'${alias}' → 577809 pelo indice`, IDS.INDICE_BUSCA.AREA_DIREITO[IDS.normalizarChave(alias)], 577809);
}

// ============================================================
console.log('\n=== Formato dos IDs ===');

for (const [nome, tabela] of Object.entries(TABELAS)) {
  const ruins = Object.entries(tabela).filter(([, v]) => !Number.isInteger(v) || v <= 0);
  checar(`${nome}: todo valor e inteiro positivo`, ruins.length === 0, ruins);
}

igual('LAYLA_USER_ID', LAYLA_USER_ID, 90607);
checar('PRODUTO_CONSULTA_PAGA_ID e inteiro positivo', Number.isInteger(PRODUTO_CONSULTA_PAGA_ID) && PRODUTO_CONSULTA_PAGA_ID > 0);

// ============================================================
console.log('\n=== Chaves compativeis com buscarIdOpcao ===');
// buscarIdOpcao (index.js:309) normaliza a ENTRADA com toLowerCase + removerAcentos, mas a busca
// rapida e `mapeamento[normalizado]` — igualdade exata contra a chave CRUA. Uma chave com maiuscula
// so seria alcancada pelo laco de substring, por acaso. Toda chave precisa ser lowercase.
for (const [nome, tabela] of Object.entries(TABELAS)) {
  const maiusculas = Object.keys(tabela).filter((k) => k !== k.toLowerCase());
  checar(`${nome}: nenhuma chave com maiuscula`, maiusculas.length === 0, maiusculas);

  const espacos = Object.keys(tabela).filter((k) => k !== k.trim());
  checar(`${nome}: nenhuma chave com espaco nas pontas`, espacos.length === 0, espacos);
}

// ============================================================
console.log('\n=== Duplicatas dentro das tabelas ===');
// Agora as tabelas canonicas tem UMA chave por opcao do CRM (os apelidos foram para APELIDOS), entao a
// invariante "nenhum ID repetido" vale para AREA_DIREITO tambem — e ela e o que pega duas areas
// diferentes apontando para o mesmo ID por engano, que foi o bug do 'direito empresarial' → 'outros'.
igual('AREA_DIREITO tem 11 chaves canonicas', Object.keys(AREA_DIREITO).length, 11);
igual('AREA_DIREITO tem 11 valores distintos', new Set(Object.values(AREA_DIREITO)).size, 11);

for (const nome of ['ORIGEM', 'TIPO_CONSULTA', 'CAPTACAO', 'AREA_DIREITO', 'RESPONSAVEL_PROCESSO']) {
  const t = TABELAS[nome];
  checar(
    `${nome}: nenhum ID repetido`,
    new Set(Object.values(t)).size === Object.keys(t).length,
    Object.keys(t).length - new Set(Object.values(t)).size
  );
}

// ============================================================
console.log('\n=== Tipo de consulta (o eixo da cobranca) ===');

igual('TIPO_CONSULTA_GRATIS_ID', TIPO_CONSULTA_GRATIS_ID, 217250);
igual('TIPO_CONSULTA_PAGA_ID', TIPO_CONSULTA_PAGA_ID, 217251);
checar('gratis !== paga', TIPO_CONSULTA_GRATIS_ID !== TIPO_CONSULTA_PAGA_ID);
checar("nenhuma delas e 'sem consulta'", ![TIPO_CONSULTA_GRATIS_ID, TIPO_CONSULTA_PAGA_ID].includes(TIPO_CONSULTA['sem consulta']));
igual('os atalhos batem com a tabela (gratis)', TIPO_CONSULTA_GRATIS_ID, TIPO_CONSULTA['consulta gratis']);
igual('os atalhos batem com a tabela (paga)', TIPO_CONSULTA_PAGA_ID, TIPO_CONSULTA['consulta paga']);

// ============================================================
console.log('\n=== Apelidos e indice de busca ===');
// A busca de opcao passou a exigir correspondencia exata (12/08/2026). O que segura os valores que a IA
// escreve de outro jeito ("Dr. Berto", "familia", "Indicacao de amigos e parentes") sao os APELIDOS —
// se um deles apontar para uma chave que nao existe, o campo volta a ficar vazio em silencio.
for (const [tabela, apelidos] of Object.entries(IDS.APELIDOS)) {
  const orfaos = Object.entries(apelidos).filter(([, canonica]) => IDS[tabela][canonica] === undefined);
  checar(`APELIDOS.${tabela}: todo apelido aponta para chave canonica existente`, orfaos.length === 0, orfaos);

  const naoNormalizados = Object.keys(apelidos).filter((k) => k !== IDS.normalizarChave(k));
  checar(`APELIDOS.${tabela}: chaves ja normalizadas`, naoNormalizados.length === 0, naoNormalizados);

  const colidindo = Object.keys(apelidos).filter((k) => IDS[tabela][k] !== undefined);
  checar(`APELIDOS.${tabela}: nenhum apelido duplica chave canonica`, colidindo.length === 0, colidindo);
}
for (const [tabela, indice] of Object.entries(IDS.INDICE_BUSCA)) {
  const canonicasFora = Object.keys(IDS[tabela]).filter((k) => indice[IDS.normalizarChave(k)] !== IDS[tabela][k]);
  checar(`INDICE_BUSCA.${tabela}: contem todas as canonicas`, canonicasFora.length === 0, canonicasFora);
}
// Regressoes das armadilhas concretas do casamento por substring que existia antes.
igual('"Indicacao" (vago) NAO resolve para nenhuma origem', IDS.INDICE_BUSCA.ORIGEM[IDS.normalizarChave('Indicação')], undefined);
igual('"direito" (vago) NAO resolve para nenhuma area', IDS.INDICE_BUSCA.AREA_DIREITO[IDS.normalizarChave('direito')], undefined);
igual('"consulta" (vago) NAO resolve para tipo de consulta', IDS.INDICE_BUSCA.TIPO_CONSULTA[IDS.normalizarChave('consulta')], undefined);
igual('"Indicacao de amigos e parentes" resolve (grafia do exemplo do prompt)', IDS.INDICE_BUSCA.ORIGEM[IDS.normalizarChave('Indicação de amigos e parentes')], ORIGEM['indicacao de/ou amigos e parentes']);
igual('"Dr. Berto" resolve para o responsavel Berto', IDS.INDICE_BUSCA.RESPONSAVEL_PROCESSO[IDS.normalizarChave('Dr. Berto')], RESPONSAVEL_PROCESSO['berto']);
igual('"Direito Digital" resolve para LGPD', IDS.INDICE_BUSCA.AREA_DIREITO[IDS.normalizarChave('Direito Digital')], AREA_DIREITO['lgpd']);

// ============================================================
console.log('\n=== Area -> advogado (regra do escritorio) ===');
// A area DEFINE o responsavel; antes quem escolhia era o modelo. Aqui garantimos que a tabela cobre as
// areas com dono, aponta so para advogado que existe, e que "Outros" continua sem dono automatico.
{
  const ESPERADO = {
    'direito administrativo': 'Berto',
    'lgpd': 'Berto',
    'direito imobiliario': 'Bruno',
    'direito de familia': 'Bruno',
    'direito empresarial': 'Bruno',
    'solucoes medicas': 'Iury',
    'direito educacional': 'Iury',
    'direito previdenciario': 'Iury',
    'direito do consumidor': 'Iury',
    'direito do trabalho': 'Iury',
  };
  for (const [area, advogado] of Object.entries(ESPERADO)) {
    igual(`${area} → ${advogado}`, IDS.ADVOGADO_POR_AREA_ID[AREA_DIREITO[area]], advogado);
  }
  igual('"outros" NAO tem responsavel automatico', IDS.ADVOGADO_POR_AREA_ID[AREA_DIREITO['outros']], undefined);
  igual('a tabela cobre 10 das 11 areas', Object.keys(IDS.ADVOGADO_POR_AREA_ID).length, 10);

  const semResponsavel = Object.values(IDS.ADVOGADO_POR_AREA_ID)
    .filter((adv) => RESPONSAVEL_PROCESSO[IDS.normalizarChave(adv)] === undefined);
  checar('todo advogado da tabela existe em RESPONSAVEL_PROCESSO', semResponsavel.length === 0, semResponsavel);

  const idsInvalidos = Object.keys(IDS.ADVOGADO_POR_AREA_ID)
    .filter((id) => !Object.values(AREA_DIREITO).map(String).includes(String(id)));
  checar('toda chave e um ID de area existente', idsInvalidos.length === 0, idsInvalidos);
}

// ============================================================
console.log('\n=== Campos personalizados ===');

igual('CF tem 5 campos', Object.keys(CF).length, 5);
checar('todo CF comeca com CF_', Object.values(CF).every((v) => typeof v === 'string' && v.startsWith('CF_')));
igual('nenhum CF repetido', new Set(Object.values(CF)).size, 5);
for (const nome of ['TIPO_CONSULTA', 'ORIGEM', 'CAPTACAO', 'AREA_DIREITO', 'RESPONSAVEL']) {
  checar(`CF.${nome} existe`, typeof CF[nome] === 'string' && CF[nome].length > 3);
}

// ============================================================
console.log('\n=== Tipos de atividade que viram evento ===');

checar('ATIVIDADE_TIPOS_CONSULTA e um Set', ATIVIDADE_TIPOS_CONSULTA instanceof Set);
igual('tem 2 tipos', ATIVIDADE_TIPOS_CONSULTA.size, 2);
checar('87134 (Reuniao)', ATIVIDADE_TIPOS_CONSULTA.has(87134));
checar('87361 (Videoconferencia)', ATIVIDADE_TIPOS_CONSULTA.has(87361));
checar('Ligacao/Email/WhatsApp NAO viram evento', !ATIVIDADE_TIPOS_CONSULTA.has(0));

// ============================================================
console.log('\n=== Coerencia com o .env (estagios do funil) ===');
// moverEstagioSeAvancar faz Object.values(MOSKIT_STAGE_MAP).find(s => s.id === atual). Dois estagios
// com o mesmo id fariam o find devolver o errado — em silencio, e o bot moveria o deal para tras.
{
  const CHAVES = [
    'MOSKIT_STAGE_ID',
    'MOSKIT_STAGE_CONSULTA_AGENDADA',
    'MOSKIT_STAGE_AGUARDANDO_CONDICAO',
    'MOSKIT_STAGE_ELABORACAO_PROPOSTA',
    'MOSKIT_STAGE_NEGOCIACAO',
    'MOSKIT_STAGE_ELABORACAO_CONTRATO',
    'MOSKIT_STAGE_CONTRATO_ENVIADO',
  ];
  const faltando = CHAVES.filter((k) => !process.env[k]);
  checar('os 7 estagios estao no .env', faltando.length === 0, faltando);

  const naoNumericos = CHAVES.filter((k) => process.env[k] && !/^\d+$/.test(process.env[k]));
  checar('todos numericos', naoNumericos.length === 0, naoNumericos);

  const valores = CHAVES.map((k) => process.env[k]).filter(Boolean);
  checar('todos distintos entre si', new Set(valores).size === valores.length, valores.length - new Set(valores).size);
}

// ============================================================
console.log('\n=== Fechamento de negocio (status WON/LOST) ===');
// Confirmado em 04/08/2026 contra a API real: o Moskit so aceita esses 3 valores para deal.status
// (qualquer outra grafia volta 422). Ver fecharNegocioSeAplicavel em index.js.
{
  igual('STATUS_DEAL tem 3 valores', Object.keys(STATUS_DEAL).length, 3);
  igual('STATUS_DEAL.OPEN', STATUS_DEAL.OPEN, 'OPEN');
  igual('STATUS_DEAL.WON', STATUS_DEAL.WON, 'WON');
  igual('STATUS_DEAL.LOST', STATUS_DEAL.LOST, 'LOST');

  const chavesMaiusculas = Object.keys(LOST_REASON).filter((k) => k !== k.toLowerCase());
  checar('LOST_REASON: nenhuma chave com maiuscula', chavesMaiusculas.length === 0, chavesMaiusculas);

  const ruins = Object.entries(LOST_REASON).filter(([, v]) => !Number.isInteger(v) || v <= 0);
  checar('LOST_REASON: todo valor e inteiro positivo', ruins.length === 0, ruins);

  checar('LOST_REASON: nenhum ID repetido (sao motivos distintos, nao aliases)',
    new Set(Object.values(LOST_REASON)).size === Object.keys(LOST_REASON).length);

  // Achado em 04/09/2026: GET /lostReasons paginado por start= devolve 11 motivos, nao 10 — o
  // "Apenas consultoria" foi cadastrado no CRM depois da medicao original e faltava aqui.
  igual('motivo "apenas consultoria" cadastrado (existe no CRM desde 2026)', LOST_REASON['apenas consultoria'], 378429);
  checar('e buscarOpcao o encontra pelo texto que a IA escreveria',
    IDS.buscarOpcao(IDS.LOST_REASON, 'Apenas consultoria') === 378429);

  checar('LOST_REASON_PADRAO_ID aponta pra um motivo existente na tabela',
    Object.values(LOST_REASON).includes(LOST_REASON_PADRAO_ID), LOST_REASON_PADRAO_ID);
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
