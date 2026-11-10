# Caderno de Campo · Fazenda FCG

App de celular para o gerente de campo: fotos, condição das lavouras e andamento do plantio
por talhão, com relatório semanal em PDF para mandar aos sócios pelo WhatsApp.
É independente da Lavra e da plataforma de AP.

**Link do app:** https://dosmatto.github.io/caderno-campo/

## Escopo combinado (v1, 10/11/2026)

- Um gerente só. Os dados ficam **só no celular** (sem servidor, sem login).
- Marca Fazenda FCG, sem logo.
- Relatório com a condição da lavoura (Boa / Média / Ruim) e a situação do plantio
  (A plantar / Plantando / Plantado, % plantado e data).
- Fica para depois: pragas e doenças com nível.

## Como funciona

1. **Talhões**: sobe o KML/KMZ da fazenda (cada polígono vira um talhão, com a área
   calculada) e toca em cada um para pôr cultura, cultivar e situação do plantio.
   Dá também para cadastrar talhão sem mapa. Subir o KML de novo atualiza os contornos
   e mantém cultura, cultivar e plantio.
2. **Registrar**: o GPS acha sozinho o talhão em que o gerente está (até 150 m da
   borda, ele assume o talhão mais perto). Ele atualiza o plantio (A plantar / Plantando
   com o % / Plantado, e a data), marca a condição (Boa / Média / Ruim), o estádio (a lista
   muda conforme a cultura) e as observações, e tira as fotos. Cada foto guarda a hora e a
   posição. Em talhão **a plantar** o app não pede a condição, só as observações e as fotos.
   Salvar o registro grava o plantio no talhão.
3. **Relatório**: escolhe a semana (segunda a domingo), toca em **Gerar PDF** e depois em
   **Enviar**: abre o compartilhamento do celular, onde ele escolhe WhatsApp → grupo dos sócios.
   O PDF traz o resumo por condição (talhões e hectares), o **andamento do plantio**
   (hectares plantados, barra de %, quantos plantados / plantando / a plantar), o mapa pintado
   pela condição, a tabela dos talhões (situação, data e % de plantio, estádio, condição) e uma
   página por talhão visitado, com as fotos. Numa semana passada, o plantio mostrado é o do
   último registro até o fim daquela semana.
4. **Ajustes**: nome da fazenda (vazio = "Fazenda FCG"), gerente e safra; cópia de segurança.

A cópia de segurança gera um arquivo `.json` com tudo, fotos incluídas. Serve também para
passar os dados para outro aparelho.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | telas e estilo |
| `app.js` | banco no celular (IndexedDB), registros, plantio, PDF, cópia |
| `geo.js` | leitura de KML/KMZ, área, ponto-no-polígono, desenho do mapa |
| `sw.js`, `manifest.webmanifest`, `icon*.png`, `apple-touch-icon.png`, `icon.svg` | instalar na tela inicial e abrir sem internet |
| `exemplo-talhoes.kml` | 3 talhões de exemplo (um com furo, um em duas partes) |
| `exemplo-relatorio.pdf` | PDF gerado pelo teste |
| `teste.html`, `testar.cjs` | teste automático no Chrome headless |

## Rodar e testar no computador

Servidor local: `python3 -m http.server 8765` (ou o preview `app-campo`).
Teste: `node testar.cjs saida.pdf`.

## Publicar

Publicado no GitHub Pages a partir do repositório `dosmatto/caderno-campo` (branch `main`,
pasta raiz). Para atualizar: `git commit` e `git push`; o Pages republica em um ou dois
minutos. Ao mudar arquivos do app, troque o número em `CACHE` no `sw.js` (ex.: `v3`).

Precisa de **https**: sem ele o GPS e a câmera não funcionam. No celular, abrir o link no
Chrome (Android) ou no Safari (iPhone) e usar "Adicionar à tela inicial". Depois de aberto
uma vez com internet, o app funciona sem sinal na lavoura.
