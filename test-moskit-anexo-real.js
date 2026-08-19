// Levanta o contrato real de /deals/{id}/attachments — a aba "Arquivos" do negocio — e responde a
// UNICA pergunta que decide se da pra anexar o Doc do Gemini no CRM:
//
//   o PDF servido pelo tunel do bot chega INTEIRO no Moskit?
//
// Por que a pergunta existe: o POST nao aceita upload. Medido na doc oficial (Ollow API V2,
// 18/08/2026) o corpo e `{"url": "..."}` em application/json — quem baixa o arquivo e o servidor do
// Moskit, a partir de uma URL que nos damos. E o tunel de producao e ngrok do plano GRATIS, que
// intercepta requisicoes e devolve uma PAGINA HTML DE AVISO em vez do conteudo. O bypass e o header
// `ngrok-skip-browser-warning`, que NAO controlamos: quem faz o GET e o Moskit.
//
// O desfecho ruim e silencioso: o POST responde 2xx, o anexo aparece na aba, e o que esta la dentro
// e um HTML de aviso com nome de PDF. Ninguem descobre lendo a tela — so abrindo o arquivo. Por isso
// este script compara mimeType, size e os primeiros bytes com o PDF original, em vez de confiar no
// status da resposta.
//
//   node test-moskit-anexo-real.js <dealId>                             # so LE: lista os anexos e a paginacao
//   node test-moskit-anexo-real.js <dealId> --aplicar --url=https://... # ESCREVE: anexa, confere e apaga
//   node test-moskit-anexo-real.js <dealId> --aplicar --subir-tunel     # idem, subindo um ngrok proprio
//   ... --manter                                                        # nao apaga o anexo no fim
//
// Use um deal de TESTE. O modo --aplicar cria um anexo real na aba Arquivos do negocio.
// NUNCA rodar em CI nem no npm test.
//
// ⚠️ POR QUE `--subir-tunel` E EXPLICITO E NAO O PADRAO: no plano gratis o ngrok aceita UMA sessao
// por conta. Se a producao (VPS) estiver usando a mesma conta, subir um tunel aqui pode DERRUBAR o
// tunel que recebe os webhooks do WhatsApp — o bot para de receber mensagem, e o sintoma aparece
// como "cliente mandou e ninguem respondeu", sem erro nenhum no log deste script. Prefira servir o
// PDF por um caminho que ja seja publico e passar --url=. Rode --subir-tunel so com a producao
// parada, ou de uma conta ngrok diferente.

require('dotenv').config();
const axios = require('axios');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const MOSKIT_BASE = process.env.MOSKIT_BASE || 'https://api.moskitcrm.com/v2';
const headers = { apikey: process.env.MOSKIT_API_KEY, 'Content-Type': 'application/json', 'X-Ollow-Origin': 'BOT_TEST' };

const dealId = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');
const MANTER = process.argv.includes('--manter');
const SUBIR_TUNEL = process.argv.includes('--subir-tunel');
const URL_FORNECIDA = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (metodo, url, corpo, extra = {}) =>
  axios({ method: metodo, url, data: corpo, headers, validateStatus: () => true, ...extra });

