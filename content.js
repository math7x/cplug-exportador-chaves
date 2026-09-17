(() => {
  "use strict";

  const PANEL_ID = "cplug-key-exporter";
  const PRODUCT_EDIT_PATH = /^\/sistema\/produto\/editar\/\d+\/?$/;
  const PRODUCT_KEY_PATTERN = /prod-[a-z0-9_-]+/i;
  const COMPLEMENT_KEY_PATTERN = /att-[a-z0-9_-]+/i;
  const MAX_LIST_PAGES = 500;
  const DETAIL_CONCURRENCY = 3;

  if (document.getElementById(PANEL_ID)) return;

  let running = false;
  let cancelled = false;
  let collectedRows = [];

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="cplug-exporter__header">
      <div>
        <strong>Exportar chaves</strong>
        <span>Produtos e complementos</span>
      </div>
      <button type="button" class="cplug-exporter__collapse" aria-label="Minimizar painel" title="Minimizar">&minus;</button>
    </div>
    <div class="cplug-exporter__body">
      <p class="cplug-exporter__status">Pronto para iniciar.</p>
      <div class="cplug-exporter__progress" aria-hidden="true">
        <div class="cplug-exporter__progress-bar"></div>
      </div>
      <p class="cplug-exporter__detail"></p>
      <div class="cplug-exporter__actions">
        <button type="button" class="cplug-exporter__start">Coletar chaves</button>
        <button type="button" class="cplug-exporter__cancel" hidden>Cancelar</button>
        <button type="button" class="cplug-exporter__download" hidden>Baixar Excel novamente</button>
      </div>
      <div class="cplug-exporter__author">Desenvolvido por math7x</div>
    </div>
  `;
  document.body.appendChild(panel);

  const body = panel.querySelector(".cplug-exporter__body");
  const status = panel.querySelector(".cplug-exporter__status");
  const detail = panel.querySelector(".cplug-exporter__detail");
  const progress = panel.querySelector(".cplug-exporter__progress");
  const progressBar = panel.querySelector(".cplug-exporter__progress-bar");
  const startButton = panel.querySelector(".cplug-exporter__start");
  const cancelButton = panel.querySelector(".cplug-exporter__cancel");
  const downloadButton = panel.querySelector(".cplug-exporter__download");
  const collapseButton = panel.querySelector(".cplug-exporter__collapse");

  collapseButton.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("cplug-exporter--collapsed");
    body.hidden = collapsed;
    collapseButton.textContent = collapsed ? "+" : "−";
    collapseButton.setAttribute("aria-label", collapsed ? "Expandir painel" : "Minimizar painel");
    collapseButton.title = collapsed ? "Expandir" : "Minimizar";
  });

  cancelButton.addEventListener("click", () => {
    cancelled = true;
    cancelButton.disabled = true;
    setStatus("Cancelando…", "A coleta vai parar ao concluir as consultas que já estão em andamento.");
  });

  downloadButton.addEventListener("click", () => {
    if (collectedRows.length) window.CPlugXlsx.download(collectedRows);
  });

  startButton.addEventListener("click", async () => {
    if (running) return;

    const confirmed = window.confirm(
      "A extensão vai consultar todas as páginas de produtos e suas telas de edição, somente para leitura. Ao final, será baixado um arquivo Excel formatado com as chaves de integração. Deseja continuar?"
    );
    if (!confirmed) return;

    running = true;
    cancelled = false;
    collectedRows = [];
    startButton.hidden = true;
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    downloadButton.hidden = true;
    progress.setAttribute("aria-hidden", "false");
    updateProgress(0);

    try {
      const products = await collectProductsFromAllPages();
      assertNotCancelled();

      if (!products.length) {
        throw new Error("Nenhum produto foi encontrado na listagem.");
      }

      setStatus(
        `${products.length} produtos encontrados.`,
        "Buscando os complementos sem abrir as telas no navegador…"
      );

      const results = await mapWithConcurrency(
        products,
        DETAIL_CONCURRENCY,
        collectProductDetails,
        (product, done) => {
          updateProgress((done / products.length) * 100);
          setStatus(
            `Lendo produtos: ${done} de ${products.length}`,
            product.name
          );
        }
      );

      assertNotCancelled();
      collectedRows = results.flatMap(buildExportRows);
      window.CPlugXlsx.download(collectedRows);

      const complementCount = collectedRows.filter((row) => row.complementKey).length;
      updateProgress(100);
      setStatus(
        "Exportação concluída.",
        `${products.length} produtos pai e ${complementCount} complementos exportados.`
      );
      downloadButton.hidden = false;
    } catch (error) {
      if (error instanceof CancelledError) {
        updateProgress(0);
        setStatus("Coleta cancelada.", "Nenhum arquivo foi baixado.");
      } else {
        console.error("[CPlug Exportador]", error);
        setStatus(
          "Não foi possível concluir.",
          friendlyError(error)
        );
      }
      startButton.hidden = false;
    } finally {
      running = false;
      cancelButton.hidden = true;
      cancelButton.disabled = false;
      if (!collectedRows.length) startButton.hidden = false;
    }
  });

  async function collectProductsFromAllPages() {
    const productsByUrl = new Map();
    const firstUrl = firstListPageUrl();
    const firstDocument = isFirstListPage(location.href)
      ? document
      : await fetchDocument(firstUrl);
    const pagination = readPagination(firstDocument);

    if (pagination) {
      if (pagination.totalPages > MAX_LIST_PAGES) {
        throw new Error("A paginação ultrapassou o limite de segurança.");
      }

      for (let pageNumber = 1; pageNumber <= pagination.totalPages; pageNumber += 1) {
        assertNotCancelled();
        setStatus(
          `Lendo lista de produtos: página ${pageNumber} de ${pagination.totalPages}`,
          `${productsByUrl.size} de ${pagination.totalItems} produtos localizados.`
        );

        const pageDocument = pageNumber === 1
          ? firstDocument
          : await fetchDocument(listPageUrl(firstUrl, pageNumber));
        addProducts(productsByUrl, pageDocument);
      }

      if (productsByUrl.size < pagination.totalItems) {
        throw new Error(
          `Foram encontrados ${productsByUrl.size} de ${pagination.totalItems} produtos. Atualize a página e tente novamente.`
        );
      }
    } else {
      await collectProductsFollowingLinks(firstDocument, firstUrl, productsByUrl);
    }

    return [...productsByUrl.values()];
  }

  async function collectProductsFollowingLinks(firstDocument, firstUrl, productsByUrl) {
    const visited = new Set();
    let pageUrl = firstUrl;
    let pageDocument = firstDocument;
    let pageNumber = 0;

    while (pageUrl && pageNumber < MAX_LIST_PAGES) {
      assertNotCancelled();
      if (visited.has(pageUrl.href)) break;
      visited.add(pageUrl.href);
      pageNumber += 1;

      setStatus(
        `Lendo lista de produtos: página ${pageNumber}`,
        `${productsByUrl.size} produtos localizados até agora.`
      );
      addProducts(productsByUrl, pageDocument);

      pageUrl = findNextListPage(pageDocument, pageUrl, visited);
      if (pageUrl) pageDocument = await fetchDocument(pageUrl);
    }

    if (pageNumber >= MAX_LIST_PAGES) {
      throw new Error("A paginação ultrapassou o limite de segurança.");
    }
  }

  function addProducts(productsByUrl, pageDocument) {
    for (const product of parseProductList(pageDocument)) {
      productsByUrl.set(product.url, product);
    }
  }

  function readPagination(pageDocument) {
    const text = cleanText(pageDocument.body?.textContent);
    const match = text.match(/(\d+)\s*-\s*(\d+)\s+de\s+(\d+)\s+itens/i);
    if (!match) return null;

    const firstItem = Number(match[1]);
    const lastItem = Number(match[2]);
    const totalItems = Number(match[3]);
    const pageSize = lastItem - firstItem + 1;
    if (!Number.isFinite(pageSize) || pageSize < 1 || totalItems < 0) return null;

    return {
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / pageSize))
    };
  }

  function listPageUrl(firstUrl, pageNumber) {
    const url = new URL(firstUrl);
    if (pageNumber <= 1) {
      url.searchParams.delete("page");
    } else {
      url.searchParams.set("page", String(pageNumber));
    }
    return url;
  }

  function parseProductList(pageDocument) {
    const products = [];

    for (const table of pageDocument.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      if (!rows.length) continue;

      const headerCells = cellsOf(rows[0]);
      const headers = headerCells.map((cell) => normalize(cell.textContent));
      const nameIndex = headers.findIndex((value) => value === "nome");
      const keyIndex = headers.findIndex((value) => value.includes("chave integracao"));

      if (nameIndex < 0 || keyIndex < 0) continue;

      for (const row of rows.slice(1)) {
        const cells = cellsOf(row);
        if (cells.length <= Math.max(nameIndex, keyIndex)) continue;

        const editLink = cells[nameIndex].querySelector('a[href*="/sistema/produto/editar/"]')
          || row.querySelector('a[href*="/sistema/produto/editar/"]');
        if (!editLink) continue;

        const url = new URL(editLink.getAttribute("href"), location.origin);
        if (url.origin !== location.origin || !PRODUCT_EDIT_PATH.test(url.pathname)) continue;

        const name = cleanText(cells[nameIndex].textContent);
        const keyMatch = cleanText(cells[keyIndex].textContent).match(PRODUCT_KEY_PATTERN);
        products.push({
          name,
          key: keyMatch ? keyMatch[0] : "",
          url: url.href
        });
      }
    }

    return products;
  }

  async function collectProductDetails(product) {
    const pageDocument = await fetchDocument(product.url);
    const parentName = cleanText(pageDocument.querySelector("#name")?.value) || product.name;
    const basicInfo = pageDocument.querySelector(".product-basic-info");
    const parentKeyMatch = cleanText(basicInfo?.textContent).match(PRODUCT_KEY_PATTERN);
    const parentKey = parentKeyMatch?.[0] || product.key;
    const complements = parseComplements(pageDocument);

    return {
      parentName,
      parentKey,
      complements
    };
  }

  function parseComplements(pageDocument) {
    const complementsByKey = new Map();

    for (const table of pageDocument.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      if (!rows.length) continue;

      const headerRowIndex = rows.findIndex((row) => {
        const text = normalize(row.textContent);
        return text.includes("chave integracao") && (
          text.includes("variacao") ||
          text.includes("complemento") ||
          text.includes("adicional")
        );
      });
      if (headerRowIndex < 0) continue;

      const headers = cellsOf(rows[headerRowIndex]).map((cell) => normalize(cell.textContent));
      const keyIndex = headers.findIndex((value) => value.includes("chave integracao"));
      const nameIndex = headers.findIndex((value) =>
        value.includes("variacao") ||
        value.includes("complemento") ||
        value.includes("adicional") ||
        value === "nome"
      );
      if (keyIndex < 0 || nameIndex < 0) continue;

      for (const row of rows.slice(headerRowIndex + 1)) {
        const cells = cellsOf(row);
        if (cells.length <= Math.max(nameIndex, keyIndex)) continue;

        const keyMatch = cleanText(cells[keyIndex].textContent).match(COMPLEMENT_KEY_PATTERN);
        if (!keyMatch) continue;

        const name = cleanText(cells[nameIndex].textContent);
        if (!name) continue;

        complementsByKey.set(keyMatch[0], {
          name,
          key: keyMatch[0]
        });
      }
    }

    return [...complementsByKey.values()];
  }

  function buildExportRows(product) {
    if (!product.complements.length) {
      return [{
        parentName: product.parentName,
        parentKey: product.parentKey,
        complementName: "",
        complementKey: ""
      }];
    }

    return product.complements.map((complement) => ({
      parentName: product.parentName,
      parentKey: product.parentKey,
      complementName: complement.name,
      complementKey: complement.key
    }));
  }

  async function fetchDocument(input) {
    assertNotCancelled();
    const url = new URL(input, location.origin);
    if (url.origin !== location.origin) {
      throw new Error("Foi bloqueada uma consulta fora do ConnectPlug.");
    }

    const response = await fetch(url.href, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("A sessão do ConnectPlug expirou. Entre novamente e repita a coleta.");
    }
    if (!response.ok) {
      throw new Error(`A página ${url.pathname} respondeu com erro ${response.status}.`);
    }

    const html = await response.text();
    if (/\/login\b/i.test(response.url) || /name=["']password["']/i.test(html)) {
      throw new Error("A sessão do ConnectPlug expirou. Entre novamente e repita a coleta.");
    }

    return new DOMParser().parseFromString(html, "text/html");
  }

  function findNextListPage(pageDocument, currentUrl, visited) {
    const links = [...pageDocument.querySelectorAll('a[href*="/sistema/produtos"]')]
      .map((link) => ({
        text: normalize(link.textContent),
        rel: normalize(link.getAttribute("rel")),
        url: new URL(link.getAttribute("href"), currentUrl)
      }))
      .filter(({ url }) => url.origin === location.origin && url.pathname === "/sistema/produtos");

    const explicitNext = links.find(({ text, rel, url }) =>
      !visited.has(url.href) && (
        rel.includes("next") ||
        text.includes("next") ||
        text.includes("proximo") ||
        text.includes("proxima")
      )
    );
    if (explicitNext) return explicitNext.url;

    const currentPage = Number(currentUrl.searchParams.get("page") || "1");
    const nextNumbered = links
      .filter(({ url }) => !visited.has(url.href))
      .map(({ url }) => ({ url, page: Number(url.searchParams.get("page")) }))
      .filter(({ page }) => Number.isFinite(page) && page > currentPage)
      .sort((a, b) => a.page - b.page)[0];

    return nextNumbered?.url || null;
  }

  function firstListPageUrl() {
    const url = new URL(location.href);
    url.pathname = "/sistema/produtos";
    url.hash = "";
    url.searchParams.delete("page");
    return url;
  }

  function isFirstListPage(href) {
    const url = new URL(href);
    return url.pathname === "/sistema/produtos" && !url.searchParams.has("page");
  }

  async function mapWithConcurrency(items, concurrency, worker, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;
    let firstFailure = null;

    async function run() {
      while (true) {
        assertNotCancelled();
        if (firstFailure) return;
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;

        try {
          results[index] = await worker(items[index]);
          completed += 1;
          onProgress?.(items[index], completed);
        } catch (error) {
          firstFailure ||= error;
        }
      }
    }

    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, items.length) }, run)
    );
    if (firstFailure) throw firstFailure;
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    return results;
  }

  function cellsOf(row) {
    return [...row.querySelectorAll(":scope > th, :scope > td")];
  }

  function cleanText(value) {
    return String(value ?? "")
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalize(value) {
    return cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function setStatus(message, extra = "") {
    status.textContent = message;
    detail.textContent = extra;
  }

  function updateProgress(percent) {
    const safePercent = Math.max(0, Math.min(100, percent));
    progressBar.style.width = `${safePercent}%`;
  }

  function assertNotCancelled() {
    if (cancelled) throw new CancelledError();
  }

  function friendlyError(error) {
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      return "Falha de conexão. Verifique a internet e tente novamente.";
    }
    return error?.message || "Erro inesperado.";
  }

  class CancelledError extends Error {
    constructor() {
      super("Coleta cancelada.");
      this.name = "CancelledError";
    }
  }
})();
