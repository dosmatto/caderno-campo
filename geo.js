// geo.js — leitura de KML/KMZ, área, ponto-no-polígono e desenho do mapa.
// Polígono = { externo: [[lon,lat],...], furos: [[[lon,lat],...], ...] }
// Talhão.poligonos = [Polígono, ...]  (MultiGeometry vira vários)
(function () {
  'use strict';
  const R = 6378137; // raio da Terra (m), mesmo do Google Earth
  const rad = (g) => (g * Math.PI) / 180;

  // ---------- leitura do KML ----------
  function lerCoordenadas(txt) {
    return (txt || '').trim().split(/\s+/).map((t) => {
      const [lon, lat] = t.split(',').map(Number);
      return [lon, lat];
    }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  }

  // pega filhos por nome local, ignorando namespace (kml:, gx: etc.)
  function porNome(raiz, nome) {
    return Array.from(raiz.getElementsByTagNameNS('*', nome));
  }
  function textoFilho(el, nome) {
    for (const c of el.children) if (c.localName === nome) return c.textContent.trim();
    return '';
  }

  function dadoExtra(pm, chaves) {
    const campos = [...porNome(pm, 'SimpleData'), ...porNome(pm, 'Data')];
    for (const c of campos) {
      const n = (c.getAttribute('name') || '').toLowerCase();
      if (chaves.some((k) => n === k || n.includes(k))) {
        const v = c.localName === 'Data' ? (porNome(c, 'value')[0]?.textContent || '') : c.textContent;
        if (v.trim()) return v.trim();
      }
    }
    return '';
  }

  function lerKML(texto) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Arquivo KML inválido');
    const saida = [];
    porNome(doc, 'Placemark').forEach((pm, i) => {
      const poligonos = porNome(pm, 'Polygon').map((pg) => {
        const ext = porNome(pg, 'outerBoundaryIs')[0];
        const externo = ext ? lerCoordenadas(porNome(ext, 'coordinates')[0]?.textContent) : [];
        const furos = porNome(pg, 'innerBoundaryIs').map((ib) =>
          lerCoordenadas(porNome(ib, 'coordinates')[0]?.textContent)).filter((a) => a.length >= 3);
        return { externo, furos };
      }).filter((p) => p.externo.length >= 3);
      if (!poligonos.length) return;
      let nome = textoFilho(pm, 'name') || dadoExtra(pm, ['talhao', 'talhão', 'nome', 'name']) || `Talhão ${i + 1}`;
      saida.push({
        nome,
        poligonos,
        cultura: dadoExtra(pm, ['cultura']),
        cultivar: dadoExtra(pm, ['cultivar', 'variedade', 'hibrido', 'híbrido']),
      });
    });
    return saida;
  }

  async function lerArquivoMapa(arquivo) {
    const nome = arquivo.name.toLowerCase();
    if (nome.endsWith('.kmz')) {
      if (!window.JSZip) throw new Error('Sem internet para abrir KMZ. Tente um .kml');
      const zip = await window.JSZip.loadAsync(arquivo);
      const kmls = Object.values(zip.files).filter((f) => !f.dir && f.name.toLowerCase().endsWith('.kml'));
      if (!kmls.length) throw new Error('O KMZ não tem nenhum KML dentro');
      let todos = [];
      for (const f of kmls) todos = todos.concat(lerKML(await f.async('text')));
      return todos;
    }
    return lerKML(await arquivo.text());
  }

  // ---------- área (fórmula esférica, em hectares) ----------
  function areaAnel(anel) {
    let s = 0;
    for (let i = 0; i < anel.length; i++) {
      const [l1, f1] = anel[i];
      const [l2, f2] = anel[(i + 1) % anel.length];
      s += rad(l2 - l1) * (2 + Math.sin(rad(f1)) + Math.sin(rad(f2)));
    }
    return Math.abs((s * R * R) / 2);
  }
  function areaHa(poligonos) {
    let m2 = 0;
    for (const p of poligonos || []) {
      m2 += areaAnel(p.externo);
      for (const f of p.furos || []) m2 -= areaAnel(f);
    }
    return m2 / 10000;
  }

  // ---------- ponto no polígono ----------
  function dentroAnel([x, y], anel) {
    let dentro = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }
  function dentro(pt, poligonos) {
    return (poligonos || []).some((p) => dentroAnel(pt, p.externo) && !(p.furos || []).some((f) => dentroAnel(pt, f)));
  }

  // distância (m) do ponto até a borda mais próxima — projeção local, serve para centenas de metros
  function distanciaBorda([lon, lat], poligonos) {
    const kx = (Math.PI / 180) * R * Math.cos(rad(lat));
    const ky = (Math.PI / 180) * R;
    let melhor = Infinity;
    for (const p of poligonos || []) {
      for (const anel of [p.externo, ...(p.furos || [])]) {
        for (let i = 0; i < anel.length; i++) {
          const a = anel[i], b = anel[(i + 1) % anel.length];
          const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky;
          const bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
          const dx = bx - ax, dy = by - ay;
          const L = dx * dx + dy * dy;
          let t = L ? -(ax * dx + ay * dy) / L : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d < melhor) melhor = d;
        }
      }
    }
    return melhor;
  }

  // devolve { talhao, dentro: bool, distancia } — o talhão em que está, ou o mais perto
  function localizar(pt, talhoes) {
    const comMapa = talhoes.filter((t) => t.poligonos && t.poligonos.length);
    const achou = comMapa.find((t) => dentro(pt, t.poligonos));
    if (achou) return { talhao: achou, dentro: true, distancia: 0 };
    let perto = null, dist = Infinity;
    for (const t of comMapa) {
      const d = distanciaBorda(pt, t.poligonos);
      if (d < dist) { dist = d; perto = t; }
    }
    return { talhao: perto, dentro: false, distancia: dist };
  }

  // ---------- desenho do mapa num canvas ----------
  // cores: função talhao -> cor de preenchimento; destaque: id do talhão; posicao: [lon,lat]
  function desenharMapa(canvas, talhoes, { cores, destaque, posicao, larguraPx, alturaPx } = {}) {
    const dpr = larguraPx ? 1 : (window.devicePixelRatio || 1);
    const W = larguraPx || canvas.clientWidth || 600;
    const H = alturaPx || canvas.clientHeight || 300;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#eef1ec'; ctx.fillRect(0, 0, W, H);

    const comMapa = talhoes.filter((t) => t.poligonos && t.poligonos.length);
    if (!comMapa.length) {
      ctx.fillStyle = '#6b7570'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Suba o KML dos talhões para ver o mapa', W / 2, H / 2);
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of comMapa) for (const p of t.poligonos) for (const [x, y] of p.externo) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    // a posição só entra no enquadramento se estiver perto da fazenda
    if (posicao) {
      const mx = (x1 - x0) * 0.5 + 0.002, my = (y1 - y0) * 0.5 + 0.002;
      if (posicao[0] > x0 - mx && posicao[0] < x1 + mx && posicao[1] > y0 - my && posicao[1] < y1 + my) {
        x0 = Math.min(x0, posicao[0]); x1 = Math.max(x1, posicao[0]);
        y0 = Math.min(y0, posicao[1]); y1 = Math.max(y1, posicao[1]);
      }
    }
    const kx = Math.cos(rad((y0 + y1) / 2)); // corrige a distorção leste-oeste
    const margem = 14;
    const esc = Math.min((W - 2 * margem) / (((x1 - x0) * kx) || 1e-9), (H - 2 * margem) / ((y1 - y0) || 1e-9));
    const ox = (W - (x1 - x0) * kx * esc) / 2, oy = (H - (y1 - y0) * esc) / 2;
    const P = ([x, y]) => [ox + (x - x0) * kx * esc, H - oy - (y - y0) * esc];

    const rotulos = [];
    for (const t of comMapa) {
      ctx.beginPath();
      for (const p of t.poligonos) for (const anel of [p.externo, ...(p.furos || [])]) {
        anel.forEach((c, i) => { const [a, b] = P(c); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
        ctx.closePath();
      }
      ctx.fillStyle = cores ? cores(t) : '#9fc7a6';
      ctx.fill('evenodd');
      ctx.lineWidth = t.id === destaque ? 3 : 1.2;
      ctx.strokeStyle = t.id === destaque ? '#0b3d91' : '#2d3b31';
      ctx.stroke();
      // rótulo no centro do maior polígono
      const maior = t.poligonos.reduce((a, b) => (areaAnel(b.externo) > areaAnel(a.externo) ? b : a));
      let cx = 0, cy = 0;
      for (const c of maior.externo) { const [a, b] = P(c); cx += a; cy += b; }
      rotulos.push([t.nome, cx / maior.externo.length, cy / maior.externo.length]);
    }
    ctx.font = `bold ${Math.max(11, Math.round(W / 55))}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [nome, cx, cy] of rotulos) {
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.strokeText(nome, cx, cy);
      ctx.fillStyle = '#1c2420'; ctx.fillText(nome, cx, cy);
    }
    if (posicao) {
      const [a, b] = P(posicao);
      if (a > -20 && a < W + 20 && b > -20 && b < H + 20) {
        ctx.beginPath(); ctx.arc(a, b, 8, 0, 2 * Math.PI);
        ctx.fillStyle = 'rgba(26,115,232,.25)'; ctx.fill();
        ctx.beginPath(); ctx.arc(a, b, 5, 0, 2 * Math.PI);
        ctx.fillStyle = '#1a73e8'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      }
    }
  }

  window.Geo = { lerArquivoMapa, lerKML, areaHa, dentro, localizar, desenharMapa };
})();
