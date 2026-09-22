(() => {
  "use strict";

  const main = document.getElementById("rv-main");
  const empty = document.getElementById("rv-empty");
  const summary = document.getElementById("rv-summary-bar");
  const meta = document.getElementById("rv-meta");
  const applyButton = document.getElementById("rv-btn-apply");
  const footer = document.getElementById("rv-final-summary");
  const progress = document.getElementById("rv-progress");
  const progressTitle = document.getElementById("rv-progress-title");
  const progressDetail = document.getElementById("rv-progress-detail");
  const PREFIX = { parent: "prod-", complement: "att-" };
  const ATTENTION = ["approximate", "unmatched", "ambiguous", "conflict"];
  let plan;
  let matchesById = new Map();
  let activeTab = "complement";
  let saveTimer = null;

  initialize();

  async function initialize() {
    const stored = await chrome.storage.local.get("cplugPdvPlan");
    plan = stored.cplugPdvPlan;
    if (!plan?.matches?.length || plan.version !== 3) {
      meta.textContent = "Nenhuma análise disponível.";
      empty.textContent = "Esta revisão é de uma análise antiga ou não existe. Abra o popup da extensão e execute a análise novamente.";
      empty.style.display = "block";
      return;
    }
    plan.parentOptions ||= [];
    plan.complementOptions ||= [];
    matchesById = new Map(plan.matches.map((match) => [match.id, match]));
    meta.textContent = `${plan.storeName} • ${plan.fileName} • ${plan.parentOptions.length} produtos pai e ${plan.complementOptions.length} complementos no Excel • ${plan.skippedNoParentCode || 0} complemento(s) ocultos por produto pai sem código PDV`;
    bindEvents();
    render();
  }

  function bindEvents() {
    document.getElementById("rv-tabs").addEventListener("click", (event) => {
      const button = event.target.closest(".rv-tab-btn");
      if (!button) return;
      activeTab = button.dataset.tab;
      document.querySelectorAll(".rv-tab-btn").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      renderMain();
      updateApplyButton();
    });

    // `input` reconhece na hora um código colado ou um item escolhido na lista;
    // `change` avisa quando o texto digitado não corresponde a nada.
    main.addEventListener("input", (event) => {
      if (!event.target.classList.contains("rv-search")) return;
      // Digitação letra por letra só é confirmada no Enter/saída do campo,
      // para "att-1-2" não ser aceito antes de você terminar "att-1-28".
      if (/^(insertText|delete)/.test(event.inputType || "")) {
        clearRowError(event.target);
        return;
      }
      onSearch(event.target, false);
    });

    main.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.classList.contains("rv-search")) {
        event.preventDefault();
        onSearch(event.target, true);
      }
    });

    main.addEventListener("change", (event) => {
      if (event.target.classList.contains("rv-search")) {
        onSearch(event.target, true);
        return;
      }
      if (event.target.classList.contains("rv-check")) {
        onCheck(event.target);
        return;
      }
      if (event.target.classList.contains("rv-check-all")) {
        const ids = event.target.dataset.ids.split(",").filter(Boolean);
        ids.map((id) => matchesById.get(id)).filter((match) => match && canApply(match)).forEach((match) => {
          match.selected = event.target.checked;
        });
        scheduleSave();
        renderMain();
        renderSummary();
        updateApplyButton();
      }
    });

    applyButton.addEventListener("click", applySelected);
    document.getElementById("rv-btn-export").addEventListener("click", exportCsv);
  }

  // ---------- regras ----------

  function hasCode(match) {
    return Boolean(clean(match.code)) && !match.code.includes(" / ");
  }

  function sameAsCurrent(match) {
    return clean(match.code).toLowerCase() === clean(match.currentCode).toLowerCase();
  }

  function canApply(match) {
    return ["exact", "approximate", "manual"].includes(match.status) && Boolean(match.targetId) && hasCode(match) && !sameAsCurrent(match);
  }

  function isEditable(match) {
    if (match.status === "applied") return false;
    if (match.status === "correct") return Boolean(match.note);
    return Boolean(match.targetId);
  }

  function isPending(match) {
    return match.selected && !canApply(match);
  }

  function optionsFor(match) {
    if (match.type === "parent") return plan.parentOptions;
    return (match.optionIds || []).map((id) => plan.complementOptions[id]).filter(Boolean);
  }

  function optionLabel(option) {
    return `${clean(option.name) || "(sem nome)"} — ${clean(option.code)}`;
  }

  // ---------- renderização ----------

  function render() {
    renderSummary();
    renderTabCounts();
    renderMain();
    updateApplyButton();
  }

  function renderSummary() {
    const count = (fn) => plan.matches.filter(fn).length;
    summary.innerHTML = [
      stat(plan.matches.length, "itens da UP analisados"),
      stat(count((match) => match.selected && canApply(match)), "selecionadas"),
      stat(count((match) => ["correct", "applied"].includes(match.status)), "já corretas / aplicadas"),
      stat(count((match) => match.status === "exact"), "correspondências exatas"),
      stat(count((match) => match.status === "manual"), "escolhidas por você"),
      stat(count((match) => match.status === "approximate"), "aproximadas"),
      stat(count((match) => ["unmatched", "ambiguous", "conflict"].includes(match.status)), "sem código seguro no Excel")
    ].join("");
  }

  function renderTabCounts() {
    const counts = {
      complement: plan.matches.filter((match) => match.type === "complement").length,
      parent: plan.matches.filter((match) => match.type === "parent").length,
      attention: plan.matches.filter((match) => ATTENTION.includes(match.status)).length
    };
    const labels = { complement: "Complementos", parent: "Produtos pai", attention: "Exigem atenção" };
    document.querySelectorAll(".rv-tab-btn").forEach((button) => {
      button.innerHTML = `${labels[button.dataset.tab]} <span class="rv-tab-count">${counts[button.dataset.tab]}</span>`;
    });
  }

  function renderMain() {
    const matches = visibleMatches();
    const sections = [
      { title: "Já estavam corretos", statuses: ["correct", "applied"], className: "rv-sec-correto", hint: "O código atual existe no Excel para este item. Linhas com aviso amarelo têm nome diferente no Excel e podem ser corrigidas pelo campo de busca.", open: false },
      { title: "Escolhidos por você", statuses: ["manual"], className: "rv-sec-manual", hint: "Código escolhido manualmente no campo de busca. Já ficam marcados para aplicar.", open: true },
      { title: "Nome exato — código diferente", statuses: ["exact"], className: "rv-sec-alta", hint: "O item da UP encontrou no Excel o mesmo nome dentro do mesmo produto pai.", open: true },
      { title: "Correspondência aproximada — confira antes de marcar", statuses: ["approximate"], className: "rv-sec-media", hint: "Nome parecido. Confira ou troque pelo campo de busca antes de marcar.", open: true },
      { title: "Sem correspondência segura no Excel", statuses: ["unmatched", "ambiguous", "conflict"], className: "rv-sec-baixa", hint: "Digite no campo de busca para escolher o código. Nos complementos, a lista mostra somente os complementos do produto pai no Excel.", open: true }
    ];
    const datalists = new Map();
    const html = sections
      .map((section) => sectionHtml(section, matches.filter((match) => section.statuses.includes(match.status)), datalists))
      .filter(Boolean)
      .join("");
    main.querySelectorAll("details.rv-section, datalist.rv-datalist").forEach((element) => element.remove());
    empty.style.display = html ? "none" : "block";
    main.insertAdjacentHTML("beforeend", datalistsHtml(datalists) + html);
  }

  // Uma datalist por lista de opções distinta: todos os produtos pai
  // compartilham uma só; complementos do mesmo produto pai também.
  function datalistId(match, datalists) {
    const key = match.type === "parent" ? "parent" : `c:${(match.optionIds || []).join(",")}`;
    if (!datalists.has(key)) datalists.set(key, { id: `rv-dl-${datalists.size}`, options: optionsFor(match) });
    return datalists.get(key).id;
  }

  function datalistsHtml(datalists) {
    return [...datalists.values()].map(({ id, options }) =>
      `<datalist class="rv-datalist" id="${id}">${options.map((option) => `<option value="${escapeHtml(optionLabel(option))}"></option>`).join("")}</datalist>`
    ).join("");
  }

  function sectionHtml(section, matches, datalists) {
    if (!matches.length) return "";
    const selectable = matches.filter(canApply);
    const selected = selectable.filter((match) => match.selected).length;
    const checked = selectable.length && selected === selectable.length ? "checked" : "";
    const ids = selectable.map((match) => match.id).join(",");
    return `<details class="rv-section ${section.className}" ${section.open ? "open" : ""}>
      <summary><span>${section.title}</span><span class="rv-count-badge">${matches.length}</span></summary>
      <div class="rv-section-body">
        <p class="rv-section-hint">${section.hint}</p>
        <table class="rv-table">
          <thead><tr>
            <th><input class="rv-check-all" type="checkbox" data-ids="${ids}" ${checked} ${selectable.length ? "" : "disabled"} aria-label="Selecionar esta seção"></th>
            <th>Tipo</th><th>Item no catálogo da UP</th><th>Correspondência no Excel</th><th>Código atual</th><th>Novo código PDV</th><th>Resultado</th>
          </tr></thead>
          <tbody>${matches.map((match) => rowHtml(match, datalists)).join("")}</tbody>
        </table>
      </div>
    </details>`;
  }

  function rowHtml(match, datalists) {
    const targetParent = match.type === "complement" ? `<div class="rv-parent-code">Produto pai: ${escapeHtml(match.targetParent)}</div>` : "";
    const editable = isEditable(match);
    const current = match.currentCode ? escapeHtml(match.currentCode) : '<span class="rv-muted">vazio</span>';
    const canSelect = canApply(match);
    return `<tr data-row="${match.id}">
      <td><input class="rv-check" type="checkbox" data-id="${match.id}" ${match.selected && canSelect ? "checked" : ""} ${canSelect ? "" : "disabled"}></td>
      <td><span class="rv-type-badge">${match.type === "parent" ? "Produto pai" : "Complemento"}</span></td>
      <td class="rv-item-name"><strong>${escapeHtml(match.targetName)}</strong>${targetParent}</td>
      <td class="rv-item-name rv-source-cell">
        <div class="rv-source-content">${sourceHtml(match)}</div>
        ${editable ? searchHtml(match, datalistId(match, datalists)) : ""}
      </td>
      <td>${current}</td>
      <td class="rv-new-code">${codeHtml(match)}</td>
      <td class="rv-status-cell">${statusHtml(match)}</td>
    </tr>`;
  }

  function sourceHtml(match) {
    if (!match.sourceName) return '<span class="rv-muted">Nenhuma linha correspondente no Excel</span>';
    const parent = match.type === "complement" && match.parentName ? `<div class="rv-parent-code">Produto pai: ${escapeHtml(match.parentName)}</div>` : "";
    return `<strong>${escapeHtml(match.sourceName)}</strong>${parent}`;
  }

  function searchHtml(match, listId) {
    const total = optionsFor(match).length;
    let hint;
    if (match.type === "parent") {
      hint = `Busca em todos os ${total} produtos pai do Excel · código prod- colado é reconhecido na hora`;
    } else if (total) {
      hint = `${escapeHtml(match.scopeReason || "")} · pesquise entre ${total} complemento${total === 1 ? "" : "s"} deste produto pai`;
    } else {
      hint = `${escapeHtml(match.scopeReason || "Produto pai não encontrado no Excel")} · nenhum complemento disponível para pesquisar`;
    }
    const placeholder = match.type === "parent" ? "Busque o produto ou cole o código prod-..." : "Busque o complemento ou cole o código att-...";
    return `<div class="rv-search-wrap">
      <input type="search" class="rv-search" data-id="${match.id}" list="${listId}" autocomplete="off" placeholder="${placeholder}">
      <div class="rv-search-hint">${hint}</div>
    </div>`;
  }

  function codeHtml(match) {
    if (!match.code) return '<span class="rv-muted">—</span>';
    return escapeHtml(match.code);
  }

  function statusHtml(match) {
    const labels = {
      exact: "nome exato — código diferente",
      approximate: `${match.score}% de semelhança — confira`,
      manual: "✎ escolhido por você",
      correct: "✔ já estava correto",
      applied: "✔ salvo e verificado",
      unmatched: "✘ sem correspondência no Excel",
      ambiguous: "✘ mais de uma linha possível no Excel",
      conflict: "✘ códigos conflitantes no Excel"
    };
    let tone = ["correct", "applied", "exact", "manual"].includes(match.status) ? "rv-ok" : match.status === "approximate" ? "rv-warn" : "rv-fail";
    let label = labels[match.status] || match.status;
    if (match.status === "manual" && sameAsCurrent(match)) label = "✔ já é o código atual";
    if (isPending(match)) {
      tone = "rv-warn";
      label = "marcado — escolha o código no campo de busca";
    }
    const extra = [match.note, match.manualWarning].filter(Boolean)
      .map((text) => `<div class="rv-status rv-warn">⚠ ${escapeHtml(text)}</div>`).join("");
    return `<div class="rv-status ${tone}">${label}</div>${extra}`;
  }

  function refreshRow(match) {
    const row = main.querySelector(`tr[data-row="${cssEscape(match.id)}"]`);
    if (!row) return;
    row.querySelector(".rv-source-content").innerHTML = sourceHtml(match);
    row.querySelector(".rv-new-code").innerHTML = codeHtml(match);
    row.querySelector(".rv-status-cell").innerHTML = statusHtml(match);
    const checkbox = row.querySelector(".rv-check");
    checkbox.checked = Boolean(match.selected);
    checkbox.disabled = !canApply(match);
  }

  function showRowError(input, message) {
    const cell = input.closest("tr")?.querySelector(".rv-status-cell");
    if (!cell) return;
    cell.querySelectorAll(".rv-search-error").forEach((element) => element.remove());
    cell.insertAdjacentHTML("beforeend", `<div class="rv-status rv-fail rv-search-error">✘ ${escapeHtml(message)}</div>`);
  }

  function clearRowError(input) {
    input.closest("tr")?.querySelectorAll(".rv-search-error").forEach((element) => element.remove());
  }

  // ---------- escolha manual ----------

  function onSearch(input, strict) {
    const match = matchesById.get(input.dataset.id);
    if (!match) return;
    const typed = clean(input.value).toLowerCase();
    clearRowError(input);
    if (!typed) return;

    const options = optionsFor(match);
    let picked = options.find((option) => optionLabel(option).toLowerCase() === typed || clean(option.code).toLowerCase() === typed);

    if (!picked && match.type === "complement") {
      const elsewhere = plan.complementOptions.find((option) => clean(option.code).toLowerCase() === typed);
      if (elsewhere) {
        if (strict) showRowError(input, `Esse código é de “${elsewhere.parentName} > ${elsewhere.name}”, não deste produto pai.`);
        return;
      }
    }

    if (!picked) {
      if (strict) showRowError(input, "Escolha um item da lista ou cole um código existente no Excel.");
      return;
    }
    if (!clean(picked.code).toLowerCase().startsWith(PREFIX[match.type])) {
      showRowError(input, `O código “${picked.code}” não é do tipo ${PREFIX[match.type]}.`);
      return;
    }

    match.code = clean(picked.code);
    match.sourceName = picked.name;
    match.parentName = picked.parentName || "";
    match.manualWarning = "";
    match.score = null;

    if (sameAsCurrent(match)) {
      // Nada a alterar: a linha vai para "Já estavam corretos".
      match.status = "correct";
      match.note = "";
      match.manualWarning = "";
      match.selected = false;
      scheduleSave();
      render();
      return;
    }

    match.status = "manual";
    match.selected = true;
    input.value = "";
    refreshRow(match);
    scheduleSave();
    renderSummary();
    renderTabCounts();
    updateApplyButton();
  }

  function onCheck(checkbox) {
    const match = matchesById.get(checkbox.dataset.id);
    if (!match) return;
    match.selected = checkbox.checked;
    refreshRow(match);
    if (checkbox.checked && !canApply(match)) {
      checkbox.closest("tr")?.querySelector(".rv-search")?.focus();
    }
    scheduleSave();
    renderSummary();
    updateApplyButton();
  }

  function visibleMatches() {
    if (activeTab === "attention") return plan.matches.filter((match) => ATTENTION.includes(match.status));
    return plan.matches.filter((match) => match.type === activeTab);
  }

  function selectedVisible() {
    return visibleMatches().filter((match) => match.selected);
  }

  function updateApplyButton() {
    const selected = selectedVisible();
    const ready = selected.filter(canApply);
    const pending = selected.length - ready.length;
    if (pending) {
      applyButton.textContent = `Escolha o código de ${pending} marcado${pending === 1 ? "" : "s"}`;
    } else {
      applyButton.textContent = ready.length ? `⚠️ Aplicar selecionados (${ready.length})` : "⚠️ Aplicar selecionados";
    }
    applyButton.disabled = !ready.length || pending > 0;
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      chrome.storage.local.set({ cplugPdvPlan: plan }).catch(() => {});
    }, 300);
  }

  // ---------- aplicação ----------

  async function applySelected() {
    const selected = selectedVisible().filter(canApply);
    const parents = selected.filter((match) => match.type === "parent");
    const complements = selected.filter((match) => match.type === "complement");
    if (!selected.length) return;
    const manual = selected.filter((match) => match.status === "manual").length;
    const confirmed = window.confirm(
      `Isso vai escrever e salvar ${selected.length} código${selected.length === 1 ? "" : "s"} no catálogo da UP Tecnologias.\n\nProdutos pai: ${parents.length}\nComplementos individuais: ${complements.length}\nEscolhidos manualmente: ${manual}\nLoja: ${plan.storeName}\n\nConfirma que quer aplicar agora?`
    );
    if (!confirmed) return;

    setProgress(true, "Preparando alterações...", "As telas serão conferidas novamente antes de salvar.");
    const completed = [];
    try {
      if (parents.length) {
        setProgress(true, "Salvando produtos pai...", `${parents.length} códigos no Catálogo.`);
        await applyPage("catalog", parents);
        completed.push(...parents);
      }
      if (complements.length) {
        setProgress(true, "Salvando complementos...", `${complements.length} campos Cód. PDV individuais.`);
        await applyPage("complements", complements);
        completed.push(...complements);
      }
      finishCompleted(completed);
      await chrome.storage.local.set({ cplugPdvPlan: plan });
      setProgress(false);
      showFooter(`✔ ${completed.length} código${completed.length === 1 ? "" : "s"} salvo${completed.length === 1 ? "" : "s"} e verificado${completed.length === 1 ? "" : "s"} com sucesso.`);
      render();
    } catch (error) {
      finishCompleted(completed);
      await chrome.storage.local.set({ cplugPdvPlan: plan });
      setProgress(false);
      const prefix = completed.length ? `✔ ${completed.length} concluído(s) antes da falha.<br>` : "";
      showFooter(`${prefix}✘ ${escapeHtml(error?.message || "Não foi possível concluir o salvamento.")}`, true);
      render();
    }
  }

  function finishCompleted(matches) {
    matches.forEach((match) => {
      match.status = "applied";
      match.currentCode = match.code;
      match.selected = false;
      match.note = "";
    });
  }

  async function applyPage(pageType, matches) {
    const tabId = plan.tabs[pageType].id;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      throw new Error(pageType === "catalog" ? "A tela Catálogo foi fechada." : "A tela Edição de complementos foi fechada.");
    }

    const changes = matches.map((match) => ({ itemId: match.targetId, code: match.code, expectedName: match.targetName, expectedParent: match.targetParent }));
    const payload = { pageType, storeId: plan.storeId, storeName: plan.storeName, changes };
    const staged = await send(tabId, { type: "CPLUG_UP_STAGE", payload });
    if (staged.staged !== changes.length) throw new Error("Nem todos os campos puderam ser preparados. Nada foi salvo nesta tela.");
    await send(tabId, { type: "CPLUG_UP_COMMIT", payload });
    if (pageType === "catalog") {
      await delay(500);
      await chrome.tabs.reload(tabId);
    }
    await waitForVerifiedScan(tabId, matches, 45_000);
  }

  async function send(tabId, message) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch {
      throw new Error("Atualize as telas Catálogo e Edição de complementos e faça uma nova análise.");
    }
    if (!response?.ok) throw new Error(response?.error || "O portal bloqueou a alteração.");
    return response.data;
  }

  async function waitForVerifiedScan(tabId, matches, timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "CPLUG_UP_SCAN" });
        if (response?.ok) {
          const scan = response.data;
          if (plan.storeId && scan.storeId && String(scan.storeId) !== String(plan.storeId)) {
            throw new Error("A loja mudou durante a verificação. Confira o portal antes de continuar.");
          }
          const records = new Map(scan.records.map((record) => [String(record.itemId), record]));
          const verified = matches.every((match) => clean(records.get(String(match.targetId))?.currentCode).toLowerCase() === clean(match.code).toLowerCase());
          if (verified) return;
        }
      } catch (error) {
        if (/A loja mudou/.test(error?.message || "")) throw error;
      }
      await delay(700);
    }
    throw new Error("Os códigos não apareceram após recarregar a tela. Revise os itens no portal antes de tentar novamente.");
  }

  // ---------- utilitários ----------

  function exportCsv() {
    if (!plan) return;
    const lines = [["Tipo", "Produto pai UP", "Item na UP", "Correspondência no Excel", "Produto pai no Excel", "Código atual", "Novo código", "Resultado", "Origem das opções", "Aviso"].join(";")];
    for (const match of plan.matches) {
      lines.push([
        match.type === "parent" ? "Produto pai" : "Complemento",
        match.targetParent,
        match.targetName,
        match.sourceName,
        match.parentName,
        match.currentCode,
        match.code,
        match.status,
        match.scopeReason,
        [match.note, match.manualWarning].filter(Boolean).join(" | ")
      ].map(csvCell).join(";"));
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cplug-pdv-sync-relatorio.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function setProgress(visible, title = "", detail = "") {
    progress.hidden = !visible;
    if (title) progressTitle.textContent = title;
    if (detail) progressDetail.textContent = detail;
  }

  function showFooter(message, error = false) {
    footer.innerHTML = `<strong>Resumo</strong><br>${message}`;
    footer.className = error ? "rv-error" : "";
    footer.style.display = "block";
    footer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function stat(value, label) {
    return `<div class="rv-stat"><strong>${value}</strong><span>${label}</span></div>`;
  }

  function csvCell(value) {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
  }

  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return clean(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();
