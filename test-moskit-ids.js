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
// Estavam presentes em apenas 2 das 6 copias; nas outras, "Direito Medico" caia em null.
for (const alias of ['solucoes medicas', 'direito medico e da saude', 'direito da saude', 'direito medico']) {
  igual(`'${alias}' → 577809`, AREA_DIREITO[alias], 577809);
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
// Duas chaves com o mesmo ID so e legitimo quando sao alias declarado. Em AREA_DIREITO os 4 aliases
// medicos colapsam em 1 valor: 14 chaves, 11 valores distintos.
igual('AREA_DIREITO tem 14 chaves', Object.keys(AREA_DIREITO).length, 14);
igual('AREA_DIREITO tem 11 valores distintos', new Set(Object.values(AREA_DIREITO)).size, 11);

for (const nome of ['ORIGEM', 'TIPO_CONSULTA', 'CAPTACAO', 'RESPONSAVEL_PROCESSO']) {
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

  checar('LOST_REASON_PADRAO_ID aponta pra um motivo existente na tabela',
    Object.values(LOST_REASON).includes(LOST_REASON_PADRAO_ID), LOST_REASON_PADRAO_ID);
}

// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
