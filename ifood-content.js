// content.js — roda dentro da página do Portal iFood (Cardápio > PDV).
// Responsável por: expandir todos os complementos, ler os dados do DOM e
// casar com a planilha Saipos. O RESULTADO é mandado para uma aba própria
// da extensão (review.html) — a tela pesada não é mais desenhada aqui
// dentro, já que a própria página do PDV do iFood já é pesada sozinha.
// Esta página só volta a fazer algo quando a aba de revisão manda pedidos
// de "aplicar" um ou mais campos.
//
// IMPORTANTE: os seletores em IFPS_CONFIG dependem dos nomes de classe atuais
// do portal iFood (muitos são gerados automaticamente pelo build do site, tipo
// "sc-sSmyr"). Se a iFood atualizar o front-end do portal, esses nomes podem
// mudar e os seletores abaixo precisarão ser ajustados de novo.

const IFPS_CONFIG = {
  itemInputSelector: 'input[data-testid="item-pdv-input"]',
  optionInputSelector: 'input[data-testid="option-pdv-input"]',
  groupHeadingSelector: 'p.sc-sSmyr',
  optionLabelSelector: 'span[class*="link-text__content"]',
  toggleSelector: 'label[class*="_selectable-chip-wrapper_"]',
  itemNameMaxLevels: 10,
  optionNameMaxLevels: 14,
  // Itens tipo pizza não têm input[data-testid="item-pdv-input"]. O nome do
  // item, nesse caso, é sempre o primeiro span[optionLabelSelector] dentro do
  // card (confirmado investigando o DOM real de um item "Pizzas Salgadas...":
  // é o próprio link com o nome do item, que vem antes de qualquer opção de
  // grupo tipo "Tamanho"/"Sabores" na ordem do DOM).
  pizzaCardSelector: '[data-testid^="item-card-"]',
  // Título da categoria do item na lista do PDV (ex: "*** Combos Especiais
  // ***"). Usa [class*=] em vez do nome de classe completo (que tem um sufixo
  // de hash gerado pelo build, tipo "-BJ_GIY") pra ficar um pouco mais
  // resistente a mudanças de build futuras.
  categoryHeadingSelector: '[class*="category_info__title"]',
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IFPS_START') {
    ifpsRun().catch((err) => {
      console.error('[iFood PDV Sync]', err);
      ifpsShowToast('Erro ao processar: ' + err.message, 'err');
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_APPLY_ROWS_ON_PAGE') {
    ifpsApplyRowsOnPage(msg.rows).catch((err) => {
      console.error('[iFood PDV Sync]', err);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'IFPS_BACKGROUND_ERROR') {
    ifpsShowToast(msg.message, 'err');
    sendResponse({ ok: true });
    return true;
  }
});

async function ifpsRun() {
  ifpsShowToast('Expandindo todos os complementos do cardápio (pode levar alguns segundos)...', '');

  // A lista do iFood desmonta itens que saem da tela, então uma segunda
  // passada de leitura (mais devagar) evita perder item no meio do caminho.
  ifpsShowToast('Lendo tudo de novo com calma, pra não pular nenhum item...', '');
  const index = await ifpsScanAndCapture();

  const { ifpsSaiposRows } = await chrome.storage.local.get('ifpsSaiposRows');
  if (!ifpsSaiposRows || !ifpsSaiposRows.length) {
    ifpsShowToast('Nenhuma planilha carregada. Abra o popup da extensão e carregue o .xlsx primeiro.', 'err');
    return;
  }

  const matches = ifpsMatchAgainstSaipos(index, ifpsSaiposRows);
  matches.itemsScanned = index.size;

  ifpsShowToast(`Abrindo aba de revisão (${index.size} itens lidos no cardápio)...`, '');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'IFPS_OPEN_REVIEW', matches });
    if (!res || !res.ok) {
      ifpsShowToast('Não consegui abrir a aba de revisão' + (res && res.error ? ': ' + res.error : '') + '. Tente de novo pelo popup da extensão.', 'err');
      return;
    }
    ifpsShowToast('Pronto! A aba de revisão abriu (ou foi trazida pra frente) em outra guia do Chrome.', '');
  } catch (err) {
    console.error('[iFood PDV Sync]', err);
    ifpsShowToast(
      'Não consegui falar com a extensão para abrir a aba de revisão. Recarregue a extensão em chrome://extensions e depois atualize (F5) esta página antes de tentar de novo.',
      'err'
    );
  }
}

// ---------- Etapa 1: expandir tudo ----------

function ifpsSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ifpsExpandAll() {
  let stableRounds = 0;
  let lastHeight = -1;
  const maxRounds = 80;

  for (let round = 0; round < maxRounds; round++) {
    const toggles = [...document.querySelectorAll(IFPS_CONFIG.toggleSelector)].filter(
      (el) => /^Complementos/i.test(el.innerText.trim()) && !/chips--checked/.test(el.className)
    );

    for (const t of toggles) {
      t.click();
    }

    if (toggles.length > 0) {
      await ifpsSleep(120);
    }

    window.scrollBy(0, Math.round(window.innerHeight * 0.85));
    await ifpsSleep(220);

    const newHeight = document.body.scrollHeight;
    const reachedBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;

    if (toggles.length === 0 && newHeight === lastHeight && reachedBottom) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = newHeight;
  }

  window.scrollTo(0, 0);
  await ifpsSleep(150);
}

// ---------- Etapa 2: ler o DOM ----------

