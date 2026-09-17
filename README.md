# CPlug - Exportador de Chaves

Extensão para Chrome e Brave que coleta, somente para leitura, as chaves de integração dos produtos e dos complementos no ConnectPlug.

## Visão técnica

- extensão baseada no Manifest V3;
- paginação automática da listagem de produtos;
- geração local de planilha Excel;
- execução restrita ao ambiente do ConnectPlug;
- fluxo de confirmação e acompanhamento de progresso na própria página.

Tecnologias principais: JavaScript, Chrome Extensions API, HTML e CSS.

## Como instalar

1. Abra `chrome://extensions` no Chrome ou `brave://extensions` no Brave.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione esta pasta: `EXTENSÃO CBUG CADASTRO`.
5. Se a página de produtos já estiver aberta, atualize-a uma vez.

## Como usar

1. Entre normalmente no ConnectPlug.
2. Abra `https://connectplug.com.br/sistema/produtos`.
3. No painel **Exportar chaves**, clique em **Coletar chaves**.
4. Leia a confirmação e clique em **OK**.
5. Aguarde o progresso. A página deve permanecer aberta durante a coleta.
6. Ao terminar, a extensão baixa o arquivo `chaves-integracao-cplug-AAAA-MM-DD.xlsx`.

O arquivo Excel percorre todas as páginas da listagem e contém:

- Nome produto pai
- Chave de integração do produto pai
- Nome do complemento
- Chave de integração do complemento

Produtos sem complementos também são incluídos, com as duas últimas colunas vazias.

A planilha possui cabeçalhos em maiúsculas, fundo preto, texto branco, filtros, primeira linha congelada, bordas e larguras de coluna ajustadas.

## Segurança e limites

- A extensão faz apenas consultas `GET`; não salva nem altera produtos.
- Os dados não são enviados a nenhum serviço externo.
- São feitas no máximo três consultas de detalhe ao mesmo tempo para evitar sobrecarga.
- Se a sessão expirar, entre novamente no ConnectPlug e repita a coleta.

## Autoria

Desenvolvido por [math7x](https://github.com/math7x).
