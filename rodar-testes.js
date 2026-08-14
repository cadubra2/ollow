// Roda a suite deterministica com TZ=UTC — o fuso da VPS.
//
// Por que existe: a suite rodava no fuso da maquina de quem executa. Na maquina do dev isso e
// America/Fortaleza (UTC-3), o MESMO fuso do escritorio, entao todo bug de fuso passava batido — um
// teste de horario "passava" porque o relogio do teste e o relogio esperado eram o mesmo. A VPS
// (Ubuntu cloud) vem em UTC, e era exatamente ali que a reuniao das 17h30 virava 14h30. O comentario
// em test-pipeline.js ja admitia isso: "passava antes porque a maquina que roda o teste tambem esta em
// horario de Brasilia".
//
// TZ=UTC via env do processo filho, em vez de `TZ=UTC node ...` no package.json, porque aquela sintaxe
// nao funciona no cmd.exe do Windows — e o repo e usado no Windows. Isso tambem evita adicionar
// cross-env como dependencia so pra setar uma variavel.
//
// Mantem o fail-fast do `&&` que estava no package.json: o primeiro arquivo que falhar encerra a
// suite com o codigo de saida dele, que e o que deploy.js checa antes de reiniciar o processo.
const { spawnSync } = require('child_process');
const path = require('path');

const TESTES = [
  'test-telefone.js',
  'test-moskit-ids.js',
  'test-atividade-moskit.js',
  'test-evidencia.js',
  'test-fila.js',
  'test-payload.js',
  'test-rotas.js',
  'test-pipeline.js',
  'test-agenda-dry-run.js',
  'test-guards-internos.js',
  'test-agendamento-bloco-mensagens.js',
  'test-transcricao.js',
  'test-zapsign.js',
];

const TZ_TESTES = process.env.TZ_TESTES || 'UTC';
console.log(`\n🧪 Suite deterministica — ${TESTES.length} arquivos, TZ=${TZ_TESTES} (fuso da VPS)\n`);

for (const arquivo of TESTES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, arquivo)], {
    stdio: 'inherit',
    env: { ...process.env, TZ: TZ_TESTES },
  });
  if (r.error) {
    console.error(`\n❌ nao foi possivel rodar ${arquivo}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n❌ ${arquivo} FALHOU (exit ${r.status}) — suite interrompida`);
    process.exit(r.status || 1);
  }
}

console.log(`\n✅ Suite completa passou com TZ=${TZ_TESTES}\n`);
