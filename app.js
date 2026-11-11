// app.js — Caderno de Campo: talhões, registros semanais com fotos e PDF para os sócios.
// Tudo fica primeiro no celular (IndexedDB); com login, nuvem.js manda uma cópia para o Supabase.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ================= banco (IndexedDB) =================
  let db;
  function abrirBanco() {
    return new Promise((ok, erro) => {
      const req = indexedDB.open('caderno-campo', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('talhoes', { keyPath: 'id' });
        d.createObjectStore('registros', { keyPath: 'id' });
        d.createObjectStore('fotos'); // id -> Blob
        d.createObjectStore('cfg');
      };
      req.onsuccess = () => { db = req.result; ok(); };
      req.onerror = () => erro(req.error);
    });
  }
  function tx(loja, modo, fn) {
    return new Promise((ok, erro) => {
      const t = db.transaction(loja, modo);
      const r = fn(t.objectStore(loja));
      t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined);
      t.onerror = () => erro(t.error);
      t.onabort = () => erro(t.error || new Error('Gravação cancelada (memória cheia?)'));
    });
  }
  const todos = (loja) => tx(loja, 'readonly', (s) => s.getAll());
  const pegar = (loja, k) => tx(loja, 'readonly', (s) => s.get(k));
  const chaves = (loja) => tx(loja, 'readonly', (s) => s.getAllKeys());
  const gravarBruto = (loja, v, k) => tx(loja, 'readwrite', (s) => (k === undefined ? s.put(v) : s.put(v, k)));
  const apagarBruto = (loja, k) => tx(loja, 'readwrite', (s) => s.delete(k));
  // toda mudança local entra na fila para subir para a nuvem (nuvem.js)
  const vaiParaNuvem = (loja, k) => loja !== 'cfg' || k === 'cfg';
  const marcarNuvem = (loja, k) => { if (window.Nuvem && vaiParaNuvem(loja, k)) return window.Nuvem.marcar(loja, k); };
  async function gravar(loja, v, k) { await gravarBruto(loja, v, k); await marcarNuvem(loja, k === undefined ? v.id : k); }
  async function apagar(loja, k) { await apagarBruto(loja, k); await marcarNuvem(loja, k); }
  async function limpar(loja) {
    const ks = await chaves(loja);
    await tx(loja, 'readwrite', (s) => s.clear());
    for (const k of ks) await marcarNuvem(loja, k);
  }

  // ================= estado =================
  let talhoes = [];
  let registros = [];
  let cfg = { fazenda: '', gerente: '', safra: '' };
  let posicao = null;          // { lon, lat, precisao, quando }
  let escolhaManual = false;   // o gerente trocou o talhão na mão
  let fotosPendentes = [];     // { id, blob, url, w, h, data, lat, lon }
  let condicao = '';
  let semanaAtual = segundaDaSemana(new Date());
  let pdfPronto = null;        // { arquivo, semana }

  const COND = { boa: 'Boa', media: 'Média', ruim: 'Ruim' };
  const COR = { boa: '#2e9e4f', media: '#e0a800', ruim: '#d23c32', nada: '#b9c0bb' };
  const NOME_PADRAO = 'Fazenda FCG';

  // ---- situação do plantio (A plantar / Plantando / Plantado), guardada como % plantado no talhão ----
  const SIT = { aplantar: 'A plantar', plantando: 'Plantando', plantado: 'Plantado' };
  const COR_SIT = { aplantar: '#8d9690', plantando: '#2f7fb5', plantado: '#1f5f2e' };
  // talhão antigo (sem %): com data de plantio conta como plantado
  const pctPlantado = (t) => Math.max(0, Math.min(100, Number(t?.plantadoPct ?? (t?.plantio ? 100 : 0)) || 0));
  const situacao = (t) => { const p = pctPlantado(t); return p >= 100 ? 'plantado' : p > 0 ? 'plantando' : 'aplantar'; };
  const hojeISO = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  // registro só de plantio (talhão a plantar) não tem condição
  const rotuloCond = (r) => COND[r.condicao] || (r.plantadoPct != null ? SIT[situacao(r)] : '—');

  // liga os três botões + % + data (no Registrar e no diálogo do talhão)
  function montarSituacao(pref, aoMudar) {
    const box = $(`#${pref}-sit`), pct = $(`#${pref}-pct`), data = $(`#${pref}-plantio`);
    let sit = 'aplantar';
    function mostrar() {
      box.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.s === sit));
      $(`#${pref}-pct-box`).style.visibility = sit === 'plantando' ? '' : 'hidden';
      $(`#${pref}-plantio-box`).style.visibility = sit === 'aplantar' ? 'hidden' : '';
      if (aoMudar) aoMudar(sit);
    }
    box.addEventListener('click', (e) => {
      const s = e.target.dataset.s; if (!s) return;
      sit = s;
      if (s !== 'aplantar' && !data.value) data.value = hojeISO();
      mostrar();
      if (s === 'plantando' && !pct.value) pct.focus();
    });
    return {
      definir(t) { sit = situacao(t); pct.value = sit === 'plantando' ? String(pctPlantado(t)) : ''; data.value = t?.plantio || ''; mostrar(); },
      ler() {
        if (sit === 'aplantar') return { plantadoPct: 0, plantio: '' };
        if (sit === 'plantado') return { plantadoPct: 100, plantio: data.value };
        const p = Math.round(parseFloat(pct.value.replace(',', '.')));
        if (!(p >= 1 && p <= 99)) return { erro: 'Informe o % plantado (de 1 a 99)' };
        return { plantadoPct: p, plantio: data.value };
      },
      get sit() { return sit; },
    };
  }
  let sitReg = null, sitDlg = null, talhaoRegAtual; // undefined: força a primeira carga

  const ESTADIOS = {
    soja: ['VE', 'VC', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'R1', 'R2', 'R3', 'R4',
      'R5.1', 'R5.2', 'R5.3', 'R5.4', 'R5.5', 'R6', 'R7', 'R8'],
    milho: ['VE', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V8', 'V10', 'V12', 'V14', 'V16', 'V18', 'VT',
      'R1', 'R2', 'R3', 'R4', 'R5', 'R6'],
    feijao: ['V0', 'V1', 'V2', 'V3', 'V4', 'R5', 'R6', 'R7', 'R8', 'R9'],
    inverno: ['Emergência', 'Perfilhamento', 'Alongamento', 'Emborrachamento', 'Espigamento', 'Floração',
      'Grão leitoso', 'Grão pastoso', 'Maturação'],
  };
  function estadiosDa(cultura) {
    const c = (cultura || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (c.includes('soja')) return ESTADIOS.soja;
    if (c.includes('milho') || c.includes('sorgo')) return ESTADIOS.milho;
    if (c.includes('feijao')) return ESTADIOS.feijao;
    if (/trigo|aveia|cevada|centeio|triticale/.test(c)) return ESTADIOS.inverno;
    return [...ESTADIOS.soja, ...ESTADIOS.milho.filter((e) => !ESTADIOS.soja.includes(e))];
  }

  // ================= utilidades =================
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
  }
  const fmtHa = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtData = (d) => new Date(d).toLocaleDateString('pt-BR');
  const fmtDataHora = (d) => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function segundaDaSemana(d) {
    const x = new Date(d); x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }
  const somaDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  function naSemana(iso, segunda) {
    const t = new Date(iso).getTime();
    return t >= segunda.getTime() && t < somaDias(segunda, 7).getTime();
  }
  function rotuloSemana(seg) {
    const dom = somaDias(seg, 6);
    return `${seg.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} a ${fmtData(dom)}`;
  }
  const ordenaNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { numeric: true });
  const talhaoPorId = (id) => talhoes.find((t) => t.id === id);

  function blobParaDataURL(blob) {
    return new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
  }
  async function dataURLParaBlob(u) { return (await fetch(u)).blob(); }

  // reduz a foto (o celular tira 4000px; o relatório não precisa disso)
  async function comprimir(arquivo, maxLado = 1400, qualidade = 0.72) {
    let img;
    try { img = await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); }
    catch (e) {
      img = await new Promise((ok, erro) => {
        const i = new Image(); i.onload = () => ok(i); i.onerror = erro; i.src = URL.createObjectURL(arquivo);
      });
    }
    const k = Math.min(1, maxLado / Math.max(img.width, img.height));
    const w = Math.round(img.width * k), h = Math.round(img.height * k);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    // toDataURL (síncrono) em vez de toBlob: toBlob pode ficar parado com o app em segundo plano
    const bin = atob(c.toDataURL('image/jpeg', qualidade).split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { blob: new Blob([bytes], { type: 'image/jpeg' }), w, h };
  }

  // ================= navegação =================
  function irPara(tela) {
    $$('nav button').forEach((b) => b.classList.toggle('ativo', b.dataset.tela === tela));
    $$('.tela').forEach((s) => s.classList.toggle('ativa', s.id === 't-' + tela));
    if (tela === 'talhoes') renderTalhoes();
    if (tela === 'relatorio') renderRelatorio();
    if (tela === 'registrar') renderRegistrar();
    window.scrollTo(0, 0);
  }

  function renderCabecalho() {
    $('#titulo').textContent = cfg.fazenda || NOME_PADRAO;
    $('#subtitulo').textContent = [cfg.safra && 'Safra ' + cfg.safra, cfg.gerente].filter(Boolean).join(' · ') || 'Relatório semanal das lavouras';
  }

  // ================= GPS =================
  function iniciarGPS() {
    if (!('geolocation' in navigator)) { mostrarGPS('Este aparelho não tem GPS disponível. Escolha o talhão na lista.', true); return; }
    navigator.geolocation.watchPosition((p) => {
      posicao = { lon: p.coords.longitude, lat: p.coords.latitude, precisao: p.coords.accuracy, quando: Date.now() };
      atualizarLocalizacao();
    }, (e) => {
      const msg = e.code === 1 ? 'Sem permissão de localização. Libere o GPS para o app achar o talhão sozinho.'
        : 'Não consegui pegar o GPS agora. Escolha o talhão na lista.';
      mostrarGPS(msg, true);
    }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  }
  function mostrarGPS(txt, aviso) { const g = $('#gps'); g.textContent = txt; g.classList.toggle('aviso', !!aviso); }

  function atualizarLocalizacao() {
    if (!posicao) return;
    const prec = `precisão ${Math.round(posicao.precisao)} m`;
    const comMapa = talhoes.some((t) => t.poligonos?.length);
    if (!comMapa) { mostrarGPS(`📍 Posição ok (${prec}). Suba o KML na aba Talhões para o app achar o talhão sozinho.`, true); }
    else {
      const r = Geo.localizar([posicao.lon, posicao.lat], talhoes);
      if (r.dentro) {
        mostrarGPS(`📍 Você está no ${r.talhao.nome} (${prec})`);
        if (!escolhaManual) $('#reg-talhao').value = r.talhao.id;
      } else if (r.talhao && r.distancia < 150) {
        mostrarGPS(`📍 Na beira do ${r.talhao.nome}, a ${Math.round(r.distancia)} m (${prec})`);
        if (!escolhaManual) $('#reg-talhao').value = r.talhao.id;
      } else {
        const longe = r.distancia < 5000 ? `${Math.round(r.distancia)} m` : `${(r.distancia / 1000).toFixed(1)} km`;
        mostrarGPS(`📍 Fora dos talhões (o mais perto é ${r.talhao?.nome}, a ${longe}). Escolha o talhão na lista.`, true);
      }
    }
    atualizarInfoTalhao();
    desenharMapaRegistro();
  }

  // ================= tela Registrar =================
  function renderRegistrar() {
    const sel = $('#reg-talhao');
    const atual = sel.value;
    sel.innerHTML = '<option value="">— escolha o talhão —</option>' +
      [...talhoes].sort(ordenaNome).map((t) => `<option value="${t.id}">${esc(t.nome)}${t.cultura ? ' · ' + esc(t.cultura) : ''}</option>`).join('');
    if (atual && talhaoPorId(atual)) sel.value = atual;
    if (!talhoes.length) mostrarGPS('Cadastre os talhões primeiro (aba Talhões — dá para subir o KML).', true);
    atualizarLocalizacao();
    atualizarInfoTalhao();
    desenharMapaRegistro();
    renderFotosPendentes();
  }
  function atualizarInfoTalhao() {
    const t = talhaoPorId($('#reg-talhao').value);
    $('#reg-talhao-info').textContent = t
      ? [t.area && fmtHa(t.area) + ' ha', t.cultura, t.cultivar].filter(Boolean).join(' · ') : '';
    $('#lista-estadios').innerHTML = estadiosDa(t?.cultura).map((e) => `<option value="${e}">`).join('');
    // só recarrega o plantio quando o talhão muda (o GPS chama isto a toda hora)
    const id = t ? t.id : null;
    if (sitReg && id !== talhaoRegAtual) { talhaoRegAtual = id; sitReg.definir(t); }
  }
  // talhão ainda a plantar: não pede condição da lavoura
  function aoMudarSitReg(sit) {
    const sem = sit === 'aplantar';
    $('#reg-cond').style.display = sem ? 'none' : '';
    $('#reg-cond-card h2').textContent = sem ? 'Observações da semana' : 'Condição da lavoura nesta semana';
  }
  function desenharMapaRegistro() {
    const c = $('#mapa-reg');
    if (!$('#t-registrar').classList.contains('ativa')) return;
    c.style.display = talhoes.some((t) => t.poligonos?.length) ? 'block' : 'none';
    Geo.desenharMapa(c, talhoes, {
      destaque: $('#reg-talhao').value,
      posicao: posicao ? [posicao.lon, posicao.lat] : null,
      cores: (t) => (t.id === $('#reg-talhao').value ? '#c9e3cf' : '#e3e8e2'),
    });
  }
  function renderFotosPendentes() {
    $('#reg-fotos').innerHTML = fotosPendentes.map((f) =>
      `<div><img src="${f.url}" alt=""><button type="button" data-tirar="${f.id}" aria-label="Remover">×</button></div>`).join('');
  }
  let fotosProcessando = 0;
  function estadoBotaoSalvar() {
    const b = $('#reg-salvar');
    b.disabled = fotosProcessando > 0;
    b.textContent = fotosProcessando > 0 ? `Preparando ${fotosProcessando} foto(s)…` : 'Salvar registro';
  }
  async function adicionarFotos(arquivos) {
    fotosProcessando += arquivos.length; estadoBotaoSalvar();
    try { await adicionarFotosAgora(arquivos); }
    finally { fotosProcessando -= arquivos.length; estadoBotaoSalvar(); }
  }
  async function adicionarFotosAgora(arquivos) {
    for (const arq of arquivos) {
      try {
        const { blob, w, h } = await comprimir(arq);
        fotosPendentes.push({
          id: uid(), blob, w, h, url: URL.createObjectURL(blob), data: new Date().toISOString(),
          lat: posicao?.lat ?? null, lon: posicao?.lon ?? null,
        });
      } catch (e) { toast('Não consegui ler uma das fotos'); }
    }
    renderFotosPendentes();
  }
  async function salvarRegistro() {
    const t = talhaoPorId($('#reg-talhao').value);
    if (!t) return toast('Escolha o talhão');
    const pl = sitReg.ler();
    if (pl.erro) return toast(pl.erro);
    const aPlantar = sitReg.sit === 'aplantar';
    if (!aPlantar && !condicao) return toast('Marque a condição: Boa, Média ou Ruim');
    if (fotosProcessando > 0) return toast('Aguarde as fotos ficarem prontas');
    const btn = $('#reg-salvar'); btn.disabled = true;
    try {
      for (const f of fotosPendentes) await gravar('fotos', f.blob, f.id);
      // o registro atualiza a situação do plantio do talhão
      if (pctPlantado(t) !== pl.plantadoPct || (t.plantio || '') !== pl.plantio || t.plantadoPct == null) {
        t.plantadoPct = pl.plantadoPct; t.plantio = pl.plantio;
        await gravar('talhoes', t);
      }
      const reg = {
        id: uid(), talhaoId: t.id, talhaoNome: t.nome, data: new Date().toISOString(),
        condicao: aPlantar ? '' : condicao, plantadoPct: pl.plantadoPct, plantio: pl.plantio,
        estadio: $('#reg-estadio').value.trim(), obs: $('#reg-obs').value.trim(),
        lat: posicao?.lat ?? null, lon: posicao?.lon ?? null, precisao: posicao?.precisao ?? null,
        fotos: fotosPendentes.map(({ id, w, h, data, lat, lon }) => ({ id, w, h, data, lat, lon })),
      };
      await gravar('registros', reg);
      registros.push(reg);
      fotosPendentes.forEach((f) => URL.revokeObjectURL(f.url));
      fotosPendentes = []; condicao = ''; escolhaManual = false;
      $$('#reg-cond button').forEach((b) => b.classList.remove('sel'));
      $('#reg-estadio').value = ''; $('#reg-obs').value = '';
      renderFotosPendentes();
      pdfPronto = null;
      toast(`Registro do ${t.nome} salvo ✔`);
      window.scrollTo(0, 0);
    } catch (e) {
      toast('Não consegui salvar: ' + e.message, 5000);
    } finally { estadoBotaoSalvar(); }
  }

  // ================= tela Talhões =================
  function ultimoRegistro(talhaoId) {
    // o último que tem condição (registro de talhão a plantar não conta)
    return registros.filter((r) => r.talhaoId === talhaoId && COND[r.condicao]).sort((a, b) => b.data.localeCompare(a.data))[0];
  }
  function textoPlantio(t) {
    const s = situacao(t);
    return (s === 'plantando' ? `Plantando ${pctPlantado(t)}%` : SIT[s]) + (s !== 'aplantar' && t.plantio ? ' desde ' + fmtData(t.plantio + 'T12:00') : '');
  }
  function renderTalhoes() {
    const lista = [...talhoes].sort(ordenaNome);
    const total = lista.reduce((s, t) => s + (Number(t.area) || 0), 0);
    $('#lista-talhoes').innerHTML = lista.length ? lista.map((t) => {
      const u = ultimoRegistro(t.id);
      return `<div class="item" data-editar="${t.id}">
        <div class="info"><b>${esc(t.nome)}</b>
        <small>${fmtHa(t.area)} ha · ${esc(t.cultura || 'sem cultura')}${t.cultivar ? ' · ' + esc(t.cultivar) : ''}${t.poligonos?.length ? '' : ' · sem mapa'}<br>${esc(textoPlantio(t))}</small></div>
        <span class="selo ${u ? u.condicao : 'nada'}">${u ? COND[u.condicao] : '—'}</span></div>`;
    }).join('') + `<div class="dica">${lista.length} talhões · ${fmtHa(total)} ha. Toque num talhão para pôr cultura e cultivar.</div>`
      : '<div class="vazio">Nenhum talhão ainda. Suba o KML ou cadastre na mão.</div>';
    Geo.desenharMapa($('#mapa-tal'), talhoes, { cores: (t) => { const u = ultimoRegistro(t.id); return u ? COR[u.condicao] + 'aa' : '#d9ded8'; } });
  }

  async function importarMapa(arquivo) {
    try {
      const lidos = await Geo.lerArquivoMapa(arquivo);
      if (!lidos.length) return toast('Não achei polígonos nesse arquivo', 4000);
      let novos = 0, atualizados = 0;
      for (const l of lidos) {
        const areaCalc = Math.round(Geo.areaHa(l.poligonos) * 100) / 100;
        const existente = talhoes.find((t) => t.nome.trim().toLowerCase() === l.nome.trim().toLowerCase());
        if (existente) {
          // atualiza o contorno; só troca a área se ela era a calculada (não mexe em área digitada)
          if (!existente.area || existente.area === existente.areaCalc) existente.area = areaCalc;
          existente.areaCalc = areaCalc; existente.poligonos = l.poligonos;
          if (!existente.cultura && l.cultura) existente.cultura = l.cultura;
          if (!existente.cultivar && l.cultivar) existente.cultivar = l.cultivar;
          await gravar('talhoes', existente); atualizados++;
        } else {
          const t = { id: uid(), nome: l.nome, area: areaCalc, areaCalc, cultura: l.cultura, cultivar: l.cultivar, plantio: '', poligonos: l.poligonos };
          talhoes.push(t); await gravar('talhoes', t); novos++;
        }
      }
      toast(`${novos} talhões novos${atualizados ? `, ${atualizados} atualizados` : ''}`, 3500);
      pdfPronto = null;
      renderTalhoes(); renderRegistrar();
    } catch (e) { toast('Erro ao ler o arquivo: ' + e.message, 8000); }
  }

  let editando = null;
  function abrirTalhao(id) {
    editando = id ? talhaoPorId(id) : null;
    const t = editando || {};
    $('#dlg-titulo').textContent = editando ? 'Editar talhão' : 'Novo talhão';
    $('#f-nome').value = t.nome || '';
    $('#f-area').value = t.area ? String(t.area).replace('.', ',') : '';
    $('#f-cultura').value = t.cultura || '';
    $('#f-cultivar').value = t.cultivar || '';
    sitDlg.definir(editando);
    $('#f-area-calc').textContent = t.areaCalc ? `Área pelo mapa: ${fmtHa(t.areaCalc)} ha` : '';
    $('#f-excluir').style.display = editando ? '' : 'none';
    $('#dlg-talhao').showModal();
  }
  async function fecharTalhao(acao) {
    if (acao === 'salvar') {
      const nome = $('#f-nome').value.trim();
      if (!nome) return toast('O talhão precisa de nome');
      const t = editando || { id: uid(), poligonos: [], areaCalc: 0 };
      t.nome = nome;
      t.area = parseFloat($('#f-area').value.replace(/\./g, '').replace(',', '.')) || 0;
      if (/^\d+(\.\d+)?$/.test($('#f-area').value.trim())) t.area = parseFloat($('#f-area').value); // "52.9" digitado com ponto
      t.cultura = $('#f-cultura').value.trim();
      t.cultivar = $('#f-cultivar').value.trim();
      const pl = sitDlg.ler();
      t.plantadoPct = pl.erro ? pctPlantado(t) : pl.plantadoPct; // o submit já barrou o erro
      t.plantio = pl.erro ? (t.plantio || '') : pl.plantio;
      if (!editando) talhoes.push(t);
      await gravar('talhoes', t);
      toast('Talhão salvo');
    } else if (acao === 'excluir' && editando) {
      const n = registros.filter((r) => r.talhaoId === editando.id).length;
      if (!confirm(`Excluir o ${editando.nome}?${n ? ` Os ${n} registros dele continuam guardados.` : ''}`)) return;
      await apagar('talhoes', editando.id);
      talhoes = talhoes.filter((t) => t !== editando);
    }
    editando = null; pdfPronto = null; talhaoRegAtual = undefined;
    renderTalhoes(); renderRegistrar();
  }

  // ================= tela Relatório =================
  // por talhão: o registro mais recente da semana define a condição; todas as fotos da semana entram
  function dadosDaSemana(seg) {
    const daSemana = registros.filter((r) => naSemana(r.data, seg)).sort((a, b) => a.data.localeCompare(b.data));
    const porTalhao = new Map();
    for (const r of daSemana) {
      if (!porTalhao.has(r.talhaoId)) porTalhao.set(r.talhaoId, []);
      porTalhao.get(r.talhaoId).push(r);
    }
    const fim = somaDias(seg, 7);
    const semanaCorrente = new Date() >= seg && new Date() < fim;
    // plantio: na semana corrente vale o talhão; em semana passada, o último registro até o fim dela
    const plantioDe = (t) => {
      if (semanaCorrente) return t;
      const r = registros.filter((x) => x.talhaoId === t.id && x.plantadoPct != null && new Date(x.data) < fim)
        .sort((a, b) => b.data.localeCompare(a.data))[0];
      return r || t;
    };
    const ultimoCom = (regs) => [...regs].reverse().find((r) => COND[r.condicao]) || null;
    const linhas = [...talhoes].sort(ordenaNome).map((t) => {
      const regs = porTalhao.get(t.id) || [];
      return { talhao: t, regs, ultimo: ultimoCom(regs), plantio: plantioDe(t) };
    });
    // registros de talhões excluídos ainda aparecem
    for (const [id, regs] of porTalhao) if (!talhaoPorId(id)) {
      const t = { id, nome: regs[0].talhaoNome + ' (excluído)', area: 0, poligonos: [] };
      linhas.push({ talhao: t, regs, ultimo: ultimoCom(regs), plantio: plantioDe(t) });
    }
    const resumo = { boa: [0, 0], media: [0, 0], ruim: [0, 0], nada: [0, 0] };
    for (const l of linhas) { const k = l.ultimo ? l.ultimo.condicao : 'nada'; resumo[k][0]++; resumo[k][1] += Number(l.talhao.area) || 0; }
    // andamento do plantio: hectares plantados = área × % de cada talhão
    const plantio = { total: 0, plantado: 0, aplantar: 0, plantando: 0, plantadoN: 0 };
    for (const l of linhas) {
      const a = Number(l.talhao.area) || 0, s = situacao(l.plantio);
      plantio.total += a; plantio.plantado += a * pctPlantado(l.plantio) / 100;
      plantio[s === 'plantado' ? 'plantadoN' : s]++;
    }
    plantio.pct = plantio.total ? Math.round((plantio.plantado / plantio.total) * 100) : 0;
    return { daSemana, linhas, resumo, plantio };
  }
  const textoAndamento = (p) => `Plantio: ${fmtHa(p.plantado)} de ${fmtHa(p.total)} ha (${p.pct}%) · ` +
    `${p.plantadoN} plantados, ${p.plantando} plantando, ${p.aplantar} a plantar`;

  function renderRelatorio() {
    $('#sem-rotulo').textContent = rotuloSemana(semanaAtual);
    $('#sem-prox').disabled = somaDias(semanaAtual, 7) > new Date();
    const { daSemana, linhas, resumo, plantio } = dadosDaSemana(semanaAtual);
    $('#sem-resumo').innerHTML = ['boa', 'media', 'ruim', 'nada'].map((k) =>
      `<div style="background:${COR[k]}"><b>${resumo[k][0]}</b>${k === 'nada' ? 'Sem avaliação' : COND[k]}<br>${fmtHa(resumo[k][1])} ha</div>`).join('');
    $('#sem-plantio').textContent = linhas.length ? textoAndamento(plantio) : '';
    $('#sem-talhoes').innerHTML = linhas.length ? linhas.map((l) =>
      `<div class="item"><div class="info"><b>${esc(l.talhao.nome)}</b><small>${esc(textoPlantio(l.plantio))}<br>${l.regs.length
        ? `${fmtDataHora(l.regs[l.regs.length - 1].data)}${l.ultimo?.estadio ? ' · ' + esc(l.ultimo.estadio) : ''} · ${l.regs.reduce((s, r) => s + r.fotos.length, 0)} fotos`
        : 'sem visita nesta semana'}</small></div>
        <span class="selo ${l.ultimo ? l.ultimo.condicao : 'nada'}">${l.ultimo ? COND[l.ultimo.condicao] : '—'}</span></div>`).join('')
      : '<div class="vazio">Nenhum talhão cadastrado.</div>';
    $('#sem-registros').innerHTML = daSemana.length ? [...daSemana].reverse().map((r) =>
      `<div class="item"><div class="info"><b>${esc(r.talhaoNome)} · ${rotuloCond(r)}</b>
        <small>${fmtDataHora(r.data)}${r.estadio ? ' · ' + esc(r.estadio) : ''} · ${r.fotos.length} fotos${r.obs ? '<br>' + esc(r.obs) : ''}</small></div>
        <button class="btn perigo" style="width:auto;margin:0;padding:8px 10px" data-apagar-reg="${r.id}">Apagar</button></div>`).join('')
      : '<div class="vazio">Nenhum registro nesta semana.</div>';
    atualizarBotaoPDF();
  }
  function atualizarBotaoPDF() {
    const pronto = pdfPronto && pdfPronto.semana === semanaAtual.getTime();
    $('#pdf-btn').textContent = pronto ? '📤 Enviar PDF (WhatsApp)' : '📄 Gerar PDF';
  }

  async function apagarRegistro(id) {
    const r = registros.find((x) => x.id === id);
    if (!r || !confirm(`Apagar o registro do ${r.talhaoNome} de ${fmtDataHora(r.data)} e as fotos dele?`)) return;
    for (const f of r.fotos) await apagar('fotos', f.id);
    await apagar('registros', id);
    registros = registros.filter((x) => x.id !== id);
    pdfPronto = null; renderRelatorio();
  }

  // ================= PDF =================
  async function gerarPDF(seg) {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) throw new Error('A biblioteca do PDF não carregou. Abra o app uma vez com internet.');
    const { linhas, resumo, plantio } = dadosDaSemana(seg);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, M = 14;
    const verde = [31, 95, 46];
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let y = 0;

    function cabecalho(titulo) {
      doc.setFillColor(...verde); doc.rect(0, 0, W, 24, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
      doc.text(cfg.fazenda || NOME_PADRAO, M, 11);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(titulo, M, 18);
      doc.text(`Semana ${rotuloSemana(seg)}`, W - M, 11, { align: 'right' });
      if (cfg.safra) doc.text(`Safra ${cfg.safra}`, W - M, 18, { align: 'right' });
      doc.setTextColor(28, 36, 32);
      y = 32;
    }
    function quebra(alt) { if (y + alt > H - 14) { doc.addPage(); cabecalho('continuação'); } }

    // ---- página 1: resumo ----
    cabecalho('Relatório semanal das lavouras' + (cfg.gerente ? ` · ${cfg.gerente}` : ''));
    const cx = (W - 2 * M - 9) / 4;
    ['boa', 'media', 'ruim', 'nada'].forEach((k, i) => {
      const x = M + i * (cx + 3);
      doc.setFillColor(...rgb(COR[k])); doc.roundedRect(x, y, cx, 22, 2, 2, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
      doc.text(String(resumo[k][0]), x + cx / 2, y + 9, { align: 'center' });
      doc.setFontSize(9); doc.setFont('helvetica', 'normal');
      doc.text(k === 'nada' ? 'Sem avaliação' : COND[k], x + cx / 2, y + 14.5, { align: 'center' });
      doc.text(`${fmtHa(resumo[k][1])} ha`, x + cx / 2, y + 19, { align: 'center' });
    });
    doc.setTextColor(28, 36, 32);
    y += 28;

    // andamento do plantio (como o painel "Andamento do Plantio" da fazenda)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('Andamento do plantio', M, y);
    doc.text(`${fmtHa(plantio.plantado)} de ${fmtHa(plantio.total)} ha  ·  ${plantio.pct}%`, W - M, y, { align: 'right' });
    y += 3;
    doc.setFillColor(226, 231, 225); doc.roundedRect(M, y, W - 2 * M, 5, 2, 2, 'F');
    if (plantio.pct > 0) { doc.setFillColor(...verde); doc.roundedRect(M, y, Math.max(4, (W - 2 * M) * plantio.pct / 100), 5, 2, 2, 'F'); }
    y += 10;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    let xs = M;
    for (const [k, n] of [['plantado', plantio.plantadoN], ['plantando', plantio.plantando], ['aplantar', plantio.aplantar]]) {
      doc.setFillColor(...rgb(COR_SIT[k])); doc.circle(xs + 1.6, y - 1.2, 1.6, 'F');
      const t = `${n} ${{ plantado: n === 1 ? 'plantado' : 'plantados', plantando: 'plantando', aplantar: 'a plantar' }[k]}`; doc.text(t, xs + 5, y); xs += doc.getTextWidth(t) + 12;
    }
    y += 7;

    // mapa colorido pela condição
    if (linhas.some((l) => l.talhao.poligonos?.length)) {
      const c = document.createElement('canvas');
      const cond = new Map(linhas.map((l) => [l.talhao.id, l.ultimo ? l.ultimo.condicao : 'nada']));
      Geo.desenharMapa(c, talhoes, { larguraPx: 1100, alturaPx: 620, cores: (t) => COR[cond.get(t.id) || 'nada'] });
      const altMapa = (W - 2 * M) * 620 / 1100;
      doc.addImage(c.toDataURL('image/jpeg', 0.85), 'JPEG', M, y, W - 2 * M, altMapa);
      y += altMapa + 6;
    }

    // tabela
    // colunas: Talhão, Área, Cultura/cultivar, Situação, Plantio, %, Estádio, Condição (somam 182 mm)
    const cols = [['Talhão', 27], ['Área (ha)', 18], ['Cultura / cultivar', 40], ['Situação', 23], ['Plantio', 18], ['%', 12], ['Estádio', 17], ['Condição', 27]];
    const iSit = 3, iCond = 7;
    function pilula(x, larg, cor, txt) {
      doc.setFillColor(...rgb(cor)); doc.roundedRect(x, y - 4.2, larg - 3, 5.8, 1.5, 1.5, 'F');
      doc.setTextColor(255); doc.text(String(txt), x + 2, y); doc.setTextColor(28, 36, 32);
    }
    function linhaTabela(vals, negrito, corCond, corSit) {
      quebra(8);
      let x = M;
      doc.setFont('helvetica', negrito ? 'bold' : 'normal'); doc.setFontSize(9);
      vals.forEach((v, i) => {
        if (i === iCond && corCond) pilula(x, cols[i][1], COR[corCond], v);
        else if (i === iSit && corSit) pilula(x, cols[i][1], COR_SIT[corSit], v);
        else if (i === 1 || i === 5) {
          doc.text(String(v), x + cols[i][1] - 4, y, { align: 'right' });
        } else {
          const txt = doc.splitTextToSize(String(v), cols[i][1] - 2)[0];
          doc.text(txt, i === 1 ? x + cols[i][1] - 4 : x, y, i === 1 ? { align: 'right' } : undefined);
        }
        x += cols[i][1];
      });
      doc.setDrawColor(221, 226, 220); doc.line(M, y + 2.2, W - M, y + 2.2);
      y += 7.5;
    }
    linhaTabela(cols.map((c) => c[0]), true);
    let totalArea = 0;
    for (const l of linhas) {
      totalArea += Number(l.talhao.area) || 0;
      const s = situacao(l.plantio);
      linhaTabela([
        l.talhao.nome, fmtHa(l.talhao.area),
        [l.talhao.cultura, l.talhao.cultivar].filter(Boolean).join(' / ') || '—',
        SIT[s],
        s !== 'aplantar' && l.plantio.plantio ? fmtData(l.plantio.plantio + 'T12:00').slice(0, 5) : '—',
        `${pctPlantado(l.plantio)}%`,
        l.ultimo?.estadio || '—',
        l.ultimo ? COND[l.ultimo.condicao] : (s === 'aplantar' ? '—' : 'Sem visita'),
      ], false, l.ultimo ? l.ultimo.condicao : (s === 'aplantar' ? null : 'nada'), s);
    }
    linhaTabela(['Total', fmtHa(totalArea), `${linhas.length} talhões`, '', '', `${plantio.pct}%`, '', ''], true);

    // ---- uma seção por talhão visitado ----
    for (const l of linhas.filter((x) => x.regs.length)) {
      doc.addPage(); cabecalho('Detalhe do talhão');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
      doc.text(l.talhao.nome, M, y);
      const kSel = l.ultimo ? l.ultimo.condicao : null;
      const sSel = situacao(l.plantio);
      doc.setFillColor(...rgb(kSel ? COR[kSel] : COR_SIT[sSel]));
      doc.roundedRect(W - M - 30, y - 5.5, 30, 8, 2, 2, 'F');
      doc.setTextColor(255); doc.setFontSize(10); doc.text(kSel ? COND[kSel] : SIT[sSel], W - M - 15, y - 0.2, { align: 'center' });
      doc.setTextColor(28, 36, 32); doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      y += 6;
      const info = [`${fmtHa(l.talhao.area)} ha`, l.talhao.cultura, l.talhao.cultivar, textoPlantio(l.plantio)].filter(Boolean).join(' · ');
      doc.text(info, M, y); y += 8;

      for (const r of l.regs) {
        quebra(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
        doc.text(`${fmtDataHora(r.data)} — ${rotuloCond(r)}${r.estadio ? ' · estádio ' + r.estadio : ''}`, M, y);
        doc.setFont('helvetica', 'normal'); y += 5.5;
        if (r.obs) {
          for (const ln of doc.splitTextToSize(r.obs, W - 2 * M)) { quebra(6); doc.text(ln, M, y); y += 5; }
        }
        y += 2;
        // fotos, duas por linha
        const larg = (W - 2 * M - 6) / 2;
        for (let i = 0; i < r.fotos.length; i += 2) {
          const par = r.fotos.slice(i, i + 2);
          const alt = Math.min(Math.max(...par.map((f) => (larg * f.h) / f.w)), 95);
          quebra(alt + 9);
          for (let j = 0; j < par.length; j++) {
            const f = par[j];
            const blob = await pegar('fotos', f.id);
            if (!blob) continue;
            const url = await blobParaDataURL(blob);
            let w = larg, h = (larg * f.h) / f.w;
            if (h > alt) { w = (w * alt) / h; h = alt; }
            const x = M + j * (larg + 6) + (larg - w) / 2;
            doc.addImage(url, 'JPEG', x, y, w, h, undefined, 'FAST');
            doc.setFontSize(7.5); doc.setTextColor(107, 117, 112);
            const legenda = fmtDataHora(f.data) + (f.lat != null ? `  ·  ${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : '');
            doc.text(legenda, M + j * (larg + 6), y + alt + 4);
            doc.setTextColor(28, 36, 32); doc.setFontSize(10);
          }
          y += alt + 8;
        }
        y += 3;
      }
    }

    // rodapé com página
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(140);
      doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')}`, M, H - 7);
      doc.text(`${i} / ${n}`, W - M, H - 7, { align: 'right' });
    }
    const nomeArq = `Lavouras ${(cfg.fazenda || NOME_PADRAO).trim()} ${seg.toISOString().slice(0, 10)}.pdf`.replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]/g, '');
    return new File([doc.output('blob')], nomeArq, { type: 'application/pdf' });
  }

  async function enviarArquivo(arquivo, texto) {
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      try { await navigator.share({ files: [arquivo], title: arquivo.name, text: texto }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(arquivo); a.download = arquivo.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('Arquivo baixado. Anexe no WhatsApp pelo clipe 📎 → Documento.', 5000);
  }

  // dois toques: o compartilhamento precisa vir logo de um toque, e o PDF com fotos demora a montar
  async function botaoPDF() {
    const btn = $('#pdf-btn');
    if (pdfPronto && pdfPronto.semana === semanaAtual.getTime()) {
      const { resumo } = dadosDaSemana(semanaAtual);
      const texto = `${cfg.fazenda || NOME_PADRAO} — semana ${rotuloSemana(semanaAtual)}: ` +
        `${resumo.boa[0]} boa, ${resumo.media[0]} média, ${resumo.ruim[0]} ruim` + (resumo.nada[0] ? `, ${resumo.nada[0]} sem avaliação` : '') + `. ${textoAndamento(dadosDaSemana(semanaAtual).plantio)}`;
      return enviarArquivo(pdfPronto.arquivo, texto);
    }
    btn.disabled = true; btn.textContent = 'Montando o PDF…';
    try {
      const arquivo = await gerarPDF(semanaAtual);
      pdfPronto = { arquivo, semana: semanaAtual.getTime() };
      toast(`PDF pronto (${(arquivo.size / 1048576).toFixed(1)} MB). Toque em Enviar.`, 3500);
    } catch (e) { toast(e.message, 5000); }
    finally { btn.disabled = false; atualizarBotaoPDF(); }
  }

  // ================= cópia de segurança =================
  async function exportarCopia() {
    const fotos = {};
    for (const r of registros) for (const f of r.fotos) {
      const b = await pegar('fotos', f.id); if (b) fotos[f.id] = await blobParaDataURL(b);
    }
    const dados = { app: 'caderno-campo', versao: 1, gerado: new Date().toISOString(), cfg, talhoes, registros, fotos };
    const nome = `copia-caderno-campo-${new Date().toISOString().slice(0, 10)}.json`;
    await enviarArquivo(new File([JSON.stringify(dados)], nome, { type: 'application/json' }), 'Cópia do Caderno de Campo');
  }
  async function importarCopia(arquivo) {
    try {
      const d = JSON.parse(await arquivo.text());
      if (d.app !== 'caderno-campo') throw new Error('Esse arquivo não é uma cópia do Caderno de Campo');
      if (!confirm(`Restaurar a cópia de ${fmtData(d.gerado)}? Os dados atuais deste celular serão substituídos.`)) return;
      for (const l of ['talhoes', 'registros', 'fotos']) await limpar(l);
      for (const t of d.talhoes || []) await gravar('talhoes', t);
      for (const r of d.registros || []) await gravar('registros', r);
      for (const [id, u] of Object.entries(d.fotos || {})) await gravar('fotos', await dataURLParaBlob(u), id);
      if (d.cfg) await gravar('cfg', d.cfg, 'cfg');
      await carregar(); toast('Cópia restaurada ✔');
    } catch (e) { toast('Não deu para restaurar: ' + e.message, 5000); }
  }
  async function mostrarArmazenamento() {
    if (!navigator.storage?.estimate) return;
    const { usage } = await navigator.storage.estimate();
    const persiste = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $('#armazenamento').textContent = `Usando ${(usage / 1048576).toFixed(1)} MB neste celular.` +
      (persiste ? ' Dados protegidos contra limpeza automática.' : '');
  }

  // ================= nuvem (Supabase) =================
  function renderNuvem(st) {
    const caixa = $('#nuvem-status'); if (!caixa) return;
    $('#nuvem-login').hidden = st.logado;
    $('#nuvem-conta').hidden = !st.logado;
    let txt;
    if (!st.ligado) txt = 'A cópia na nuvem precisa de internet na primeira abertura do app.';
    else if (!st.logado) txt = 'Entre com o e-mail e a senha para guardar uma cópia de tudo na nuvem.';
    else {
      txt = `Conectado como ${st.email}. `;
      txt += st.sincronizando ? 'Sincronizando…' : st.ultima ? `Última sincronização: ${new Date(st.ultima).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}.` : '';
      txt += st.pendentes ? ` ${st.pendentes} ${st.pendentes === 1 ? 'item espera' : 'itens esperam'} sinal para subir.` : ' Tudo na nuvem.';
    }
    if (st.erro) txt += ` (${st.erro})`;
    caixa.textContent = txt;
    const selo = $('#nuvem-selo');
    if (selo) {
      selo.hidden = !st.logado;
      selo.textContent = st.pendentes ? `☁ ${st.pendentes}` : '☁ ✓';
      selo.title = st.pendentes ? 'Itens esperando sinal para subir' : 'Tudo na nuvem';
    }
  }
  async function entrarNuvem() {
    const btn = $('#nuvem-entrar'); btn.disabled = true;
    try {
      await window.Nuvem.entrar($('#nuvem-email').value, $('#nuvem-senha').value);
      $('#nuvem-senha').value = '';
      toast('Conectado à nuvem ✔');
    } catch (e) { toast(e.message, 5000); }
    finally { btn.disabled = false; }
  }

  // ================= início =================
  async function carregar() {
    talhoes = await todos('talhoes');
    registros = await todos('registros');
    cfg = Object.assign({ fazenda: '', gerente: '', safra: '' }, await pegar('cfg', 'cfg'));
    $('#cfg-fazenda').value = cfg.fazenda; $('#cfg-gerente').value = cfg.gerente; $('#cfg-safra').value = cfg.safra;
    renderCabecalho(); renderRegistrar();
    const ativa = $('nav button.ativo').dataset.tela; if (ativa !== 'registrar') irPara(ativa);
  }

  function ligarEventos() {
    $$('nav button').forEach((b) => b.addEventListener('click', () => irPara(b.dataset.tela)));
    sitReg = montarSituacao('reg', aoMudarSitReg);
    sitDlg = montarSituacao('f');
    $('#reg-talhao').addEventListener('change', () => { escolhaManual = true; atualizarInfoTalhao(); desenharMapaRegistro(); });
    $$('#reg-cond button').forEach((b) => b.addEventListener('click', () => {
      condicao = b.dataset.v; $$('#reg-cond button').forEach((x) => x.classList.toggle('sel', x === b));
    }));
    $('#reg-foto-btn').addEventListener('click', () => $('#reg-foto-input').click());
    $('#reg-foto-input').addEventListener('change', async (e) => { await adicionarFotos(Array.from(e.target.files)); e.target.value = ''; });
    $('#reg-fotos').addEventListener('click', (e) => {
      const id = e.target.dataset.tirar; if (!id) return;
      const f = fotosPendentes.find((x) => x.id === id); if (f) URL.revokeObjectURL(f.url);
      fotosPendentes = fotosPendentes.filter((x) => x.id !== id); renderFotosPendentes();
    });
    $('#reg-salvar').addEventListener('click', salvarRegistro);

    $('#kml-btn').addEventListener('click', () => $('#kml-input').click());
    $('#kml-input').addEventListener('change', async (e) => { if (e.target.files[0]) await importarMapa(e.target.files[0]); e.target.value = ''; });
    $('#tal-novo').addEventListener('click', () => abrirTalhao(null));
    $('#lista-talhoes').addEventListener('click', (e) => { const it = e.target.closest('[data-editar]'); if (it) abrirTalhao(it.dataset.editar); });
    $('#form-talhao').addEventListener('submit', (e) => {
      const acao = e.submitter?.value;
      if (acao === 'salvar' && !$('#f-nome').value.trim()) { e.preventDefault(); return toast('O talhão precisa de nome'); }
      if (acao === 'salvar' && sitDlg.ler().erro) { e.preventDefault(); return toast(sitDlg.ler().erro); }
      fecharTalhao(acao);
    });

    $('#sem-ant').addEventListener('click', () => { semanaAtual = somaDias(semanaAtual, -7); renderRelatorio(); });
    $('#sem-prox').addEventListener('click', () => { semanaAtual = somaDias(semanaAtual, 7); renderRelatorio(); });
    $('#pdf-btn').addEventListener('click', botaoPDF);
    $('#sem-registros').addEventListener('click', (e) => { const id = e.target.dataset.apagarReg; if (id) apagarRegistro(id); });

    $('#cfg-salvar').addEventListener('click', async () => {
      cfg = { fazenda: $('#cfg-fazenda').value.trim(), gerente: $('#cfg-gerente').value.trim(), safra: $('#cfg-safra').value.trim() };
      await gravar('cfg', cfg, 'cfg'); renderCabecalho(); pdfPronto = null; toast('Salvo');
    });
    $('#bkp-exportar').addEventListener('click', exportarCopia);
    $('#bkp-importar').addEventListener('click', () => $('#bkp-input').click());
    $('#bkp-input').addEventListener('change', async (e) => { if (e.target.files[0]) await importarCopia(e.target.files[0]); e.target.value = ''; });
    $$('nav button[data-tela=ajustes]').forEach((b) => b.addEventListener('click', mostrarArmazenamento));
    $('#nuvem-entrar').addEventListener('click', entrarNuvem);
    $('#nuvem-senha').addEventListener('keydown', (e) => { if (e.key === 'Enter') entrarNuvem(); });
    $('#nuvem-agora').addEventListener('click', () => window.Nuvem && window.Nuvem.sincronizar());
    $('#nuvem-sair').addEventListener('click', async () => {
      if (confirm('Sair da nuvem? Os dados continuam neste celular.')) await window.Nuvem.sair();
    });
    window.addEventListener('resize', () => { desenharMapaRegistro(); if ($('#t-talhoes').classList.contains('ativa')) renderTalhoes(); });
  }

  (async function iniciar() {
    try {
      await abrirBanco();
      ligarEventos();
      await carregar();
      iniciarGPS();
      if (window.Nuvem) {
        window.Nuvem.iniciar({
          bd: { pegar, chaves, todos, gravar: gravarBruto, apagar: apagarBruto },
          aoReceber: async () => { await carregar(); pdfPronto = null; },
          aoEstado: renderNuvem,
          semGatilhos: !!window.__semGatilhosNuvem,
        });
      }
      if (navigator.storage?.persist) navigator.storage.persist();
      if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    } catch (e) {
      document.body.insertAdjacentHTML('afterbegin', `<p style="padding:16px;color:#b00">Erro ao abrir o app: ${esc(e.message)}</p>`);
    }
  })();

  // para testes no computador (sem GPS de verdade)
  window.__caderno = {
    gerarPDF, dados: () => ({ talhoes, registros }),
    simularPosicao: (lon, lat, precisao = 8) => { posicao = { lon, lat, precisao, quando: Date.now() }; atualizarLocalizacao(); },
  };
})();
