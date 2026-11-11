// nuvem.js — cópia dos dados do celular no Supabase (projeto william-os).
// O celular continua sendo o lugar principal: grava primeiro nele e manda para a nuvem
// quando tem sinal. O que mudou aqui e ainda não subiu fica numa fila (cfg 'nuvem-fila').
// Tabela public.campo_itens (uma linha por item, apagado=true para exclusão) e
// fotos no bucket privado campo-fotos, em <usuário>/<id>.jpg.
(function () {
  'use strict';
  const URL_SB = 'https://fzuraxykzyfhmwqoaxrt.supabase.co';
  // chave pública (anon): só funciona junto com o login; quem protege os dados é o RLS
  const CHAVE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6dXJheHlrenlmaG13cW9heHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4NTU4NjAsImV4cCI6MjEwNTQzMTg2MH0.BLWtHtRNF_MMHJi_7a4v-kSiz421v0_xzwzhiE4GO3c';
  const TABELA = 'campo_itens';
  const BALDE = 'campo-fotos';
  const LOJAS = ['talhoes', 'registros', 'fotos'];
  const LOTE = 200;

  let sb = null;          // cliente do Supabase (ou um falso, nos testes)
  let bd = null;          // funções do banco local, sem marcar fila
  let aoReceber = async () => {};
  let aoEstado = () => {};
  let fila = new Map();   // 'loja|id' -> { loja, id, n }
  let meta = { uid: null, cursor: null, ultima: null };
  let email = '';
  let erro = '';
  let rodando = null, deNovo = false, timer = null, contador = 0;

  const chave = (loja, id) => loja + '|' + id;

  // compara objetos sem ligar para a ordem das chaves (o jsonb reordena)
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }

  function estado() {
    return { ligado: !!sb, logado: !!meta.logado, email, pendentes: fila.size, ultima: meta.ultima, erro, sincronizando: !!rodando };
  }
  function avisar() { try { aoEstado(estado()); } catch (e) { /* tela */ } }

  async function salvarFila() { await bd.gravar('cfg', [...fila.values()], 'nuvem-fila'); }
  async function salvarMeta() { await bd.gravar('cfg', { uid: meta.uid, cursor: meta.cursor, ultima: meta.ultima }, 'nuvem'); }

  function agendar(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { sincronizar(); }, ms);
  }

  // chamado pelo app depois de cada gravação ou exclusão local
  async function marcar(loja, id) {
    if (!bd) return;
    fila.set(chave(loja, id), { loja, id, n: ++contador });
    await salvarFila();
    avisar();
    if (meta.logado) agendar(3000);
  }
  async function marcarTudo() {
    for (const loja of LOJAS) for (const id of await bd.chaves(loja)) fila.set(chave(loja, id), { loja, id, n: ++contador });
    fila.set(chave('cfg', 'cfg'), { loja: 'cfg', id: 'cfg', n: ++contador });
    await salvarFila();
  }

  // ---------- enviar o que está na fila ----------
  async function enviar(uid) {
    const itens = [...fila.values()];
    const linhas = [];   // { linha, item }
    for (const it of itens) {
      let v = it.loja === 'cfg' ? await bd.pegar('cfg', 'cfg') : await bd.pegar(it.loja, it.id);
      if (it.loja === 'fotos') {
        const caminho = `${uid}/${it.id}.jpg`;
        if (v) {
          const r = await sb.storage.from(BALDE).upload(caminho, v, { upsert: true, contentType: v.type || 'image/jpeg' });
          if (r.error) throw r.error;
          v = { caminho, tipo: v.type || 'image/jpeg' };
        } else {
          await sb.storage.from(BALDE).remove([caminho]);
        }
      }
      linhas.push({ item: it, linha: { user_id: uid, loja: it.loja, id: it.id, dados: v == null ? null : v, apagado: v == null } });
    }
    for (let i = 0; i < linhas.length; i += LOTE) {
      const parte = linhas.slice(i, i + LOTE);
      const r = await sb.from(TABELA).upsert(parte.map((x) => x.linha), { onConflict: 'user_id,loja,id', returning: 'minimal' });
      if (r.error) throw r.error;
      // só tira da fila se não mudou de novo enquanto subia
      for (const { item } of parte) {
        const k = chave(item.loja, item.id);
        if (fila.get(k)?.n === item.n) fila.delete(k);
      }
      await salvarFila();
      avisar();
    }
  }

  // ---------- trazer o que mudou na nuvem ----------
  async function puxar() {
    let mudou = false, maior = meta.cursor, inicio = 0;
    // volta 5 s no cursor para não perder gravação que terminou junto com a última leitura
    const desde = meta.cursor ? new Date(new Date(meta.cursor).getTime() - 5000).toISOString() : null;
    for (;;) {
      let q = sb.from(TABELA).select('loja,id,dados,apagado,atualizado_em').order('atualizado_em', { ascending: true });
      if (desde) q = q.gt('atualizado_em', desde);
      const r = await q.range(inicio, inicio + 499);
      if (r.error) throw r.error;
      const linhas = r.data || [];
      for (const l of linhas) {
        if (!maior || l.atualizado_em > maior) maior = l.atualizado_em;
        if (fila.has(chave(l.loja, l.id))) continue; // o que mudou aqui e não subiu vale mais
        if (await aplicar(l)) mudou = true;
      }
      if (linhas.length < 500) break;
      inicio += 500;
    }
    meta.cursor = maior;
    return mudou;
  }
  async function aplicar(l) {
    if (l.loja === 'cfg') {
      if (l.apagado || !l.dados) return false;
      if (canon(await bd.pegar('cfg', 'cfg')) === canon(l.dados)) return false;
      await bd.gravar('cfg', l.dados, 'cfg'); return true;
    }
    if (!LOJAS.includes(l.loja)) return false;
    const local = await bd.pegar(l.loja, l.id);
    if (l.apagado) {
      if (local === undefined) return false;
      await bd.apagar(l.loja, l.id); return true;
    }
    if (l.loja === 'fotos') {
      if (local) return false;
      const r = await sb.storage.from(BALDE).download(l.dados.caminho);
      if (r.error) throw r.error;
      await bd.gravar('fotos', r.data.type ? r.data : new Blob([r.data], { type: l.dados.tipo || 'image/jpeg' }), l.id);
      return true;
    }
    if (local && canon(local) === canon(l.dados)) return false;
    await bd.gravar(l.loja, l.dados); return true;
  }

  // ---------- ciclo ----------
  function sincronizar() {
    if (!sb || !bd) return Promise.resolve();
    if (rodando) { deNovo = true; return rodando; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve();
    rodando = (async () => {
      avisar();
      try {
        const { data } = await sb.auth.getSession();
        const sessao = data && data.session;
        meta.logado = !!sessao;
        email = sessao ? sessao.user.email || '' : '';
        if (!sessao) return;
        const uid = sessao.user.id;
        // primeira vez desta conta neste celular: manda tudo o que já existe aqui
        if (meta.uid !== uid) { meta.uid = uid; meta.cursor = null; await marcarTudo(); }
        await enviar(uid);
        const mudou = await puxar();
        meta.ultima = new Date().toISOString();
        erro = '';
        await salvarMeta();
        if (mudou) await aoReceber();
      } catch (e) {
        erro = traduzir(e);
      } finally {
        rodando = null;
        avisar();
        if (deNovo) { deNovo = false; agendar(500); }
      }
    })();
    return rodando;
  }
  function traduzir(e) {
    const m = (e && (e.message || e.error_description || e.error)) || String(e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com a nuvem';
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha errados';
    if (/Email not confirmed/i.test(m)) return 'E-mail ainda não confirmado';
    return m;
  }

  async function entrar(emailDigitado, senha) {
    if (!sb) throw new Error('Sem a biblioteca da nuvem (abra o app com internet uma vez)');
    const r = await sb.auth.signInWithPassword({ email: emailDigitado.trim(), password: senha });
    if (r.error) throw new Error(traduzir(r.error));
    meta.logado = true; email = r.data.user.email || '';
    avisar();
    await sincronizar();
  }
  async function sair() {
    if (sb) await sb.auth.signOut({ scope: 'local' });
    meta.logado = false; email = ''; erro = '';
    avisar();
  }

  async function iniciar(opc) {
    bd = opc.bd; aoReceber = opc.aoReceber || aoReceber; aoEstado = opc.aoEstado || aoEstado;
    const salva = await bd.pegar('cfg', 'nuvem-fila');
    fila = new Map((salva || []).map((x) => [chave(x.loja, x.id), x]));
    contador = Math.max(0, ...[...fila.values()].map((x) => x.n || 0));
    Object.assign(meta, await bd.pegar('cfg', 'nuvem') || {});
    if (opc.cliente) sb = opc.cliente;
    else if (window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(URL_SB, CHAVE, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'caderno-campo-auth' } });
    }
    avisar();
    if (!opc.semGatilhos) {
      window.addEventListener('online', () => sincronizar());
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
      setInterval(() => sincronizar(), 5 * 60 * 1000);
    }
    return sincronizar();
  }

  // para os testes trocarem o cliente por um falso
  function usarCliente(c) { sb = c; meta.uid = null; meta.cursor = null; return sincronizar(); }

  window.Nuvem = { iniciar, marcar, sincronizar, entrar, sair, estado, usarCliente };
})();