function ifpsNearestLabelEl(inputEl, selector, maxLevels) {
  let el = inputEl;
  for (let i = 0; i < maxLevels && el.parentElement; i++) el = el.parentElement;

  const candidates = [...el.querySelectorAll(selector)];
  if (!candidates.length) return null;

  const inputRect = inputEl.getBoundingClientRect();
  const inputMid = (inputRect.top + inputRect.bottom) / 2;

  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const mid = (r.top + r.bottom) / 2;
    const d = Math.abs(mid - inputMid);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function ifpsNearestLabel(inputEl, selector, maxLevels) {
  const el = ifpsNearestLabelEl(inputEl, selector, maxLevels);
  return el ? el.innerText.trim() : '';
}

// Itens pausados/inativos no iFood aparecem com o nome numa cor diferente do
// resto (mais apagada) — mas a cor exata do "ativo" muda conforme o tema do
// portal (claro ou escuro), então um limiar fixo de brilho não funciona nos
// dois casos. Em vez disso guardamos aqui só a cor computada do texto; a
// decisão de quem está inativo é feita depois, olhando pra cor mais comum
// entre TODOS os itens lidos (ifpsFinalizeInativoFlags) — essa cor majoritária
// vira a "linha de base" de item ativo, seja tema claro ou escuro, e qualquer
// item com cor diferente dela é marcado como inativo.
function ifpsGetColorString(el) {
  if (!el) return '';
  return getComputedStyle(el).color || '';
}

// Recalcula item.inativo pra todos os itens do índice a partir da cor mais
// frequente (ifpsGetColorString) capturada durante o scan. Autocalibra pro
// tema atual do portal em vez de depender de um valor fixo de brilho.
function ifpsFinalizeInativoFlags(items) {
  const colorCounts = new Map();
  for (const item of items.values()) {
    if (!item.nameColor) continue;
    colorCounts.set(item.nameColor, (colorCounts.get(item.nameColor) || 0) + 1);
  }

  let baselineColor = '';
  let baselineCount = 0;
  for (const [color, count] of colorCounts) {
    if (count > baselineCount) {
      baselineColor = color;
      baselineCount = count;
    }
  }

  for (const item of items.values()) {
    item.inativo = !!item.nameColor && !!baselineColor && item.nameColor !== baselineColor;
  }
}

function ifpsNearestHeadingAbove(inputEl, headings) {
  const inputRect = inputEl.getBoundingClientRect();
  let best = null;
  let bestTop = -Infinity;
  for (const h of headings) {
    if (h.rect.top <= inputRect.top + 2 && h.rect.top > bestTop) {
      bestTop = h.rect.top;
      best = h;
    }
  }
  return best ? best.text : '';
}

function ifpsVisibleText(el) {
  if (!el) return '';
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return '';
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return '';
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function ifpsIsGroupHeadingText(text, optionName) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 70) return false;
  if (IFPS_HEADING_BADGE_RE.test(clean)) return false;
  if (/^(DISPON[IÍ]VEL|INDISPON[IÍ]VEL|M[IÍ]NIMO|PRE[ÇC]O|C[ÓO]D\.?\s*PDV|PAUSAR|ATIVAR|EDITAR|EXCLUIR|REMOVER|SALVAR|CANCELAR)$/i.test(clean)) return false;
  if (/^R\$\s*\d/i.test(clean)) return false;
  if (/^\d+\s*(itens?|op[cç][oõ]es?)$/i.test(clean)) return false;
  if (optionName && clean.localeCompare(optionName, 'pt-BR', { sensitivity: 'base' }) === 0) return false;
  return true;
}

function ifpsGroupHeadingFallback(inputEl, optionName) {
  const inputRect = inputEl.getBoundingClientRect();
  let node = inputEl.parentElement;
  for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
    const optionInputs = [...(node.querySelectorAll?.(IFPS_CONFIG.optionInputSelector) || [])];
    if (!optionInputs.length) continue;

    const siblings = [];
    let child = node.firstElementChild;
    while (child) {
      const rect = child.getBoundingClientRect();
      if (rect.top < inputRect.top - 4) siblings.push(child);
      child = child.nextElementSibling;
    }

    for (const el of siblings.reverse()) {
      const nestedInput = el.querySelector?.(IFPS_CONFIG.optionInputSelector);
      if (nestedInput) continue;
      const text = ifpsVisibleText(el);
      const rect = el.getBoundingClientRect();
      if (inputRect.top - rect.bottom > 220) continue;
      if (ifpsIsGroupHeadingText(text, optionName)) return text;
    }
  }
  return '';
}

function ifpsGroupHeadingFor(inputEl, headings, optionName) {
  return ifpsNearestHeadingAbove(inputEl, headings) || ifpsGroupHeadingFallback(inputEl, optionName);
}

