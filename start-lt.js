const lt = require('localtunnel');
(async () => {
  try {
    const t = await lt({ port: 3000 });
    console.log('LT_URL:' + t.url);
  } catch (e) {
    console.error('LT_ERRO:' + e.message);
  }
})();
