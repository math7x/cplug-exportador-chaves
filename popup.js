(() => {
  "use strict";

  const PARENT_CODE_PATTERN = /^prod-[a-z0-9_-]+$/i;
  const TARGET_ORIGIN = "https://parceiros.online.uptecnologias.app.br";
  const fileInput = document.getElementById("fileInput");
  const fileStatus = document.getElementById("fileStatus");
  const analyzeButton = document.getElementById("btnStart");
  const openPagesButton = document.getElementById("btnPages");
  const runStatus = document.getElementById("runStatus");
  let sourceRows = null;

  fileInput.addEventListener("change", async () => {
    sourceRows = null;
    const file = fileInput.files?.[0];
    analyzeButton.disabled = true;
    if (!file) {
      fileStatus.style.display = "none";
      return;
    }
    try {
      sourceRows = await window.CPlugXlsx.read(file);
      const parents = new Set(sourceRows.map((row) => `${row.parentName}|${row.parentKey}`)).size;
      const complements = sourceRows.filter((row) => row.complementName && row.complementKey).length;
      showStatus(fileStatus, `Planilha carregada: ${parents} produtos pai e ${complements} complementos.`, "ok");
      analyzeButton.disabled = false;
    } catch (error) {
      showStatus(fileStatus, error?.message || "Não consegui ler esse arquivo.", "err");
    }
  });

  openPagesButton.addEventListener("click", async () => {
    await Promise.all([
      chrome.tabs.create({ url: `${TARGET_ORIGIN}/catalogo`, active: true }),
      chrome.tabs.create({ url: `${TARGET_ORIGIN}/edicao-complementos`, active: false })
    ]);
    window.close();
  });

  analyzeButton.addEventListener("click", async () => {
    analyzeButton.disabled = true;
    try {
      showStatus(runStatus, "Lendo a planilha e conferindo as duas telas da loja…");
      sourceRows ||= await window.CPlugXlsx.read(fileInput.files[0]);
      const pair = await findMatchingStorePair();
      const plan = buildPlan(sourceRows, pair);
      await chrome.storage.local.set({ cplugPdvPlan: plan });
      await chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
      window.close();
    } catch (error) {
      showStatus(runStatus, error?.message || "Não foi possível preparar a revisão.", "err");
      analyzeButton.disabled = false;
    }
  });

  async function findMatchingStorePair() {
    const tabs = await chrome.tabs.query({
      url: [`${TARGET_ORIGIN}/catalogo*`, `${TARGET_ORIGIN}/edicao-complementos*`]
    });
    const scans = [];
    for (const tab of tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "CPLUG_UP_SCAN" });
        if (response?.ok) scans.push({ tab, data: response.data });
      } catch {
        // A tela pode ter sido aberta antes da atualização da extensão.
      }
    }

    const groups = new Map();
    for (const scan of scans) {
      const key = scan.data.storeId ? `id:${scan.data.storeId}` : `name:${normalize(scan.data.storeName)}`;
      if (!groups.has(key)) groups.set(key, { catalog: [], complements: [] });
      groups.get(key)[scan.data.pageType].push(scan);
    }
    const pairs = [...groups.values()].filter((group) => group.catalog.length && group.complements.length);
    if (!pairs.length) {
      throw new Error("Não encontrei Catálogo e Edição de complementos abertos na mesma loja. Abra as duas telas, confira a loja no topo e atualize as páginas.");
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const preferred = pairs.find((group) => [...group.catalog, ...group.complements].some((scan) => scan.tab.id === activeTab?.id)) || pairs[0];
    return {
      catalog: preferred.catalog[0],
      complements: preferred.complements[0]
    };
  }

  function buildPlan(rows, pair) {
    const parentOptions = uniqueBy(
      rows.map((row) => ({ name: row.parentName, code: row.parentKey })),
      (option) => `${option.code.toLowerCase()}|${normalize(option.name)}`
    ).map((option, id) => ({ id, ...option }));
    const complementOptions = uniqueBy(
      rows.filter((row) => row.complementName && row.complementKey).map((row) => ({
        name: row.complementName,
        code: row.complementKey,
        parentName: row.parentName,
        parentCode: row.parentKey
      })),
      (option) => `${option.parentCode.toLowerCase()}|${normalize(option.name)}|${option.code.toLowerCase()}`
    ).map((option, id) => ({ id, ...option }));

    const parentMatches = matchParents(parentOptions, pair.catalog.data.records);
    const parentCodeByName = buildParentCodeIndex(pair.catalog.data.records);
    // Complementos cujo produto pai ainda não tem código PDV preenchido no
    // Catálogo ficam fora da revisão: primeiro se preenche o pai.
    const complementTargets = pair.complements.data.records.filter((record) => parentCodeByName.has(normalize(record.parentName)));
    const skippedNoParentCode = pair.complements.data.records.length - complementTargets.length;
    const complementMatches = matchComplements(complementOptions, parentOptions, parentCodeByName, complementTargets);

    const storeId = pair.catalog.data.storeId || pair.complements.data.storeId || "";
    const storeName = pair.catalog.data.storeName || pair.complements.data.storeName;
    return {
      version: 3,
      createdAt: new Date().toISOString(),
      fileName: fileInput.files[0].name,
      storeId,
      storeName,
      tabs: {
        catalog: { id: pair.catalog.tab.id, url: pair.catalog.data.url },
        complements: { id: pair.complements.tab.id, url: pair.complements.data.url }
      },
      sourceCount: rows.length,
      skippedNoParentCode,
      targetCount: parentMatches.length + complementMatches.length,
      parentOptions,
      complementOptions,
      matches: [...parentMatches, ...complementMatches]
    };
  }

  function uniqueBy(items, getKey) {
    const seen = new Map();
    for (const item of items) {
      const key = getKey(item);
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  function collapseSources(sources, type) {
    const grouped = new Map();
    for (const source of sources) {
      const key = type === "parent" ? normalize(source.name) : `${normalize(source.parentName)}|${normalize(source.name)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(source);
    }
    return [...grouped.values()].map((items) => {
      const codes = [...new Set(items.map((item) => item.code))];
      return { ...items[0], conflict: codes.length > 1, conflictingCodes: codes };
    });
  }

  // Produtos pai: o código atual do cadastro tem prioridade. Se ele existe no
  // Excel, o item é considerado correto (com aviso quando os nomes divergem).
  function matchParents(parentOptions, targets) {
    const byCode = new Map(parentOptions.map((option) => [option.code.toLowerCase(), option]));
    const sources = collapseSources(parentOptions.map((option) => ({ name: option.name, code: option.code, parentName: "" })), "parent");
    return targets.map((target, index) => {
      const current = byCode.get(cleanText(target.currentCode).toLowerCase());
      if (current) {
        const note = normalize(current.name) === normalize(target.name) ? "" : `No Excel este código é de “${current.name}”. Confira.`;
        return correctMatch(target, current, "parent", index, note);
      }
      const candidates = rankSources(target.name, sources, (source) => source.name);
      return createTargetMatch(target, candidates, "parent", index);
    });
  }

  // Nome do produto pai na UP -> códigos prod- preenchidos no Catálogo.
  function buildParentCodeIndex(catalogRecords) {
    const index = new Map();
    for (const record of catalogRecords) {
      const code = cleanText(record.currentCode).toLowerCase();
      // Só vale código PDV de produto real; "null", "0", espaços etc. contam como vazio.
      if (!PARENT_CODE_PATTERN.test(code)) continue;
      const key = normalize(record.name);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(code);
    }
    return index;
  }

  // Complementos do Excel que pertencem ao produto pai deste complemento da UP.
  function complementScope(target, complementOptions, parentOptions, parentCodeByName) {
    const parentKey = normalize(target.parentName);
    // O nome do produto pai exibido na UP é a referência principal. Isso é
    // importante quando o código PDV atual do pai aponta para uma linha antiga
    // ou duplicada do Excel que não possui complementos.
    const byName = complementOptions.filter((option) => normalize(option.parentName) === parentKey);
    if (byName.length) {
      return {
        list: byName,
        reason: `Excel: complementos de “${target.parentName}”`
      };
    }

    // O código do pai fica como apoio quando o nome mudou entre a UP e o Excel.
    const codes = parentCodeByName.get(parentKey);
    if (codes && codes.size === 1) {
      const [code] = codes;
      const list = complementOptions.filter((option) => option.parentCode.toLowerCase() === code);
      if (list.length) return { list, reason: `Excel: complementos do código pai ${code}` };
    }

    const filledCodes = codes ? [...codes].join(", ") : "";
    const names = uniqueBy(parentOptions.map((option) => option.name), normalize);
    const ranked = names.map((name) => ({ name, score: similarity(target.parentName, name) })).sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    if (best && best.score >= 0.85 && (!next || best.score - next.score >= 0.05)) {
      const list = complementOptions.filter((option) => normalize(option.parentName) === normalize(best.name));
      if (list.length) {
        return { list, fuzzy: true, reason: `Excel: produto pai parecido “${best.name}” (${Math.round(best.score * 100)}%)` };
      }
    }
    return { list: [], reason: filledCodes ? `Código pai ${filledCodes} não tem complementos no Excel` : "Produto pai não encontrado no Excel" };
  }

  function matchComplements(complementOptions, parentOptions, parentCodeByName, targets) {
    const globalByCode = new Map(complementOptions.map((option) => [option.code.toLowerCase(), option]));
    return targets.map((target, index) => {
      const scope = complementScope(target, complementOptions, parentOptions, parentCodeByName);
      const current = cleanText(target.currentCode).toLowerCase();
      const currentOption = current && scope.list.find((option) => option.code.toLowerCase() === current);
      let match;

      if (currentOption) {
        const note = targetNameMatchesSource(target, currentOption.name) ? "" : `No Excel este código é de “${currentOption.name}”. Confira.`;
        match = correctMatch(target, currentOption, "complement", index, note);
      } else {
        const sources = collapseSources(scope.list.map((option) => ({
          name: option.name,
          code: option.code,
          parentName: option.parentName
        })), "complement");
        const candidates = rankSources(target, sources, (source) => source.name);
        match = createTargetMatch(target, candidates, "complement", index);
        if (scope.fuzzy && match.status === "exact") {
          match.status = "approximate";
          match.selected = false;
        }
        const elsewhere = current && globalByCode.get(current);
        if (elsewhere) match.note = `Código atual é de outro produto pai no Excel: ${elsewhere.parentName} > ${elsewhere.name}`;
      }

      match.optionIds = scope.list.map((option) => option.id);
      match.scopeReason = scope.reason;
      return match;
    });
  }

  function correctMatch(target, option, type, index, note) {
    return {
      id: `${type === "parent" ? "p" : "c"}-${index}`,
      type,
      sourceName: option.name,
      parentName: option.parentName || "",
      code: option.code,
      targetId: target.itemId,
      targetName: target.name,
      targetParent: target.parentName || "",
      targetGroup: target.groupName || "",
      currentCode: target.currentCode || "",
      score: 100,
      status: "correct",
      note,
      selected: false
    };
  }

  function rankSources(target, sources, getName) {
    const variants = targetNameVariants(target);
    return sources.map((source) => {
      const sourceName = getName(source);
      const ranked = variants.map((name) => ({
        name,
        score: similarity(name, sourceName),
        exact: normalize(name) === normalize(sourceName)
      })).sort((a, b) => b.score - a.score);
      const best = ranked[0] || { score: 0, exact: false };
      return {
        source,
        score: best.score,
        exact: best.exact,
        matchedName: best.name
      };
    }).sort((a, b) => b.score - a.score);
  }

  function targetNameVariants(target) {
    const name = cleanText(typeof target === "string" ? target : target?.name);
    const group = cleanText(target?.groupName);
    const variants = [name];
    if (group && normalize(group) !== normalize(name)) variants.push(`${group} ${name}`);
    return uniqueBy(variants.filter(Boolean), normalize);
  }

  function targetNameMatchesSource(target, sourceName) {
    return targetNameVariants(target).some((name) => normalize(name) === normalize(sourceName));
  }

  function createTargetMatch(target, candidates, type, index) {
    const exact = candidates.filter((candidate) => candidate.exact);
    const best = exact.length === 1 ? exact[0] : candidates[0];
    const next = candidates.find((candidate) => candidate !== best);
    let matchStatus = "unmatched";
    if (exact.length > 1) matchStatus = "ambiguous";
    else if (exact.length === 1) matchStatus = "exact";
    else if (best && best.score >= 0.90 && (!next || best.score - next.score >= 0.05)) matchStatus = "approximate";
    else if (best && best.score >= 0.90) matchStatus = "ambiguous";

    const source = ["exact", "approximate"].includes(matchStatus) ? best.source : null;
    if (source?.conflict) matchStatus = "conflict";
    const code = source?.conflict ? source.conflictingCodes.join(" / ") : source?.code || "";
    const alreadyCorrect = Boolean(code && cleanText(target.currentCode).toLowerCase() === cleanText(code).toLowerCase());
    if (alreadyCorrect) matchStatus = "correct";
    return {
      id: `${type === "parent" ? "p" : "c"}-${index}`,
      type,
      sourceName: source?.name || "",
      parentName: source?.parentName || "",
      code,
      targetId: target.itemId,
      targetName: target.name,
      targetParent: target.parentName || "",
      targetGroup: target.groupName || "",
      currentCode: target.currentCode || "",
      score: best ? Math.round(best.score * 100) : 0,
      status: matchStatus,
      note: "",
      selected: matchStatus === "exact"
    };
  }

  function similarity(left, right) {
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const distance = levenshtein(a, b);
    const sequence = 1 - distance / Math.max(a.length, b.length);
    const aTokens = new Set(a.split(" "));
    const bTokens = new Set(b.split(" "));
    const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
    const union = new Set([...aTokens, ...bTokens]).size;
    const tokenScore = union ? intersection / union : 0;
    return Math.max(sequence, tokenScore * 0.96);
  }

  function levenshtein(a, b) {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const above = previous[j];
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return previous[b.length];
  }

  function normalize(value) {
    return cleanText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]+/gi, " ").trim().toUpperCase();
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function showStatus(element, message, tone = "") {
    element.style.display = "block";
    element.textContent = message;
    element.className = `status${tone ? ` ${tone}` : ""}`;
  }
})();