// Acha o título da categoria (ex: "*** Combos Especiais ***") do card de
// item mais próximo, andando pra trás no DOM: primeiro pelos irmãos
// anteriores do próprio card (e dos ancestrais dele, subindo), procurando o
// heading de categoria mais recente antes dele. A lista do PDV organiza os
// itens em blocos por categoria, cada um com esse heading no topo — não tem
// atributo tipo "categoryName" pronto no card, só o heading textual mesmo.
function ifpsNearestCategoryFor(cardEl) {
  let node = cardEl;
  while (node) {
    let sib = node.previousElementSibling;
    while (sib) {
      const heading = sib.matches(IFPS_CONFIG.categoryHeadingSelector)
        ? sib
        : sib.querySelector(IFPS_CONFIG.categoryHeadingSelector);
      if (heading) return heading.textContent.trim();
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return '';
}

// A lista do PDV do iFood parece "virtualizar" as linhas: itens que saem da
// tela (rolando pra baixo, ou voltando pro topo depois) são desmontados do
// DOM. Se a gente só lê tudo UMA VEZ no final (depois de já ter rolado a
// página inteira), qualquer item que tenha saído de vista nesse meio tempo
// simplesmente não aparece mais — e vira um item "perdido" na varredura.
// Por isso a leitura agora é incremental: capturamos o que está montado a
// cada passo da rolagem e vamos ACUMULANDO num único índice (função abaixo),
// em vez de ler tudo de uma vez só no final.

function ifpsMergeOption(item, optionData) {
  if (!optionData.optionid) return;
  const idx = item.options.findIndex((o) => o.optionid === optionData.optionid);
  if (idx === -1) item.options.push(optionData);
  else item.options[idx] = optionData;
}

// Lê o que está montado no DOM agora e mescla no índice acumulado `items`
// (Map itemid -> {itemName, parentCode, categoryid, options: [...], ...}).
// Chamada várias vezes, em posições de rolagem diferentes, por
// ifpsScanAndCapture — nunca sozinha pra ler a página inteira de uma vez.
// Selo "Opcional"/"Obrigatório" que o iFood mostra logo abaixo do título de
// cada grupo de complemento usa o MESMO seletor de heading (p.sc-sSmyr) —
// então, quando esse selo fica mais perto (verticalmente) da opção do que o
// título de verdade do grupo, ifpsNearestHeadingAbove pegava o selo em vez
// do título (bug real visto ao vivo: um grupo promocional "Aproveite a
// Pequena doce por R$29,90:" virava groupHeading="Opcional", perdendo a
// palavra "doce" que o matching.js usa pra não confundir sabor de pizza com
// borda). Filtramos esses selos aqui pra sempre cair no título real.
const IFPS_HEADING_BADGE_RE = /^(OPCIONAL|OBRIGAT[OÓ]RIO)$/i;

function ifpsCaptureSnapshot(items) {
  const headings = [...document.querySelectorAll(IFPS_CONFIG.groupHeadingSelector)]
    .map((h) => ({
      text: h.innerText.trim(),
      rect: h.getBoundingClientRect(),
    }))
    .filter((h) => h.text && !IFPS_HEADING_BADGE_RE.test(h.text));

  const itemInputs = [...document.querySelectorAll(IFPS_CONFIG.itemInputSelector)];
  for (const input of itemInputs) {
    const itemid = input.getAttribute('itemid');
    if (!itemid) continue;
    const nameEl = ifpsNearestLabelEl(input, IFPS_CONFIG.optionLabelSelector, IFPS_CONFIG.itemNameMaxLevels);
    const card = input.closest(IFPS_CONFIG.pizzaCardSelector);
    const existing = items.get(itemid);
    items.set(itemid, {
      itemid,
      categoryid: input.getAttribute('categoryid') || (existing ? existing.categoryid : ''),
      categoryName: (card ? ifpsNearestCategoryFor(card) : '') || (existing ? existing.categoryName : '') || '',
      itemName: (nameEl ? nameEl.innerText.trim() : '') || (existing ? existing.itemName : '') || '(nome não encontrado)',
      nameColor: (nameEl ? ifpsGetColorString(nameEl) : '') || (existing ? existing.nameColor : '') || '',
      inativo: existing ? existing.inativo : false,
      parentCode: input.value.trim(),
      inputId: input.id,
      isPizza: false,
      pizzaParentOptionid: '',
      options: existing ? existing.options : [],
    });
  }

  // Itens "tipo pizza": não têm item-pdv-input próprio (confirmado inspecionando
  // o DOM real). O código pai fica dentro do grupo "Tamanho", na única opção
  // desse grupo — o valor lá é o código Saipos cru (sem prefixo "x."), igual ao
  // item-pdv-input normal de qualquer outro item. Detectamos esses itens pelos
  // option-pdv-input cujo itemid não apareceu no passo acima.
  const allOptionInputsForDetection = [...document.querySelectorAll(IFPS_CONFIG.optionInputSelector)];
  const orphanByItem = new Map();
  for (const input of allOptionInputsForDetection) {
    const itemid = input.getAttribute('itemid');
    if (!itemid || items.has(itemid)) continue;
    if (!orphanByItem.has(itemid)) orphanByItem.set(itemid, []);
    orphanByItem.get(itemid).push(input);
  }

  for (const [itemid, inputs] of orphanByItem) {
    const card = inputs[0].closest(IFPS_CONFIG.pizzaCardSelector);
    const titleEl = card ? card.querySelector(IFPS_CONFIG.optionLabelSelector) : null;

    // 1ª tentativa: acha a opção cujo grupo se chama "Tamanho" (ou variação
    // tipo "Escolha o tamanho"). 2ª tentativa (fallback): grupo com uma única
    // opção — é o padrão observado pro campo de tamanho da pizza.
    let parentInput = null;
    for (const input of inputs) {
      const groupHeading = ifpsGroupHeadingFor(input, headings, '');
      if (/tamanho/i.test(groupHeading)) {
        parentInput = input;
        break;
      }
    }
    if (!parentInput) {
      const byGroup = new Map();
      for (const input of inputs) {
        const gid = input.getAttribute('groupid') || '';
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(input);
      }
      for (const gInputs of byGroup.values()) {
        if (gInputs.length === 1) {
          parentInput = gInputs[0];
          break;
        }
      }
    }

    const existing = items.get(itemid);
    items.set(itemid, {
      itemid,
      categoryid: card ? card.getAttribute('categoryid') || '' : existing ? existing.categoryid : '',
      categoryName: (card ? ifpsNearestCategoryFor(card) : '') || (existing ? existing.categoryName : '') || '',
      itemName: (titleEl ? titleEl.innerText.trim() : '') || (existing ? existing.itemName : '') || '(nome não encontrado)',
      nameColor: (titleEl ? ifpsGetColorString(titleEl) : '') || (existing ? existing.nameColor : '') || '',
      inativo: existing ? existing.inativo : false,
      parentCode: parentInput ? parentInput.value.trim() : existing ? existing.parentCode : '',
      inputId: parentInput ? parentInput.id : existing ? existing.inputId : '',
      isPizza: true,
      pizzaParentOptionid: parentInput ? parentInput.getAttribute('optionid') || '' : existing ? existing.pizzaParentOptionid : '',
      options: existing ? existing.options : [],
    });
  }

  const optionInputs = [...document.querySelectorAll(IFPS_CONFIG.optionInputSelector)];
  for (const input of optionInputs) {
    const itemid = input.getAttribute('itemid');
    if (!itemid || !items.has(itemid)) continue;

    const item = items.get(itemid);
    const optionid = input.getAttribute('optionid') || '';
    // A opção "Tamanho" de um item tipo pizza já virou o parentCode acima —
    // não entra de novo como se fosse um complemento comum a ser casado.
    if (item.isPizza && optionid && optionid === item.pizzaParentOptionid) continue;

    const optionName = ifpsNearestLabel(input, IFPS_CONFIG.optionLabelSelector, IFPS_CONFIG.optionNameMaxLevels);
    const groupHeading = ifpsGroupHeadingFor(input, headings, optionName);

    ifpsMergeOption(item, {
      optionid,
      groupid: input.getAttribute('groupid') || '',
      optionName: optionName || '(opção sem nome)',
      groupHeading,
      currentValue: input.value.trim(),
      inputId: input.id,
    });
  }
}

// Uma passada de leitura: rola a página inteira de cima a baixo (e volta pro
// topo no final) capturando/mesclando o índice a cada parada, pra nenhum
// item que "sai da tela" e é desmontado ficar de fora DESSA passada.
async function ifpsScanOnePass(items) {
  window.scrollTo(0, 0);
  await ifpsSleep(280);
  ifpsCaptureSnapshot(items);

  let stableRounds = 0;
  let lastHeight = -1;
  const maxRounds = 120;

  for (let round = 0; round < maxRounds; round++) {
    window.scrollBy(0, Math.round(window.innerHeight * 0.6));
    await ifpsSleep(260);
    ifpsCaptureSnapshot(items);

    const newHeight = document.body.scrollHeight;
    const reachedBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;

    if (newHeight === lastHeight && reachedBottom) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = newHeight;
  }

  // Volta pro topo e captura mais uma vez, por garantia — os primeiros itens
  // podem ter sido desmontados de novo depois de tanto rolar.
  window.scrollTo(0, 0);
  await ifpsSleep(200);
  ifpsCaptureSnapshot(items);
}

// Antes rodava só UMA passada, mas na prática a lista do iFood às vezes
// ainda está terminando de carregar dados (rede lenta, primeira visita à
// página, etc.) e uma única passada — mesmo com toda a rolagem — pode
// terminar antes de tudo estar montado, resultando num scan incompleto (foi
// o caso relatado: "às vezes puxa tudo só na 3ª vez que rodo"). Em vez de
// depender do usuário rodar a extensão várias vezes manualmente até dar
// certo, agora ela mesma repete a passada inteira automaticamente até dois
// scans seguidos encontrarem exatamente o mesmo conjunto de itens (ou seja,
// "estabilizou") — como o índice só ACUMULA itens (nunca remove), isso é
// seguro e só faz passadas extras quando realmente aparece algo novo.
// "Assinatura" do estado atual do índice: não basta comparar só os itemids
// encontrados — um item pode já ter aparecido no Map mas com a lista de
// opções (complementos) ainda incompleta, porque o toggle "Complementos"
// dele só terminou de carregar/expandir DEPOIS dessa passada. Se a gente só
// olhasse pro conjunto de ids, duas passadas podiam "empatar" (mesmos itens)
// mesmo com uma delas tendo menos opções lidas, e a extensão parava cedo
// demais achando que tinha estabilizado. Por isso a assinatura inclui também
// a quantidade total de opções somada de todos os itens.
function ifpsIndexFingerprint(items) {
  let totalOptions = 0;
  const ids = [];
  for (const [id, item] of items) {
    ids.push(id);
    totalOptions += item.options ? item.options.length : 0;
  }
  return ids.sort().join(',') + '|opts=' + totalOptions;
}

// Antes rodava só UMA passada, mas na prática a lista do iFood às vezes
// ainda está terminando de carregar dados (rede lenta, primeira visita à
// página, etc.) e uma única passada — mesmo com toda a rolagem — pode
// terminar antes de tudo estar montado, resultando num scan incompleto (foi
// o caso relatado: "às vezes puxa tudo só na 3ª vez que rodo"). Em vez de
// depender do usuário rodar a extensão várias vezes manualmente até dar
// certo, agora ela mesma repete a passada inteira automaticamente até duas
// passadas seguidas baterem na mesma "assinatura" (mesmos itens E mesma
// quantidade de opções lidas) — ou seja, até "estabilizar" de verdade. Como
// o índice só ACUMULA itens/opções (nunca remove), passadas extras são
// seguras e só custam tempo quando realmente falta algo.
async function ifpsScanAndCapture() {
  const items = new Map();
  const maxPasses = 5;
  let previousFingerprint = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    if (pass > 1) {
      ifpsShowToast(`Lendo de novo (passada ${pass}/${maxPasses}) — ${items.size} item(ns) encontrados até agora, conferindo se falta algum...`, '');
    }
    // Re-expande a cada passada (não só na primeira): se algum complemento
    // estava fora da tela (virtualizado) durante a passada de expansão
    // anterior, ele pode ter acabado de aparecer nessa rolagem — a função já
    // ignora sozinha quem já está expandido, então repetir não tem custo
    // real quando não há nada novo pra expandir.
    await ifpsExpandAll();
    await ifpsScanOnePass(items);

    const currentFingerprint = ifpsIndexFingerprint(items);
    if (previousFingerprint !== null && currentFingerprint === previousFingerprint) break;
    previousFingerprint = currentFingerprint;
  }

  ifpsFinalizeInativoFlags(items);

  return items;
}

// ---------- Etapa 3: casar com a planilha Saipos ----------

// Lista de opções alternativas pra popular o campo pesquisável de correção manual
// na aba de revisão. Antes pegava as primeiras opções do item MISTURANDO
// todos os grupos de complemento dele (Tamanho, Sabores, Bordas, Adicionais
// etc.) e cortava em 25 — então num item com grupo de Sabores grande (pizza
// com 30-40 sabores), a lista ficava cortada pela metade e ainda podia trazer
// opção de outro grupo sem querer. Agora, quando dá pra saber a qual grupo a
// opção sugerida pertence, mostramos só as opções DESSE MESMO grupo — assim
// dá pra ver todos os sabores daquele item (código pai) específico, sem
// mistura. unlimitedStorage já está habilitado, então o teto aqui é só uma
// válvula de segurança, não a cota de storage de antes.
function ifpsAlternativasFor(item, excludeOptionId, preferredGroupHeading) {
  let list = excludeOptionId ? item.options.filter((o) => o.optionid !== excludeOptionId) : item.options;
  if (preferredGroupHeading) {
    const mesmoGrupo = list.filter((o) => o.groupHeading === preferredGroupHeading);
    if (mesmoGrupo.length) list = mesmoGrupo;
  }
  return list
    .slice()
    .sort((a, b) => a.optionName.localeCompare(b.optionName, 'pt-BR'))
    .map((o) => ({ optionName: o.optionName, groupHeading: o.groupHeading, inputId: o.inputId, optionid: o.optionid }));
}

function ifpsIsAtivo(row) {
  const v = String(row['Inativo'] == null ? '' : row['Inativo']).trim().toUpperCase();
  // A coluna se chama "Inativo" mas guarda o status ("Ativo"/"Inativo"). Só
  // descartamos quando o valor deixa claro que está inativo; célula vazia
  // ou qualquer outro valor é tratado como ativo, pra não jogar fora linha
  // válida por engano.
  return v !== 'INATIVO';
}

function ifpsMatchAgainstSaipos(index, saiposRowsRaw) {
  const saiposRows = saiposRowsRaw.filter(ifpsIsAtivo);
  const skippedInativo = saiposRowsRaw.length - saiposRows.length;

  const complementoRows = saiposRows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'COMPLEMENTO');

  const complementosByParent = new Map();
  for (const row of complementoRows) {
    const parent = ifpsParentCode(row['Código Saipos']);
    if (!complementosByParent.has(parent)) complementosByParent.set(parent, []);
    complementosByParent.get(parent).push(row);
  }

  let rowId = 0;
  const flatRows = [];
  const semPlanilha = [];
  const semCodigoPai = [];
  let semOpcaoNoIfood = 0;

  for (const item of index.values()) {
    if (!item.parentCode) {
      semCodigoPai.push(item);
      continue;
    }

    const complementos = complementosByParent.get(item.parentCode);
    if (!complementos || !complementos.length) {
      semPlanilha.push(item);
      continue;
    }

    // Tamanho do item, lido do próprio nome (ex: "Pizza individual" = Pq,
    // "Pizza gigante ..." = Gg) — usado como desempate quando o nome da
    // opção do iFood não carrega marca de tamanho nenhuma. Ver ifpsScoreMatch.
    const itemSizeTag = ifpsSizeWordTag(item.itemName);

    // Às vezes a planilha tem MAIS DE UMA linha praticamente sinônima pro
    // mesmo sabor/produto (ex: "Guaraná Antarctica zero 2l" e "Refr Guarana
    // Antarctica Zero 2l" — nomes diferentes, mesma bebida). Se o código que
    // já está no campo do iFood bate com uma dessas linhas duplicadas (não
    // necessariamente a que "ganhou" a comparação), o campo já está certo —
    // trocar por outra linha igualmente válida não corrige nada, só cria
    // trabalho e confusão. Esse mapa deixa achar rapidinho qual linha da
    // planilha (se alguma) já corresponde ao código atual do campo.
    const codeToCompRow = new Map();
    for (const compRow of complementos) {
      const code = ifpsBuildIfoodCode(compRow['Código Saipos']);
      if (code) codeToCompRow.set(code.toLowerCase(), compRow);
    }

    const usedOptionIds = new Set();
    const pairs = [];
    for (const compRow of complementos) {
      const parsed = ifpsParseComplementoField(compRow['Complemento']);
      const newCode = ifpsBuildIfoodCode(compRow['Código Saipos']);
      for (const opt of item.options) {
        const score = ifpsScoreMatch(parsed, opt.optionName, opt.groupHeading, itemSizeTag);
        pairs.push({ compRow, parsed, newCode, opt, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    const assignedSaiposRow = new Set();
    const rowsForItem = [];
    for (const pair of pairs) {
      const saiposKey = pair.compRow['Código Saipos'];
      if (assignedSaiposRow.has(saiposKey) || usedOptionIds.has(pair.opt.optionid)) continue;
      assignedSaiposRow.add(saiposKey);
      usedOptionIds.add(pair.opt.optionid);

      // Comparação sem diferenciar maiúscula/minúscula: já vimos campo do
      // iFood com "X.21619042" (X maiúsculo) igual, na prática, ao código
      // novo "x.21619042" — mas a comparação exata (===) tratava isso como
      // "diferente" e sugeria mudar pra um valor que já era o mesmo.
      const jaCorreto =
        pair.newCode && pair.opt.currentValue && pair.newCode.toLowerCase() === pair.opt.currentValue.trim().toLowerCase();

      // O código atual não é IGUAL ao que essa linha geraria, mas pode ser
      // que ele já corresponda a uma linha DIFERENTE e igualmente válida da
      // planilha pra esse mesmo sabor (ver comentário acima). Só conta como
      // "já correto por duplicata" se essa outra linha também bate BEM
      // (confiança alta) com essa mesma opção — senão um código atual
      // realmente errado (sabor trocado) poderia se disfarçar de correto só
      // por coincidir com o código de OUTRO produto qualquer da planilha.
      let jaCorretoViaDuplicata = false;
      let duplicataDe = '';
      if (!jaCorreto && pair.opt.currentValue) {
        const altRow = codeToCompRow.get(pair.opt.currentValue.trim().toLowerCase());
        if (altRow && altRow['Código Saipos'] !== pair.compRow['Código Saipos']) {
          const altParsed = ifpsParseComplementoField(altRow['Complemento']);
          const altScore = ifpsScoreMatch(altParsed, pair.opt.optionName, pair.opt.groupHeading, itemSizeTag);
          if (altScore >= IFPS_CONFIDENCE.HIGH) {
            jaCorretoViaDuplicata = true;
            duplicataDe = altRow['Complemento'] || '';
          }
        }
      }

      // Mesmo quando é "correto por duplicata", deixamos visível pra você
      // conferir com seus próprios olhos (em vez de sumir na pilha dos
      // "já corretos" comuns) — é uma inferência a mais em cima de duas
      // linhas parecidas da planilha, então vale um olhar rápido.
      const nomeSuspeito = (jaCorreto && pair.score < IFPS_CONFIDENCE.HIGH) || jaCorretoViaDuplicata;
      const confidence = jaCorreto || jaCorretoViaDuplicata ? 'correto' : ifpsClassify(pair.score);

      rowsForItem.push({
        rowId: rowId++,
        itemName: item.itemName,
        categoriaIfood: item.categoryName || '',
        saiposDescricao: pair.compRow['Descrição'] || '',
        saiposCategoria: pair.compRow['Categoria'] || '',
        parentCode: item.parentCode,
        itemInativo: item.inativo,
        saiposNome: pair.compRow['Complemento'],
        saiposCodigo: pair.compRow['Código Saipos'],
        novoCodigo: pair.newCode,
        opcaoIfood: pair.opt.optionName,
        grupoIfood: pair.opt.groupHeading,
        valorAtual: pair.opt.currentValue,
        inputId: pair.opt.inputId,
        itemid: item.itemid,
        optionid: pair.opt.optionid,
        // pair.score é o valor cru (usado pra ordenar/desempatar, pode passar
        // de 1 quando vários sinais concordam) — pra mostrar na tela usamos a
        // versão limitada a 0..1, senão apareceria tipo "1.31" na coluna Score.
        score: ifpsDisplayScore(pair.score),
        confidence,
        nomeSuspeito,
        duplicataDe,
        // "já correto" nunca mostra o menu de alternativas na revisão, então
        // nem guardamos essa lista pra ele — é o que mais pesava no relatório
        // (o mesmo grupo de opções repetido em cada linha correta).
        alternativas: confidence === 'correto' ? [] : ifpsAlternativasFor(item, pair.opt.optionid, pair.opt.groupHeading),
      });
    }

    // Linhas da planilha que não acharam NENHUMA opção correspondente no
    // iFood: normalmente é porque o grupo de complementos na Saipos é
    // compartilhado entre vários tamanhos/produtos (ex: "Bordas e Massas"
    // lista Pq/Gg/Gr todas juntas), mas esse item específico no iFood só tem
    // uma parte delas cadastrada. Como não existe campo nenhum no iFood pra
    // preencher nesse caso, não tem o que revisar — só ficaria como ruído na
    // lista. Só contamos, não listamos mais linha por linha.
    for (const compRow of complementos) {
      const already = rowsForItem.find((r) => r.saiposCodigo === compRow['Código Saipos']);
      if (!already) semOpcaoNoIfood++;
    }

    flatRows.push(...rowsForItem);
  }

  const produtosPai = ifpsMatchProdutosPai(index, saiposRows, () => rowId++);

  return {
    rows: flatRows,
    produtosPai,
    semPlanilha: semPlanilha.map((i) => ({ itemName: i.itemName, parentCode: i.parentCode, itemInativo: i.inativo })),
    semCodigoPai: semCodigoPai.map((i) => ({ itemName: i.itemName, itemInativo: i.inativo })),
    semOpcaoNoIfood,
    skippedInativo,
  };
}

// Compara o NOME de cada item do iFood com as linhas tipo PRATO da planilha
// Saipos, pra conferir se o "código pai" que você já digitou no campo do
// item é mesmo o produto certo — diferente da comparação de complementos
// acima (que já ASSUME que o código pai está certo e só casa os
// complementos dentro dele). Roda pra todo item lido, tenha ele complemento
// casado ou não.
function ifpsMatchProdutosPai(index, saiposRows, nextRowId) {
  const pratoRows = saiposRows.filter((r) => String(r['Tipo']).trim().toUpperCase() === 'PRATO');
  if (!pratoRows.length) return [];

  // O código pai atual pode apontar pra uma linha da planilha que NÃO é
  // Tipo=PRATO (ex: um combo tipo "Monte a sua pizza" ou "Pizzas Brotos -
  // Escolha a sua", que algumas planilhas cadastram com outro Tipo) — isso é
  // um produto "pai" legítimo do mesmo jeito, só não devia entrar no POOL de
  // busca (pra não competir/confundir com pratos de verdade), mas se o
  // código atual já aponta pra uma dessas linhas, precisamos reconhecer isso
  // como válido. Sem esse mapa "de qualquer tipo", o item caía incorretamente
  // em "sem correspondência" (Criar no Saipos) mesmo já tendo um código pai
  // certo, só porque a busca só olhava pratRows.
  const anyRowByCode = new Map();
  for (const row of saiposRows) {
    const code = String(row['Código Saipos'] || '').trim();
    if (code && !anyRowByCode.has(code)) anyRowByCode.set(code, row);
  }

  const produtosPai = [];
  for (const item of index.values()) {
    const currentCode = item.parentCode || '';
    const currentRow = currentCode ? anyRowByCode.get(currentCode) : null;

    const scored = pratoRows
      .map((row) => ({ row, score: ifpsScoreProdutoComCategoria(item.itemName, row['Descrição'], item.categoryName, row['Categoria']) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    // Calculado à parte de `scored` (que só cobre o pool PRATO) — assim
    // funciona mesmo quando currentRow é de outro Tipo e nunca apareceria
    // ali.
    const currentScore = currentRow ? ifpsScoreProdutoComCategoria(item.itemName, currentRow['Descrição'], item.categoryName, currentRow['Categoria']) : -Infinity;

    // "Já correto" quando (a) o próprio prato do código atual É o que
    // melhor bate com o nome do item — não existe pra onde sugerir trocar,
    // então não faz sentido nenhum listar isso como "para revisar" com um
    // checkbox que não teria o que aplicar (foi visto ao vivo: linha "para
    // revisar" com o mesmo código sugerido E atual, checkbox sempre
    // desabilitado, sem forma de marcar) — ou (b) o código atual bate bem
    // (confiança alta) e nenhum outro prato bate NITIDAMENTE melhor (mesmo
    // critério de desempate usado nos complementos).
    const bestIsCurrent = !!currentRow && best.row === currentRow;
    const jaCorreto =
      bestIsCurrent ||
      (!!currentRow && currentScore >= IFPS_CONFIDENCE.HIGH && best.score - currentScore < 0.15);

    let chosen = null;
    let novoCodigo = '';
    let confidence = 'baixa';
    let displayScore = 0;

    if (jaCorreto) {
      chosen = currentRow;
      novoCodigo = currentCode;
      confidence = 'correto';
      displayScore = currentScore;
    } else if (best.score >= IFPS_CONFIDENCE.MEDIUM) {
      chosen = best.row;
      novoCodigo = String(chosen['Código Saipos'] || '').trim();
      confidence = ifpsClassify(best.score);
      displayScore = best.score;
    }

    // "Correto" mas vale um olhar rápido: ou tinha outro prato quase
    // empatado no nome, ou (caso do bestIsCurrent) o nome do item é bem
    // diferente do nome do prato na planilha mesmo sendo, comprovadamente, o
    // melhor candidato que existe — pode ser só uma diferença de descrição,
    // mas também pode ser um código pai digitado errado sem prato
    // correspondente cadastrado na planilha.
    const nomeSuspeito = jaCorreto && (best.row !== currentRow || currentScore < IFPS_CONFIDENCE.HIGH);

    const alternativas = scored
      .filter((s) => s.row !== chosen)
      .map((s) => ({ codigo: String(s.row['Código Saipos'] || '').trim(), descricao: s.row['Descrição'] || '', categoria: s.row['Categoria'] || '' }))
      .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR'));

    // Quantos complementos (e em quantos grupos, tipo "Tamanho"/"Sabores"/
    // "Adicionais") esse item tem no iFood — importante saber ANTES de criar
    // o produto no Saipos do zero, porque um produto novo nasce sem nenhum
    // complemento vinculado: se o item tem grupo de complemento no iFood, o
    // usuário provavelmente vai precisar montar isso manualmente no Saipos
    // depois de criar o produto básico (a extensão não faz essa parte).
    const gruposComplementos = [
      ...new Set(
        (item.options || [])
          .map((o) => (o.groupHeading || '').trim())
          .filter(Boolean)
      ),
    ];

    produtosPai.push({
      rowId: nextRowId(),
      itemName: item.itemName,
      categoriaIfood: item.categoryName || '',
      itemInativo: item.inativo,
      codigoAtual: currentCode,
      pratoNome: chosen ? chosen['Descrição'] || '' : '',
      pratoCategoria: chosen ? chosen['Categoria'] || '' : '',
      novoCodigo,
      inputId: item.inputId,
      itemid: item.itemid,
      optionid: item.isPizza ? item.pizzaParentOptionid : '',
      score: ifpsDisplayScore(displayScore),
      confidence,
      nomeSuspeito,
      semCorrespondencia: !chosen,
      alternativas,
      qtdComplementos: (item.options || []).length,
      gruposComplementos,
    });
  }

  return produtosPai;
}

// ---------- Etapa 4: aplicar (a pedido da aba de revisão) ----------

function ifpsSetInputValueReact(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // O PDV do iFood só dispara a chamada real de salvamento (POST/PUT em
  // .../menu/v4/external-code) quando o campo recebe também eventos de
  // teclado (keydown/keyup) — os eventos input/change/blur sozinhos
  // atualizam o valor na tela (por isso parecia "aplicado"), mas o backend
  // nunca era chamado e o valor sumia ao recarregar a página. Testado ao
  // vivo: sem esses dois eventos, o campo muda visualmente mas não salva;
  // com eles, salva de verdade (confirmado via toast "PDV atualizado com
  // sucesso" e nas chamadas de rede).
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));

  input.blur();
}

// O id de elemento capturado durante a varredura pode não existir mais na
// hora de aplicar: o PDV parece desmontar/re-renderizar linhas conforme você
// rola ou muda o filtro (lista "virtualizada"), e aí o React troca o id
// interno. Por isso a busca tenta, em ordem: (1) o id antigo, mais rápido
// quando nada mudou; (2) os atributos itemid/optionid, que são estáveis e
// vêm do próprio iFood; (3) rolar a página inteira procurando por esses
// atributos, caso a linha esteja fora da área renderizada no momento.
async function ifpsFindInputElement(row) {
  if (row.inputId) {
    const byId = document.getElementById(row.inputId);
    if (byId) return byId;
  }

  if (!row.itemid) return null;
  // Linhas de complemento (e o campo "Tamanho" de itens tipo pizza) sempre
  // têm optionid — usam o seletor de option-pdv-input. Já o código pai de um
  // item normal (linha da comparação "produtos pai") é o próprio
  // item-pdv-input, que não tem optionid nenhum.
  const sel = row.optionid
    ? `input[data-testid="option-pdv-input"][itemid="${CSS.escape(row.itemid)}"][optionid="${CSS.escape(row.optionid)}"]`
    : `input[data-testid="item-pdv-input"][itemid="${CSS.escape(row.itemid)}"]`;

  let el = document.querySelector(sel);
  if (el) return el;

  let lastHeight = -1;
  let stableRounds = 0;
  for (let i = 0; i < 60 && !el; i++) {
    window.scrollBy(0, Math.round(window.innerHeight * 0.8));
    await ifpsSleep(180);
    el = document.querySelector(sel);
    if (el) break;

    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 4;
    const h = document.body.scrollHeight;
    if (atBottom && h === lastHeight) {
      stableRounds++;
      if (stableRounds >= 2) break;
    } else {
      stableRounds = 0;
    }
    lastHeight = h;
  }
  return el;
}

// O iFood usa a lib Toastify pros avisos flutuantes (confirmado inspecionando
// o DOM ao vivo): quando a chamada de salvamento é recusada — na prática,
// quando aplicamos muitos códigos rápido demais em sequência e o portal
// esbarra em algum limite de velocidade dele — aparece um toast vermelho
// ".Toastify__toast-body" com o texto "Ocorreu um erro ao atualizar o PDV do
// item.". O valor do campo às vezes nem chega a "grudar" errado (o
// stuck/aria-invalid sozinhos não pegam esse caso), então esse toast é o
// sinal mais confiável de que aquela aplicação específica falhou.
const IFPS_TOAST_BODY_SELECTOR = '.Toastify__toast-body';
const IFPS_TOAST_CLOSE_SELECTOR = '.Toastify__close-button';
const IFPS_ERRO_TOAST_RE = /erro ao atualizar o pdv do item/i;

function ifpsIfoodErrorToastPresent() {
  return [...document.querySelectorAll(IFPS_TOAST_BODY_SELECTOR)].some((el) => IFPS_ERRO_TOAST_RE.test(el.innerText || ''));
}

// Fecha todo toast do iFood que estiver na tela — usado (a) antes de começar
// o lote, pra não confundir um toast de erro antigo (de uma tentativa
// anterior, ainda não dispensado) com um erro novo, e (b) depois de detectar
// um erro de verdade, pra não empilhar toast em cima de toast num lote
// grande.
function ifpsDismissAllIfoodToasts() {
  document.querySelectorAll(IFPS_TOAST_CLOSE_SELECTOR).forEach((btn) => {
    try {
      btn.click();
    } catch (err) {
      // ignora — na pior das hipóteses o toast antigo fica na tela mais um
      // pouco, não afeta a detecção (comparamos só se existe erro NOVO após
      // cada linha, então um toast preso de antes não muda o resultado).
    }
  });
}

// Pausa extra entre uma aplicação e a próxima (além do tempo que
// ifpsApplyRow já espera a chamada de salvamento terminar) — dá mais fôlego
// pro iFood não recusar por excesso de chamadas em sequência.
const IFPS_APPLY_ROW_GAP_MS = 900;
// Se mesmo assim o iFood recusar (toast de erro, valor não gravado), tenta
// de novo algumas vezes com espera crescente antes de desistir da linha.
const IFPS_APPLY_MAX_ATTEMPTS = 3;
const IFPS_APPLY_RETRY_BASE_MS = 1600;

async function ifpsApplyRow(row) {
  if (!row.novoCodigo) return { ok: false, reason: 'sem opção associada' };

  const input = await ifpsFindInputElement(row);
  if (!input) {
    return {
      ok: false,
      reason: 'campo não encontrado na página mesmo após rolar tudo — verifique se o item ainda existe e tente de novo',
    };
  }

  ifpsSetInputValueReact(input, row.novoCodigo);
  // Com os eventos de teclado, o iFood dispara a chamada de salvamento de
  // verdade (antes não disparava nada, então 180ms bastava pra "parecer"
  // aplicado). Agora tem uma requisição de rede real rolando — damos mais
  // tempo pra ela terminar antes de conferir o valor.
  await ifpsSleep(450);

  const stuck = input.value === row.novoCodigo;
  const invalid = input.getAttribute('aria-invalid') === 'true';
  const erroToast = ifpsIfoodErrorToastPresent();
  if (erroToast) ifpsDismissAllIfoodToasts();

  const ok = stuck && !invalid && !erroToast;
  const reason = ok
    ? ''
    : erroToast
    ? 'o iFood recusou a atualização (provável limite de velocidade do próprio portal)'
    : invalid
    ? 'campo marcado como inválido pelo iFood'
    : 'valor não foi mantido';

  return { ok, reason };
}

// Tenta aplicar uma linha, e se falhar (toast de erro do iFood, valor não
// gravado) tenta de novo mais algumas vezes com espera crescente — na
// prática "burla" o limite de velocidade do portal sem precisar que você
// clique de novo manualmente.
async function ifpsApplyRowWithRetry(row) {
  let res;
  for (let attempt = 1; attempt <= IFPS_APPLY_MAX_ATTEMPTS; attempt++) {
    try {
      res = await ifpsApplyRow(row);
    } catch (err) {
      console.error('[iFood PDV Sync]', err);
      res = { ok: false, reason: 'erro inesperado: ' + (err && err.message ? err.message : String(err)) };
    }
    if (res.ok || attempt === IFPS_APPLY_MAX_ATTEMPTS) break;
    await ifpsSleep(IFPS_APPLY_RETRY_BASE_MS * attempt);
    // O toast de erro do iFood leva um instante pra sumir sozinho (animação
    // de saída) — garante que nenhum resto dele continue na tela quando a
    // próxima tentativa checar de novo, senão um toast antigo ainda
    // desaparecendo poderia ser lido como um erro NOVO por engano.
    ifpsDismissAllIfoodToasts();
  }
  if (!res.ok && IFPS_APPLY_MAX_ATTEMPTS > 1) {
    res = { ...res, reason: `${res.reason} (depois de ${IFPS_APPLY_MAX_ATTEMPTS} tentativas)` };
  }
  return res;
}

async function ifpsApplyRowsOnPage(rows) {
  ifpsShowToast(`Aplicando ${rows.length} código(s) no cardápio...`, '');
  // Começa limpo: um toast de erro deixado de uma aplicação anterior (que o
  // usuário não fechou) não pode ser confundido com um erro desta rodada.
  ifpsDismissAllIfoodToasts();

  for (const row of rows) {
    // Um erro inesperado numa linha (ex: exceção ao rolar/procurar o campo)
    // não pode travar o resto do lote — sem isso, a aba de revisão nunca
    // recebia o aviso de "terminou" e o botão "Aplicar" ficava preso pra
    // sempre em "Aplicando X/N...", parecendo que nada tinha acontecido.
    const res = await ifpsApplyRowWithRetry(row);
    try {
      chrome.runtime.sendMessage({ type: 'IFPS_APPLY_RESULT', rowId: row.rowId, ok: res.ok, reason: res.reason });
    } catch (err) {
      console.error('[iFood PDV Sync]', err);
    }
    // Pausa extra entre uma linha e a próxima — reduz a chance de o iFood
    // recusar por excesso de chamadas em sequência rápida.
    await ifpsSleep(IFPS_APPLY_ROW_GAP_MS);
  }
  try {
    chrome.runtime.sendMessage({ type: 'IFPS_APPLY_DONE' });
  } catch (err) {
    console.error('[iFood PDV Sync]', err);
  }
  ifpsShowToast('Aplicação concluída. Confira o resumo na aba de revisão.', '');
}

function ifpsShowToast(msg, kind) {
  let toast = document.getElementById('ifps-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ifps-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = kind === 'err' ? 'ifps-toast-err' : '';
  toast.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.display = 'none';
  }, 6000);
}

// ---------- Integração CPlug -> iFood ----------
// Esta extensão usa o leitor/aplicador robusto do iFood acima, mas faz o
// casamento dos códigos na tela de revisão própria do CPlug.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !String(msg.type || '').startsWith('CPLUG_IFOOD_')) return undefined;

  if (msg.type === 'CPLUG_IFOOD_SCAN') {
    cplugIfoodScan().then(
      (data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: error?.message || 'Não consegui ler o iFood.' })
    );
    return true;
  }

  if (msg.type === 'CPLUG_IFOOD_APPLY') {
    cplugIfoodApply(msg.payload).then(
      (data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: error?.message || 'Não consegui aplicar no iFood.' })
    );
    return true;
  }

  return undefined;
});

