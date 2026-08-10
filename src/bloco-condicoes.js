// Deteccao do bloco padrao de condicoes de valor — o CHECKPOINT que decide paga x cortesia.
//
// Regra do escritorio: o atendente NUNCA diz que a consulta e gratuita. Quando ela e paga, ele manda
// este bloco. Nunca mandou => cortesia. Mandou em qualquer momento => paga (e o deal e corrigido
// retroativamente para R$350).
//
// Como o bloco e um texto FIXO, a deteccao e por impressao digital do template, nao por adivinhacao.
// O detector anterior (RE_VALOR_CONSULTA/RE_CONDICOES_APOIO) procurava "informacoes sobre o
// atendimento", frase que NAO existe no bloco em uso — resquicio de uma versao antiga. Como a regra
// exigia 2 padroes de apoio, sobrava um unico par possivel e qualquer envio parcial passava batido.

// Texto canonico em uso. SE O ESCRITORIO MUDAR O BLOCO PADRAO, E AQUI QUE SE ATUALIZA — os
// marcadores abaixo sao trechos deste texto, e o detector inteiro depende deles.
const BLOCO_CONDICOES_PAGA = `Caso deseje agendar a consulta, podemos verificar a disponibilidade de dias e horários.

-> O valor da consulta é de R$350,00 (pix, transferência ou cartão de crédito com acréscimos);
-> Nesse valor está incluso o retorno, se necessário;
-> E caso contrate os nossos serviços, o valor da consulta é abatido integralmente no valor dos honorários advocatícios;
->O atendimento pode ser realizado presencialmente ou online, por meio de uma videoconferência, com duração média de 01 hora;
-> Após a consultoria e análise do caso, nosso escritório elabora uma Proposta de Honorários para você de acordo com a sua demanda.

* O nosso escritório está localizado na Rua Jornalista Dondon, 2347, Horto, Teresina - PI. Porém, nós atuamos em todo o Brasil.`;

// Um marcador de valor basta: dizer o preco ja e anunciar que a consulta e paga.
const MARCADORES_VALOR = [
  /r\$\s*350/,
  /\b350[.,]00\b/,
  /\b350\s*reais\b/,
  /trezentos e cinquenta/,
];

// Tres marcadores de estrutura bastam. Cobre o bloco enviado sem a linha do valor, ou com o valor
// editado — casos que o detector antigo deixava passar como cortesia.
const MARCADORES_ESTRUTURA = [
  /abatido integralmente/,
  /proposta de honorarios/,
  /nesse valor esta incluso o retorno/,
  /duracao media de 0?1 hora/,
  /disponibilidade de dias e horarios/,
  /cartao de credito com acrescimos/,
  /presencialmente ou online/,
  /jornalista dondon/,
  /atuamos em todo o brasil/,
];

const MIN_MARCADORES_ESTRUTURA = 3;

// Marcador que o webhook grava quando a equipe manda anexo (index.js, ramo message.sent). Nao da
// pra ler o conteudo, entao a presenca dele vira uma ressalva na conclusao de cortesia.
const MARCADOR_ANEXO_EQUIPE = '[equipe enviou';

// Minuscula, sem acento, espacos colapsados — PONTUACAO PRESERVADA, porque "R$350,00" depende dela.
function normalizarSuave(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function contarMarcadores(texto) {
  const t = normalizarSuave(texto);
  return {
    valor: MARCADORES_VALOR.filter((re) => re.test(t)).length,
    estrutura: MARCADORES_ESTRUTURA.filter((re) => re.test(t)).length,
  };
}

function atingiuLimiar({ valor, estrutura }) {
  return valor >= 1 || estrutura >= MIN_MARCADORES_ESTRUTURA;
}

// Retorna { enviado, msgIdx, motivo, marcadores }.
// msgIdx e a mensagem em que o bloco se completou — e o ponto do checkpoint na conversa.
//
// Duas passadas: por mensagem (caso normal, bloco colado inteiro) e sobre a concatenacao de tudo que
// a equipe escreveu (caso do bloco fatiado em varias mensagens pelo WhatsApp).
function detectarBlocoCondicoes(mensagens) {
  const msgs = Array.isArray(mensagens) ? mensagens : [];
  const indicesEquipe = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === 'equipe') indicesEquipe.push(i);
  }

  for (const i of indicesEquipe) {
    const marcadores = contarMarcadores(msgs[i].text);
    if (atingiuLimiar(marcadores)) {
      return { enviado: true, msgIdx: i, motivo: 'mensagem_unica', marcadores };
    }
  }

  // Bloco fatiado: soma o texto da equipe inteiro e reavalia.
  const concatenado = indicesEquipe.map((i) => msgs[i].text).join('\n');
  const marcadores = contarMarcadores(concatenado);
  if (atingiuLimiar(marcadores)) {
    // O checkpoint dispara na ultima mensagem da equipe que carrega algum marcador.
    let ultima = indicesEquipe[indicesEquipe.length - 1];
    for (const i of indicesEquipe) {
      const m = contarMarcadores(msgs[i].text);
      if (m.valor > 0 || m.estrutura > 0) ultima = i;
    }
    return { enviado: true, msgIdx: ultima, motivo: 'mensagens_fatiadas', marcadores };
  }

  return { enviado: false, msgIdx: null, motivo: 'nao_encontrado', marcadores };
}

// Quantos anexos a equipe mandou que o bot nao consegue ler. Se houver algum e o bloco nao tiver sido
// detectado, a conclusao de cortesia sai com ressalva — o bloco pode ter vindo dentro da imagem.
function contarAnexosIlegiveisEquipe(mensagens) {
  const msgs = Array.isArray(mensagens) ? mensagens : [];
  return msgs.filter((m) => m?.role === 'equipe' && String(m.text || '').includes(MARCADOR_ANEXO_EQUIPE)).length;
}

module.exports = {
  BLOCO_CONDICOES_PAGA,
  MARCADORES_VALOR,
  MARCADORES_ESTRUTURA,
  MIN_MARCADORES_ESTRUTURA,
  normalizarSuave,
  contarMarcadores,
  detectarBlocoCondicoes,
  contarAnexosIlegiveisEquipe,
};
