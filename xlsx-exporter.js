(() => {
  "use strict";

  const encoder = new TextEncoder();
  const crcTable = buildCrcTable();

  function download(rows) {
    const bytes = build(rows);
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = blobUrl;
    link.download = `chaves-integracao-cplug-${date}.xlsx`;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
  }

  function build(rows) {
    const values = [
      [
        "NOME PRODUTO PAI",
        "CHAVE DE INTEGRAÇÃO DO PRODUTO PAI",
        "NOME DO COMPLEMENTO",
        "CHAVE DE INTEGRAÇÃO DO COMPLEMENTO"
      ],
      ...rows.map((row) => [
        row.parentName,
        row.parentKey,
        row.complementName,
        row.complementKey
      ])
    ];
    const lastRow = Math.max(1, values.length);
    const createdAt = new Date().toISOString();

    const files = {
      "[Content_Types].xml": contentTypesXml(),
      "_rels/.rels": rootRelationshipsXml(),
      "docProps/app.xml": appPropertiesXml(),
      "docProps/core.xml": corePropertiesXml(createdAt),
      "xl/workbook.xml": workbookXml(),
      "xl/_rels/workbook.xml.rels": workbookRelationshipsXml(),
      "xl/styles.xml": stylesXml(),
      "xl/worksheets/sheet1.xml": worksheetXml(values, lastRow)
    };

    return createZip(files);
  }

  function worksheetXml(values, lastRow) {
    const rowsXml = values.map((row, rowIndex) => {
      const excelRow = rowIndex + 1;
      const style = rowIndex === 0 ? 1 : 2;
      const height = rowIndex === 0 ? 24 : 19;
      const cells = row.map((value, columnIndex) => {
        const reference = `${columnName(columnIndex + 1)}${excelRow}`;
        return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      }).join("");
      return `<row r="${excelRow}" ht="${height}" customHeight="1">${cells}</row>`;
    }).join("");

    return xml(`
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <dimension ref="A1:D${lastRow}"/>
        <sheetViews>
          <sheetView showGridLines="0" workbookViewId="0">
            <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
            <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>
          </sheetView>
        </sheetViews>
        <sheetFormatPr defaultRowHeight="19"/>
        <cols>
          <col min="1" max="1" width="32" customWidth="1"/>
          <col min="2" max="2" width="37" customWidth="1"/>
          <col min="3" max="3" width="30" customWidth="1"/>
          <col min="4" max="4" width="41" customWidth="1"/>
        </cols>
        <sheetData>${rowsXml}</sheetData>
        <autoFilter ref="A1:D${lastRow}"/>
        <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
      </worksheet>
    `);
  }

  function stylesXml() {
    return xml(`
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="2">
          <font><sz val="11"/><color theme="1"/><name val="Arial"/><family val="2"/></font>
          <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
        </fonts>
        <fills count="3">
          <fill><patternFill patternType="none"/></fill>
          <fill><patternFill patternType="gray125"/></fill>
          <fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill>
        </fills>
        <borders count="2">
          <border><left/><right/><top/><bottom/><diagonal/></border>
          <border>
            <left style="thin"><color rgb="FFB7B7B7"/></left>
            <right style="thin"><color rgb="FFB7B7B7"/></right>
            <top style="thin"><color rgb="FFB7B7B7"/></top>
            <bottom style="thin"><color rgb="FFB7B7B7"/></bottom>
            <diagonal/>
          </border>
        </borders>
        <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
        <cellXfs count="3">
          <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
          <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
            <alignment horizontal="center" vertical="center" wrapText="1"/>
          </xf>
          <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">
            <alignment horizontal="left" vertical="center"/>
          </xf>
        </cellXfs>
        <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        <dxfs count="0"/>
        <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
      </styleSheet>
    `);
  }

  function contentTypesXml() {
    return xml(`
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
        <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
      </Types>
    `);
  }

  function rootRelationshipsXml() {
    return xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
      </Relationships>
    `);
  }

  function workbookXml() {
    return xml(`
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>
        <sheets><sheet name="CHAVES" sheetId="1" r:id="rId1"/></sheets>
      </workbook>
    `);
  }

  function workbookRelationshipsXml() {
    return xml(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>
    `);
  }

  function appPropertiesXml() {
    return xml(`
      <Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
        <Application>CPlug - Exportador de Chaves</Application>
        <DocSecurity>0</DocSecurity>
        <ScaleCrop>false</ScaleCrop>
        <HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Planilhas</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs>
        <TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>CHAVES</vt:lpstr></vt:vector></TitlesOfParts>
      </Properties>
    `);
  }

  function corePropertiesXml(createdAt) {
    return xml(`
      <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <dc:title>Chaves de integração CPlug</dc:title>
        <dc:creator>CPlug - Exportador de Chaves</dc:creator>
        <cp:lastModifiedBy>CPlug - Exportador de Chaves</cp:lastModifiedBy>
        <dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>
        <dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>
      </cp:coreProperties>
    `);
  }

  function createZip(files) {
    const now = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const checksum = crc32(data);

      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, now.time, true);
      localView.setUint16(12, now.date, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBytes.length, true);
      localView.setUint16(28, 0, true);
      localParts.push(localHeader, nameBytes, data);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, now.time, true);
      centralView.setUint16(14, now.date, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      centralParts.push(centralHeader, nameBytes);

      offset += localHeader.length + nameBytes.length + data.length;
    }

    const centralSize = totalLength(centralParts);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    const fileCount = Object.keys(files).length;
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, fileCount, true);
    endView.setUint16(10, fileCount, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true);

    return concatenate([...localParts, ...centralParts, end]);
  }

  function buildCrcTable() {
    return Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      return value >>> 0;
    });
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function concatenate(parts) {
    const output = new Uint8Array(totalLength(parts));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function totalLength(parts) {
    return parts.reduce((sum, part) => sum + part.length, 0);
  }

  function columnName(number) {
    let result = "";
    let value = number;
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  function escapeXml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function xml(value) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${value.replace(/>\s+</g, "><").trim()}`;
  }

  window.CPlugXlsx = Object.freeze({ build, download });
})();
