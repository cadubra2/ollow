// Testes de montarPayloadMoskit — o que efetivamente vira negocio no CRM. Rodar com:
//   node test-payload.js
//
// Carrega index.js, entao precisa de DB_PATH (banco descartavel) e WORKER_MODE=1 (nao sobe servidor,
// ngrok, timers, nem reprocessa as conversas pendentes). Nenhuma chamada de rede: montarPayloadMoskit
// e pura.
//
// O caso central e o CHECKPOINT DE COBRANCA: o bloco de condicoes de valor e o unico fato que decide
// paga x cortesia, porque o atendente nunca declara gratuidade — ele so deixa subentendido.

const fs = require('fs');
const { dirTemporario } = require('./test-utils');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = dirTemporario('payload');
process.env.DB_PATH = path.join(DIR, 'teste.db');
process.env.WORKER_MODE = '1';

const { montarPayloadMoskit } = require('./index');
const IDS = require('./src/moskit-ids');

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

// Le a opcao gravada num campo personalizado do payload (undefined se o campo nem entrou no array).
const opcaoDe = (payload, cfId) => payload.entityCustomFields.find((c) => c.id === cfId)?.options?.[0];

const CONTATO = 12345;
const BASE = { nome: 'Fulano de Tal', assunto: 'Inventario', tipo_consulta: 'consulta paga' };
const montar = (dados, opcoes) => montarPayloadMoskit({ ...BASE, ...dados }, CONTATO, opcoes);

console.log('\n=== CHECKPOINT DE COBRANCA (paga x cortesia) ===');

{
  // Nunca recebeu o bloco de R$350 => cortesia, mesmo que a IA tenha achado que era paga.
  const p = montar({ tipo_consulta: 'consulta paga' }, { condicoesValorEnviadas: false });
  igual('bloco NUNCA enviado → price 0', p.price, 0);
  igual('bloco NUNCA enviado → tipo forcado para GRATIS', opcaoDe(p, IDS.CF.TIPO_CONSULTA), IDS.TIPO_CONSULTA_GRATIS_ID);
  checar('   ...ignorando o "consulta paga" que veio da IA', opcaoDe(p, IDS.CF.TIPO_CONSULTA) !== IDS.TIPO_CONSULTA_PAGA_ID);
}

{
  const p = montar({ tipo_consulta: 'consulta paga' }, { condicoesValorEnviadas: true });
  igual('bloco enviado → price 35000', p.price, 35000);
  igual('bloco enviado → tipo vem da IA (paga)', opcaoDe(p, IDS.CF.TIPO_CONSULTA), IDS.TIPO_CONSULTA_PAGA_ID);
}

{
  // Sem as mensagens nao da pra afirmar cortesia. Errar para PAGA custa uma conversa de cobranca;
  // errar para GRATIS entrega uma consulta de R$350 de graca. O padrao seguro e paga.
  const p = montar({}, { condicoesValorEnviadas: undefined });
  igual('condicoesValorEnviadas undefined → PAGA (padrao seguro)', p.price, 35000);
}
igual('opcoes {} → PAGA', montar({}, {}).price, 35000);
igual('opcoes omitido → PAGA', montarPayloadMoskit(BASE, CONTATO).price, 35000);

{
  // Regressao: o literal 35000 estava escrito aqui e tambem na conferencia do comprovante. Mudar o
  // valor no .env fazia os dois discordarem em silencio.
  const saida = execFileSync(
    process.execPath,
    ['-e', "const {montarPayloadMoskit}=require('./index');console.log('PRICE:'+montarPayloadMoskit({nome:'X'},1,{condicoesValorEnviadas:true}).price)"],
    {
      cwd: __dirname, encoding: 'utf8',
      env: { ...process.env, COMPROVANTE_VALOR_ESPERADO_CENTAVOS: '12345', DB_PATH: path.join(DIR, 'sub.db') },
    }
  );
  checar('price acompanha o .env, nao um literal', saida.includes('PRICE:12345'), saida.trim().split('\n').pop());
}

console.log('\n=== Mapeamento de opcoes ===');

igual('Direito Empresarial → 228787 (nao "outros")', opcaoDe(montar({ area_direito: 'Direito Empresarial' }), IDS.CF.AREA_DIREITO), 228787);
igual('"Direito Médico" com acento → 577809', opcaoDe(montar({ area_direito: 'Direito Médico' }), IDS.CF.AREA_DIREITO), 577809);
igual('"Direito da Saúde" (alias) → 577809', opcaoDe(montar({ area_direito: 'Direito da Saúde' }), IDS.CF.AREA_DIREITO), 577809);
igual('LGPD em maiuscula → 228786', opcaoDe(montar({ area_direito: 'LGPD' }), IDS.CF.AREA_DIREITO), 228786);
igual('origem Instagram', opcaoDe(montar({ origem: 'Instagram' }), IDS.CF.ORIGEM), 200152);
igual('captacao Bruno', opcaoDe(montar({ captacao: 'Bruno' }), IDS.CF.CAPTACAO), 200155);
igual('responsavel Iury', opcaoDe(montar({ advogado_responsavel: 'Iury' }), IDS.CF.RESPONSAVEL), 228790);