// ---------------------------------------------------------------------------
// O PDF da sonda
// ---------------------------------------------------------------------------
// Construido byte a byte, com xref de offsets corretos, para ser um PDF de verdade: se o Moskit
// recusar o arquivo, quero que seja por causa do transporte, nao porque mandei bytes invalidos.
function montarPdfDeSonda(carimbo) {
  const objetos = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    null, // 4: o stream, montado abaixo (precisa do /Length real)
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  const conteudo = `BT /F1 11 Tf 20 70 Td (SONDA DE ANEXO — OLLOW) Tj 0 -20 Td (${carimbo}) Tj ET\n`;
  objetos[3] = `<</Length ${Buffer.byteLength(conteudo, 'latin1')}>>\nstream\n${conteudo}endstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((corpo, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${corpo}\nendobj\n`;
  });

  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<</Size ${objetos.length + 1}/Root 1 0 R>>\nstartxref\n${inicioXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Tunel efemero: servidor local + ngrok, so pelo tempo da medicao
// ---------------------------------------------------------------------------
// Sobe um ngrok PROPRIO em vez de reusar o do bot porque o objetivo e medir o comportamento do
// plano gratis com um cliente nao-browser. Se o bot ja estiver rodando nesta maquina, o plano gratis
// recusa a segunda sessao — o script diz isso com todas as letras em vez de morrer sem explicacao.
async function subirTunel(pdf, nomeArquivo) {
  const servidor = http.createServer((reqHttp, res) => {
    console.log(`   ↳ GET ${reqHttp.url}  ua="${reqHttp.headers['user-agent'] || '(sem user-agent)'}"`);
    if (!reqHttp.url.includes(nomeArquivo)) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': `inline; filename="${nomeArquivo}"`,
    });
    res.end(pdf);
  });

  await new Promise((r) => servidor.listen(0, r));
  const porta = servidor.address().port;
  console.log(`   servidor local na porta ${porta}`);

  const binario = path.join(__dirname, 'ngrok', process.platform === 'win32' ? 'ngrok.exe' : 'ngrok');
  const proc = spawn(binario, ['http', String(porta)], { stdio: 'ignore', windowsHide: true });

  // Mesma varredura de portas do index.js: a API local do ngrok cai na 4041+ quando a 4040 ja esta
  // ocupada por outro agente, e ai leriamos o tunel errado.
  for (let i = 0; i < 25; i++) {
    await espera(1000);
    for (const apiPort of [4040, 4041, 4042, 4043, 4044, 4045]) {
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
        const data = await res.json();
        const tunel = data.tunnels?.find((t) => String(t.config?.addr || '').endsWith(`:${porta}`));
        if (tunel?.public_url) {
          console.log(`   tunel: ${tunel.public_url}  [api local :${apiPort}]`);
          return { base: tunel.public_url, encerrar: () => { try { proc.kill(); } catch {} servidor.close(); } };
        }
      } catch {}
    }
  }

  try { proc.kill(); } catch {}
  servidor.close();
  throw new Error(
    'nao consegui obter a URL do ngrok em 25s.\n' +
    '   No plano gratis so existe UMA sessao por vez — se o bot (index.js) estiver rodando nesta\n' +
    '   maquina, pare-o e rode de novo, ou passe --url=<url publica de um PDF ja servido>.'
  );
}

// ---------------------------------------------------------------------------
// Leitura: lista os anexos que ja existem
// ---------------------------------------------------------------------------
// Pagina por `start` porque e o unico parametro que a doc declara para esta rota — e porque em
// /activities foi medido que `page`, `offset` e companhia sao ignorados EM SILENCIO, devolvendo a
// primeira pagina de novo. Um loop errado aqui nao quebra: relê os mesmos 10 e parece ter varrido tudo.
async function listarAnexos(id) {
  const paginas = [];
  let vistos = 0;

  for (let p = 0; p < 20; p++) {
    const res = await req('get', `${MOSKIT_BASE}/deals/${id}/attachments`, undefined, { params: { start: vistos } });
    if (res.status < 200 || res.status >= 300) {
      console.log(`  ❌ GET /deals/${id}/attachments?start=${vistos} → HTTP ${res.status}`);
      console.log(`     corpo: ${JSON.stringify(res.data).slice(0, 400)}`);
      return { paginas, erro: res.status };
    }
    const lote = Array.isArray(res.data) ? res.data : [];
    paginas.push(lote);
    vistos += lote.length;
    if (lote.length < 10) break;
  }

  return { paginas, total: vistos };
}

