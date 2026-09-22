(() => {
  "use strict";

  const PAGE_CATALOG = "catalog";
  const PAGE_COMPLEMENTS = "complements";
  const CODE_PATTERN = /^(?:prod|att)-[a-z0-9_-]+$/i;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !String(message.type || "").startsWith("CPLUG_UP_")) return undefined;

    try {
      if (message.type === "CPLUG_UP_SCAN") {
        sendResponse({ ok: true, data: scanPage() });
      } else if (message.type === "CPLUG_UP_STAGE") {
        sendResponse({ ok: true, data: stageChanges(message.payload) });
      } else if (message.type === "CPLUG_UP_COMMIT") {
        const result = prepareCommit(message.payload);
        if (result.pageType === PAGE_CATALOG) {
          commitCatalog(result.button).then(
            () => sendResponse({ ok: true, data: { started: true, pageType: result.pageType } }),
            (error) => sendResponse({ ok: false, error: error?.message || "O salvamento não terminou no Catálogo." })
          );
        } else {
          sendResponse({ ok: true, data: { started: true, pageType: result.pageType } });
          window.setTimeout(() => result.button.click(), 40);
        }
      }
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || "Erro inesperado no portal." });
    }
    return true;
  });

  function scanPage() {
    const pageType = detectPageType();
    const identity = readStoreIdentity();
    const records = pageType === PAGE_CATALOG ? scanParents() : scanComplements();
    return {
      pageType,
      url: location.href,
      title: document.title,
      storeId: identity.storeId,
      storeName: identity.storeName,
      records
    };
  }

  function scanParents() {
    return [...document.querySelectorAll('div[form_item][id_item_form]')].map((form) => {
      const oldValues = form.querySelector('[old_values]');
      const nameInput = form.querySelector('input[name="nome_item"]');
      const codeInput = form.querySelector('input[name="cod_pdv"]');
      return {
        itemId: form.getAttribute("id_item_form"),
        name: cleanText(nameInput?.value || oldValues?.getAttribute("nome_item")),
        currentCode: realCode(oldValues?.getAttribute("cod_pdv")) || realCode(codeInput?.value)
      };
    }).filter((record) => record.itemId && record.name);
  }

  function scanComplements() {
    return [...document.querySelectorAll('.div-block-1084[item_wrapper]')].map((row) => {
      const itemId = row.getAttribute("item_wrapper");
      const name = cleanText(row.querySelector('input[name="nome"][item_id]')?.value);
      const codeInput = row.querySelector('input[name="cod_pdv"][item_id]:not([change_all])');
      const breadcrumb = cleanText(row.querySelector(".text-block-380")?.textContent);
      const path = breadcrumb.split(">").map(cleanText).filter(Boolean);
      return {
        itemId,
        name,
        parentName: path.length >= 2 ? path[path.length - 2] : "",
        groupName: path.length ? path[path.length - 1] : row.getAttribute("categoria_nome") || "",
        breadcrumb,
        currentCode: realCode(codeInput?.value)
      };
    }).filter((record) => record.itemId && record.name && record.parentName);
  }

  function stageChanges(payload) {
    const pageType = detectPageType();
    assertSameStore(payload);
    if (payload?.pageType !== pageType) throw new Error("A tela aberta não corresponde ao tipo de alteração solicitado.");

    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    if (!changes.length) return { staged: 0, pageType };
    const buttonBefore = saveButton(pageType);
    const alreadyEnabled = !buttonBefore.classList.contains("disable") && buttonBefore.style.pointerEvents !== "none";
    if (alreadyEnabled) {
      throw new Error("Esta tela já possui alterações não salvas. Salve ou recarregue a página antes de aplicar a planilha.");
    }
    const result = pageType === PAGE_CATALOG ? stageParents(changes) : stageComplements(changes);
    const button = saveButton(pageType);
    const disabled = button.classList.contains("disable") || button.style.pointerEvents === "none";
    if (disabled) {
      throw new Error("O portal não habilitou o botão Salvar. Nenhuma alteração foi enviada.");
    }
    return { staged: result.length, itemIds: result, pageType };
  }

  function stageParents(changes) {
    const staged = [];
    for (const change of changes) {
      validateChange(change, "prod");
      const form = document.querySelector(`div[form_item][id_item_form="${cssEscape(change.itemId)}"]`);
      if (!form) throw new Error(`O produto “${change.expectedName}” não está mais disponível nesta tela.`);
      const actualName = cleanText(form.querySelector('input[name="nome_item"]')?.value);
      if (normalize(actualName) !== normalize(change.expectedName)) {
        throw new Error(`O produto “${change.expectedName}” mudou desde a revisão. Atualize a análise.`);
      }

      hydrateParentForm(form);
      const input = form.querySelector('input[name="cod_pdv"]');
      if (!input) throw new Error(`Campo Código PDV não encontrado em “${actualName}”.`);
      setInputValue(input, change.code);
      staged.push(String(change.itemId));
    }
    return staged;
  }

  function stageComplements(changes) {
    const staged = [];
    for (const change of changes) {
      validateChange(change, "att");
      const row = document.querySelector(`.div-block-1084[item_wrapper="${cssEscape(change.itemId)}"]`);
      if (!row) throw new Error(`O complemento “${change.expectedName}” não está mais disponível nesta tela.`);
      const actualName = cleanText(row.querySelector('input[name="nome"][item_id]')?.value);
      const breadcrumb = cleanText(row.querySelector(".text-block-380")?.textContent);
      const path = breadcrumb.split(">").map(cleanText).filter(Boolean);
      const actualParent = path.length >= 2 ? path[path.length - 2] : "";
      if (normalize(actualName) !== normalize(change.expectedName) || normalize(actualParent) !== normalize(change.expectedParent)) {
        throw new Error(`O vínculo “${change.expectedParent} > ${change.expectedName}” mudou desde a revisão. Atualize a análise.`);
      }

      const input = row.querySelector('input[name="cod_pdv"][item_id]:not([change_all])');
      if (!input) throw new Error(`Campo individual Cód. PDV não encontrado em “${actualName}”.`);
      setInputValue(input, change.code);
      staged.push(String(change.itemId));
    }
    return staged;
  }

  function prepareCommit(payload) {
    const pageType = detectPageType();
    assertSameStore(payload);
    if (payload?.pageType !== pageType) throw new Error("A tela de salvamento mudou. Execute a análise novamente.");
    const button = saveButton(pageType);
    const disabled = button.classList.contains("disable") || button.style.pointerEvents === "none";
    if (disabled) throw new Error("O botão Salvar está desabilitado. Nenhuma alteração foi enviada.");
    return { pageType, button };
  }

  async function commitCatalog(button) {
    const marker = performance.now();
    button.click();
    const endpoint = "/item/storeMassChanges";
    const timeoutAt = Date.now() + 35_000;
    while (Date.now() < timeoutAt) {
      const finished = performance.getEntriesByType("resource").some((entry) =>
        entry.name.includes(endpoint) && entry.startTime >= marker && entry.responseEnd > 0
      );
      if (finished) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    }
    throw new Error("O Catálogo demorou demais para confirmar o salvamento.");
  }

  function saveButton(pageType) {
    const selector = pageType === PAGE_CATALOG ? '[loading="bt_save_all"]' : '[save_bt]';
    const button = document.querySelector(selector);
    if (!button) throw new Error("O botão Salvar do portal não foi encontrado.");
    return button;
  }

  function hydrateParentForm(form) {
    const oldValues = form.querySelector('[old_values]');
    if (!oldValues) return;
    for (const input of form.querySelectorAll("input[name]")) {
      if (input.name === "cod_pdv" || input.value !== "" || !oldValues.hasAttribute(input.name)) continue;
      const previous = oldValues.getAttribute(input.name);
      if (previous !== "") setNativeValue(input, previous);
    }
  }

  function setInputValue(input, value) {
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, String(value));
    else input.value = String(value);
  }

  function validateChange(change, prefix) {
    if (!change?.itemId || !change?.expectedName || !CODE_PATTERN.test(String(change.code || ""))) {
      throw new Error("Uma alteração inválida foi bloqueada antes do salvamento.");
    }
    if (!String(change.code).toLowerCase().startsWith(`${prefix}-`)) {
      throw new Error(`O código “${change.code}” não corresponde ao tipo de cadastro.`);
    }
  }

  function assertSameStore(payload) {
    const current = readStoreIdentity();
    const expectedId = String(payload?.storeId || "");
    const expectedName = normalize(payload?.storeName || "");
    if (expectedId && current.storeId && expectedId !== current.storeId) {
      throw new Error(`A loja aberta mudou para “${current.storeName}”. Nenhuma alteração foi enviada.`);
    }
    if (!expectedId && expectedName && normalize(current.storeName) !== expectedName) {
      throw new Error(`A loja aberta mudou para “${current.storeName}”. Nenhuma alteração foi enviada.`);
    }
  }

  function readStoreIdentity() {
    const brand = document.querySelector(".n-a-button-brand");
    const address = cleanText(brand?.querySelector(".n-a-address, .n-a-city-store")?.textContent);
    const storeName = cleanText(brand?.innerText).replace(address, "").trim() || "Loja atual";
    let storeId = "";
    for (const script of document.scripts) {
      if (script.src) continue;
      const text = script.textContent || "";
      const catalogMatch = text.match(/\blet\s+catalogo\s*=\s*\{[\s\S]*?"loja_id"\s*:\s*(\d+)/);
      const genericMatch = text.match(/(?:"loja_id"|\bloja_id\b)\s*[:=]\s*["']?(\d{2,})/);
      const match = catalogMatch || genericMatch;
      if (match) {
        storeId = match[1];
        break;
      }
    }
    return { storeId, storeName };
  }

  function detectPageType() {
    if (location.pathname === "/catalogo") return PAGE_CATALOG;
    if (location.pathname === "/edicao-complementos") return PAGE_COMPLEMENTS;
    throw new Error("Abra o Catálogo ou a Edição de complementos da UP Tecnologias.");
  }

  function realCode(value) {
    const text = cleanText(value);
    return /^(null|undefined|0|-)$/i.test(text) ? "" : text;
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalize(value) {
    return cleanText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
