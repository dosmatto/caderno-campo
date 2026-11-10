// Teste automático: node testar.cjs <saida.pdf>  (precisa do servidor local na porta 8765)
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const destino = process.argv[2];
const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', `--user-data-dir=${perfil}`, '--remote-debugging-port=9333', 'about:blank'], { stdio: 'ignore' });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let alvo;
  for (let i = 0; i < 50 && !alvo; i++) {
    try { alvo = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch { await espera(200); }
  }
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let n = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const cmd = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Page.navigate', { url: 'http://localhost:8765/teste.html' });
  let txt = 'rodando';
  for (let i = 0; i < 240 && txt.startsWith('rodando'); i++) {
    await espera(500);
    const r = await cmd('Runtime.evaluate', { expression: "document.getElementById('saida') ? document.getElementById('saida').textContent : 'rodando'" });
    txt = r.result?.result?.value || 'rodando';
  }
  if (txt.includes('@@PDF@@')) {
    const [log, resto] = txt.split('@@PDF@@');
    fs.writeFileSync(destino, Buffer.from(resto.split('@@FIM@@')[0], 'base64'));
    console.log(log); console.log('PDF salvo em', destino);
  } else console.log(txt);
  ws.close(); chrome.kill();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); chrome.kill(); process.exit(1); });