async function cplugIfoodScan() {
  ifpsShowToast('Lendo o cardápio PDV do iFood...', '');
  await ifpsExpandAll();
  const index = await ifpsScanAndCapture();
  const records = [];
  const parentRecords = [];
  const complementRecords = [];

  for (const item of index.values()) {
    const parent = {
      itemId: `item:${item.itemid}`,
      name: item.itemName || '',
      parentName: '',
      groupName: item.categoryName || '',
      currentCode: item.parentCode || '',
      inputId: item.inputId || '',
      itemid: item.itemid || '',
      optionid: item.isPizza ? item.pizzaParentOptionid || '' : '',
      isPizza: Boolean(item.isPizza),
      itemInativo: Boolean(item.inativo)
    };
    parentRecords.push(parent);
    records.push(parent);

    const fallbackGroup = cplugInferIfoodFallbackGroup(item.options || []);
    for (const option of item.options || []) {
      const groupName = cplugCleanIfoodGroupName(option.groupHeading || '') || fallbackGroup;
      const complement = {
        itemId: `option:${item.itemid}:${option.optionid}`,
        name: option.optionName || '',
        parentName: item.itemName || '',
        groupName,
        currentCode: option.currentValue || '',
        inputId: option.inputId || '',
        itemid: item.itemid || '',
        optionid: option.optionid || '',
        groupid: option.groupid || '',
        categoryName: item.categoryName || '',
        itemInativo: Boolean(item.inativo)
      };
      complementRecords.push(complement);
      records.push(complement);
    }
  }

  ifpsShowToast(`iFood lido: ${parentRecords.length} produtos e ${complementRecords.length} complementos.`, '');
  return {
    platform: 'ifood',
    pageType: 'ifood',
    url: location.href,
    title: document.title,
    storeId: '',
    storeName: cplugIfoodStoreName(),
    records,
    parentRecords,
    complementRecords
  };
}