async function main() {
  if (!dealId || !/^\d+$/.test(dealId)) {
    console.error('Uso: node test-moskit-anexo-real.js <dealId> [--aplicar] [--manter] [--url=https://...]');
    process.exit(1);
  }
  if (!process.env.MOSKIT_API_KEY) {
    console.error('MOSKIT_API_KEY ausente no .env (rodou a partir da raiz do projeto?)');
    process.exit(1);
  }

  console.log(`\n${APLICAR ? '⚠️  MODO ESCRITA' : '🔍 SO LEITURA'} — deal ${dealId}`);
  console.log(`   base: ${MOSKIT_BASE}\n`);

  // ── 0. Que deal e esse? Anexar no deal errado poe documento de um cliente no prontuario de outro ──
  const dealRes = await req('get', `${MOSKIT_BASE}/deals/${dealId}`);
  if (dealRes.status < 200 || dealRes.status >= 300) {
    console.error(`❌ Nao consegui ler o deal ${dealId} (HTTP ${dealRes.status}). Confira o id.`);
    process.exit(1);
  }
  console.log(`── Deal alvo ──\n  "${dealRes.data?.name}" (estagio ${dealRes.data?.stage?.id}, status ${dealRes.data?.status})\n`);

  // ── 1. O que ja esta na aba Arquivos ────────────────────────────────────────────────────────────
  console.log('── GET /deals/{id}/attachments ──');
  const { paginas, total, erro } = await listarAnexos(dealId);
  if (erro) {
    console.error('\n❌ A rota de listagem nao respondeu. Sem ela nao ha como deduplicar anexo — pare aqui.');
    process.exit(1);
  }
  console.log(`  ${total} anexo(s) em ${paginas.length} pagina(s)  [tamanhos: ${paginas.map((p) => p.length).join(', ') || '-'}]`);
  if (paginas[0]?.length) {
    console.log(`  amostra: ${JSON.stringify(paginas[0][0], null, 2).split('\n').join('\n  ')}`);
  } else {
    console.log('  (deal sem anexos — a amostra do formato virá do POST)');
  }

  if (!APLICAR) {
    console.log('\n🔍 Fim do modo leitura. Para medir o transporte do PDF, rode com --aplicar.\n');
    return;
  }

  // ── 2. O PDF e a URL publica ────────────────────────────────────────────────────────────────────
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const nomeArquivo = `sonda-anexo-${carimbo}.pdf`;
  const pdf = montarPdfDeSonda(carimbo);
  console.log(`\n── PDF da sonda ──\n  ${nomeArquivo}  ${pdf.length} bytes  inicio=${pdf.subarray(0, 5).toString('latin1')}`);

  let tunel = null;
  let urlPublica = URL_FORNECIDA;
  if (!urlPublica) {
    // Nunca sobe tunel por omissao: no plano gratis isso pode tomar a sessao da producao e derrubar
    // o webhook do WhatsApp em silencio. Quem quiser esse risco precisa pedir por escrito.
    if (!SUBIR_TUNEL) {
      console.error('\n❌ Sem --url= e sem --subir-tunel: nao ha de onde o Moskit baixar o PDF.');
      console.error('   Passe --url=<url publica de um PDF> (preferido) ou --subir-tunel.');
      console.error('   ⚠️ --subir-tunel abre uma sessao ngrok; no plano gratis so existe UMA por conta,');
      console.error('      entao ele pode derrubar o tunel de producao que recebe os webhooks do WhatsApp.');
      console.error('      Use apenas com a producao parada, ou de outra conta ngrok.');
      process.exit(1);
    }
    console.log('\n── Tunel efemero (--subir-tunel) ──');
    console.log('   ⚠️ Se a producao usa a mesma conta ngrok, o tunel dela pode cair agora.');
    tunel = await subirTunel(pdf, nomeArquivo);
    urlPublica = `${tunel.base}/${nomeArquivo}`;
  }
  console.log(`  url que sera entregue ao Moskit: ${urlPublica}`);

  // Confere do NOSSO lado antes de acusar o Moskit: se o proprio tunel ja devolve HTML para um
  // cliente qualquer, o problema esta aqui e nao adianta seguir.
  const preTeste = await axios.get(urlPublica, { responseType: 'arraybuffer', validateStatus: () => true });
  const preBytes = Buffer.from(preTeste.data);
  console.log(`  auto-teste: HTTP ${preTeste.status}  ${preTeste.headers['content-type']}  ${preBytes.length} bytes  inicio=${JSON.stringify(preBytes.subarray(0, 5).toString('latin1'))}`);
  if (!preBytes.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    console.error('\n❌ O proprio tunel ja nao devolve o PDF — provavelmente o intersticio do ngrok gratis.');
    console.error('   O Moskit receberia esse mesmo HTML. Troque de tunel (Cloudflare Tunnel nao tem intersticio).');
    tunel?.encerrar();
    process.exit(1);
  }

  let anexoId = null;
  try {
    // ── 3. O POST documentado: {"url": "..."} ────────────────────────────────────────────────────
    console.log('\n── POST /deals/{id}/attachments  (corpo {"url"}) ──');
    const post = await req('post', `${MOSKIT_BASE}/deals/${dealId}/attachments`, { url: urlPublica });
    console.log(`  HTTP ${post.status}`);
    console.log(`  corpo: ${JSON.stringify(post.data, null, 2).split('\n').join('\n  ')}`);

    if (post.status < 200 || post.status >= 300) {
      console.error('\n❌ O POST documentado foi recusado. Sem ele nao ha caminho — pare e releia a doc.');
      return;
    }
    anexoId = post.data?.id;

    // ── 4. O que o Moskit REALMENTE guardou ──────────────────────────────────────────────────────
    // A doc avisa que a url demora alguns segundos para funcionar; por isso poll em vez de leitura
    // unica. Um GET so, feito cedo demais, diria "vazio" e eu culparia o transporte a toa.
    console.log('\n── Conferencia (poll de ate 30s) ──');
    let guardado = null;
    for (let i = 0; i < 10; i++) {
      await espera(3000);
      const res = await req('get', `${MOSKIT_BASE}/deals/${dealId}/attachments/${anexoId}`);
      if (res.status >= 200 && res.status < 300) {
        guardado = res.data;
        console.log(`  [${(i + 1) * 3}s] filename=${guardado.filename}  mimeType=${guardado.mimeType}  size=${guardado.size}`);
        if (guardado.size) break;
      } else {
        console.log(`  [${(i + 1) * 3}s] HTTP ${res.status}`);
      }
    }

    if (!guardado) {
      console.error('\n❌ Nao consegui reler o anexo criado. Contrato incerto — nao construa em cima disto.');
      return;
    }

    // ── 5. O veredito: baixar o que o Moskit guardou e comparar com o original ───────────────────
    console.log('\n── Veredito ──');
    const tamanhoBate = Number(guardado.size) === pdf.length;
    console.log(`  size:     ${guardado.size} vs ${pdf.length} original  ${tamanhoBate ? '✅' : '❌'}`);
    console.log(`  mimeType: ${guardado.mimeType}  ${/pdf/i.test(guardado.mimeType || '') ? '✅' : '❌'}`);
    console.log(`  filename: ${guardado.filename}  ${guardado.filename === nomeArquivo ? '✅ (derivado da URL)' : '⚠️ diferente do nome na URL'}`);

    let bytesOk = null;
    if (guardado.url) {
      const baixado = await axios.get(guardado.url, { responseType: 'arraybuffer', validateStatus: () => true });
      const bytes = Buffer.from(baixado.data);
      const inicio = bytes.subarray(0, 5).toString('latin1');
      bytesOk = inicio.startsWith('%PDF-') && bytes.length === pdf.length;
      console.log(`  bytes:    HTTP ${baixado.status}  ${bytes.length} bytes  inicio=${JSON.stringify(inicio)}  ${bytesOk ? '✅' : '❌'}`);
      if (!bytesOk && /<html|<!DOCTYPE/i.test(bytes.subarray(0, 200).toString('latin1'))) {
        console.log('  ⚠️ O conteudo guardado e HTML — e a cara do intersticio do ngrok gratis.');
      }
    }

    if (tamanhoBate && bytesOk !== false) {
      console.log('\n✅ APROVADO: o PDF atravessa o tunel e chega inteiro no Moskit. O plano e viavel.');
    } else {
      console.log('\n❌ REPROVADO: o que chegou ao Moskit nao e o PDF que servimos.');
      console.log('   Troque o tunel (Cloudflare Tunnel: dominio proprio, sem intersticio) e meça de novo.');
      console.log('   NAO implemente a rota publica enquanto isto nao passar.');
    }

    // ── 6. Bonus: o multipart existe mesmo nao estando na doc? ───────────────────────────────────
    // A doc do Moskit ja errou antes (o PUT de deal e o `limit` de paginacao estao documentados
    // errados). Se o multipart funcionar, a URL publica — e todo o risco de confidencialidade que
    // ela carrega — deixa de ser necessaria. Custa uma requisicao perguntar.
    console.log('\n── Bonus: POST multipart/form-data (nao documentado) ──');
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), nomeArquivo);
    const multi = await axios.post(`${MOSKIT_BASE}/deals/${dealId}/attachments`, form, {
      headers: { apikey: process.env.MOSKIT_API_KEY, 'X-Ollow-Origin': 'BOT_TEST' }, // sem Content-Type: o axios monta o boundary
      validateStatus: () => true,
    });
    console.log(`  HTTP ${multi.status} — ${JSON.stringify(multi.data).slice(0, 300)}`);
    if (multi.status >= 200 && multi.status < 300) {
      console.log('  🎉 O multipart FUNCIONA. Prefira este caminho: dispensa URL publica e o risco de sigilo.');
      if (multi.data?.id && !MANTER) {
        await req('delete', `${MOSKIT_BASE}/deals/${dealId}/attachments/${multi.data.id}`);
        console.log('  (anexo do teste multipart apagado)');
      }
    } else {
      console.log('  Confirmado: so o caminho por URL. A doc estava certa desta vez.');
    }
  } finally {
    // ── 7. Limpeza ────────────────────────────────────────────────────────────────────────────────
    if (anexoId && !MANTER) {
      const del = await req('delete', `${MOSKIT_BASE}/deals/${dealId}/attachments/${anexoId}`);
      console.log(`\n🧹 DELETE anexo ${anexoId} → HTTP ${del.status}`);
    } else if (anexoId) {
      console.log(`\n📌 --manter: anexo ${anexoId} deixado no deal ${dealId}.`);
    }
    tunel?.encerrar();
  }
}

// Guarda o efeito colateral atras do `require.main`: sem isto, importar o arquivo so para conferir
// os bytes do PDF dispararia uma medicao contra a API real.
if (require.main === module) {
  main().catch((e) => {
    console.error(`\n💥 ${e.message}`);
    process.exit(1);
  });
}

module.exports = { montarPdfDeSonda };