igual('area desconhecida nao entra no payload', opcaoDe(montar({ area_direito: 'direito espacial' }), IDS.CF.AREA_DIREITO), undefined);
igual('origem ausente nao entra no payload', opcaoDe(montar({ origem: null }), IDS.CF.ORIGEM), undefined);
igual('campo vazio nao entra no payload', opcaoDe(montar({ captacao: '' }), IDS.CF.CAPTACAO), undefined);

console.log('\n=== CARACTERIZACAO: buscarIdOpcao casa por substring nos dois sentidos ===');
// Nao e o comportamento desejado, mas e o atual. Registrado para que uma mudanca seja deliberada.
// O primeiro caso tem consequencia financeira: um "consulta" vago da IA vira R$0 no CRM.
igual(
  'tipo_consulta "consulta" (vago) → GRATIS — vira R$0 no CRM',
  opcaoDe(montar({ tipo_consulta: 'consulta' }, { condicoesValorEnviadas: true }), IDS.CF.TIPO_CONSULTA),
  IDS.TIPO_CONSULTA_GRATIS_ID
);
igual(
  'area_direito "direito" (vago) → direito administrativo',
  opcaoDe(montar({ area_direito: 'direito' }), IDS.CF.AREA_DIREITO),
  228779
);
// ...mas o PRICE nao se deixa enganar: quem manda nele e o checkpoint, nao o texto da IA.
igual('   ...ainda assim o price continua 35000 (o checkpoint manda)', montar({ tipo_consulta: 'consulta' }, { condicoesValorEnviadas: true }).price, 35000);

console.log('\n=== Nome do deal ===');

igual('nome + assunto', montar({}).name, 'Fulano de Tal - Inventario');
igual('assunto vazio → so o nome, sem " - "', montar({ assunto: '' }).name, 'Fulano de Tal');
igual('assunto null → so o nome', montar({ assunto: null }).name, 'Fulano de Tal');
igual('nome vazio → "Cliente sem nome"', montar({ nome: '', assunto: '' }).name, 'Cliente sem nome');
igual('nome vazio com assunto', montar({ nome: null }).name, 'Cliente sem nome - Inventario');
igual('emoji removido do nome', montar({ nome: '😀 Fulano', assunto: '' }).name, 'Fulano');
igual('emoji removido do assunto', montar({ assunto: 'Inventario 🏠' }).name, 'Fulano de Tal - Inventario');
igual('so emoji no nome → "Cliente sem nome"', montar({ nome: '😀', assunto: '' }).name, 'Cliente sem nome');

console.log('\n=== Estrutura fixa do payload ===');

{
  const p = montar({});
  igual('status', p.status, 'OPEN');
  igual('stage.id vem do .env, como Number', p.stage.id, Number(process.env.MOSKIT_STAGE_ID));
  checar('stage.id nao e NaN', !Number.isNaN(p.stage.id));
  igual('createdBy = Layla', p.createdBy.id, IDS.LAYLA_USER_ID);
  igual('responsible = Layla', p.responsible.id, IDS.LAYLA_USER_ID);
  igual('contacts', JSON.stringify(p.contacts), JSON.stringify([{ id: CONTATO }]));
  igual('1 produto', p.dealProducts.length, 1);
  igual('produto = consulta paga', p.dealProducts[0].product.id, IDS.PRODUTO_CONSULTA_PAGA_ID);
  checar('precos do produto zerados (o valor vive em deal.price)',
    p.dealProducts[0].price === 0 && p.dealProducts[0].initialPrice === 0 && p.dealProducts[0].finalPrice === 0);
  checar('entityCustomFields e array', Array.isArray(p.entityCustomFields));
}

{
  const p = montar({ origem: 'Instagram', captacao: 'Bruno', area_direito: 'LGPD', advogado_responsavel: 'Iury' });
  igual('5 campos personalizados quando tudo esta preenchido', p.entityCustomFields.length, 5);
  igual('nenhum campo repetido', new Set(p.entityCustomFields.map((c) => c.id)).size, 5);
  checar('toda opcao e um array de 1 id', p.entityCustomFields.every((c) => Array.isArray(c.options) && c.options.length === 1));
}

igual('dados vazios nao derrubam a montagem', montarPayloadMoskit({}, CONTATO, {}).name, 'Cliente sem nome');


console.log(`\n${'='.repeat(50)}`);
console.log(`${passou} passaram · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