function cplugInferIfoodFallbackGroup(options) {
  const groupCounts = new Map();
  for (const option of options || []) {
    const group = cplugCleanIfoodGroupName(option.groupHeading || '');
    if (!group) continue;
    const normalized = group.toLocaleUpperCase('pt-BR');
    if (!/(ADICION|EXTRA|ACR[EÉ]SCIMO|BORDA|SABOR|MOLHO|BEBIDA|ACOMPANHAMENTO)/i.test(normalized)) continue;
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [group, count] of groupCounts) {
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return bestCount >= 2 ? best : '';
}

function cplugCleanIfoodGroupName(value) {
  return String(value || '').replace(/\b(OPCIONAL|OBRIGAT[ÓO]RIO|DISPON[IÍ]VEL|INDISPON[IÍ]VEL)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function cplugIfoodApply(payload) {
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  if (!changes.length) return { applied: 0 };
  const rows = changes.map((change) => ({
    rowId: change.itemId,
    novoCodigo: change.code,
    inputId: change.inputId || '',
    itemid: change.itemid || '',
    optionid: change.optionid || ''
  }));
  await ifpsApplyRowsOnPage(rows);
  return { applied: rows.length };
}

function cplugIfoodStoreName() {
  const candidates = [
    document.querySelector('[data-testid*="merchant"]')?.textContent,
    document.querySelector('header')?.textContent,
    document.title
  ];
  return (candidates.find((text) => String(text || '').trim()) || 'iFood').replace(/\s+/g, ' ').trim();
}
