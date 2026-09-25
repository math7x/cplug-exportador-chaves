# CPlug → Alloy/iFood | Integração de Códigos PDV

Extensão para Chrome e Brave criada para facilitar a migração e a sincronização dos **códigos PDV do ConnectPlug (CPlug)** com o catálogo do **Alloy/UP Tecnologias** ou com o **Cardápio > PDV do iFood**.

## O problema que esta extensão resolve

O ConnectPlug possui uma **Chave de Integração** para cada produto e para cada complemento:

- produtos pai usam códigos como `prod-144407-1`;
- complementos usam códigos como `att-144407-1-124`.

Para integrar corretamente o catálogo, essas chaves precisam ser colocadas no campo **Cód. PDV/PDV** de cada cadastro correspondente. Fazer isso manualmente exige abrir e conferir muitos produtos, identificar a qual produto pai cada complemento pertence, copiar cada chave e colá-la individualmente na plataforma de destino.

Esse trabalho fica especialmente difícil porque:

- uma loja pode possuir centenas de produtos e complementos;
- complementos com o mesmo nome podem existir em produtos pai diferentes;
- o código do complemento deve ser colocado no campo individual correto, não no campo coletivo do grupo;
- nomes podem ter pequenas diferenças entre o CPlug e o Alloy;
- um código colado no produto errado pode gerar uma integração incorreta;
- conferir o que já está certo e o que ainda precisa ser preenchido consome muito tempo.

## O que a extensão faz

A extensão transforma esse processo em um fluxo assistido:

1. percorre automaticamente todas as páginas de produtos do ConnectPlug;
2. coleta as chaves dos produtos pai e de seus complementos;
3. gera uma planilha organizada para servir como base da integração;
4. lê os produtos e complementos existentes no Alloy/UP ou no iFood;
5. compara os nomes e sugere o código PDV correspondente;
6. separa itens corretos, correspondências exatas, aproximações e itens que exigem atenção;
7. permite pesquisar manualmente um complemento somente dentro do respectivo produto pai;
8. aplica apenas os itens selecionados e confere o resultado depois do salvamento.

Assim, a planilha não substitui o catálogo da plataforma: a revisão sempre parte dos itens realmente cadastrados no Alloy/UP ou no iFood, usando os dados exportados do CPlug apenas para localizar o código correto.

## Instalação

1. Abra `chrome://extensions` ou `brave://extensions`.
2. Ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta `EXTENSÃO CBUG CADASTRO`.
5. Ao atualizar uma versão já carregada, clique no botão de recarregar da extensão e atualize as páginas abertas.

## 1. Exportar no ConnectPlug

1. Abra `https://connectplug.com.br/sistema/produtos`.
2. No painel **Exportar chaves**, clique em **Coletar chaves**.
3. Confirme e aguarde. A extensão percorre todas as páginas e baixa `chaves-integracao-cplug-AAAA-MM-DD.xlsx`.

O Excel contém:

- NOME PRODUTO PAI
- CHAVE DE INTEGRAÇÃO DO PRODUTO PAI
- NOME DO COMPLEMENTO
- CHAVE DE INTEGRAÇÃO DO COMPLEMENTO

## 2. Revisar e aplicar no Alloy/UP

1. Na loja correta, deixe abertas e atualizadas estas duas telas:
   - `https://parceiros.online.uptecnologias.app.br/catalogo`
   - `https://parceiros.online.uptecnologias.app.br/edicao-complementos`
2. Clique no ícone da extensão.
3. Selecione o Excel exportado no ConnectPlug.
4. Clique em **Verificar catálogo e sugerir códigos**.
5. Confira a tela de revisão. A listagem parte dos itens reais do Alloy; o Excel é usado apenas para localizar o código correspondente. Correspondências exatas já vêm selecionadas; aproximadas exigem seleção manual.
6. Clique em **Aplicar selecionados** e confirme. O botão aplica somente os itens marcados na aba aberta.

## 3. Revisar e aplicar no iFood

1. Abra `https://portal.ifood.com.br/menu/list/pdv`.
2. Clique no ícone da extensão.
3. Selecione o Excel exportado no ConnectPlug.
4. Em **Plataforma de destino**, escolha **iFood**.
5. Clique em **Verificar catálogo e sugerir códigos**. O botão de abertura muda para **Abrir iFood PDV**, pois nessa plataforma só é necessária uma tela.
6. Confira a tela de revisão. A extensão lê os produtos e complementos reais do iFood e usa o Excel somente para sugerir os códigos `prod-` e `att-`.
7. Clique em **Aplicar selecionados** e confirme.

### Escolha manual do código

Cada linha que ainda não está correta tem um campo de busca:

- **Produtos pai:** busca em **todos** os produtos pai do Excel, por nome ou pelo código `prod-`.
- **Complementos:** mostra **somente os complementos do produto pai** daquele item no Excel. O produto pai é localizado primeiro pelo nome exibido na plataforma; o código `prod-` é usado apenas como apoio quando o nome mudou.
- Em complementos, a comparação também usa o nome da opção/grupo quando ele existe, por exemplo `Adicionais + Picanha` para sugerir `Adicional Picanha` com mais segurança.
- No iFood, quando o seletor padrão não encontra o título do grupo, a extensão procura um cabeçalho próximo acima da opção para capturar nomes como `Adicionais`, `Bordas` ou `Sabores`, ignorando ações como `Pausar` e limpando selos como `Opcional`.
- Se alguns complementos do mesmo produto pai vierem sem grupo, mas outros do mesmo item tiverem um grupo claro de adicionais/extras/bordas/sabores, a extensão usa esse grupo como apoio para os que ficaram sem título.
- Escolher um item da lista ou colar um código aplica a escolha na hora. Se você digitar, confirme com **Enter** ou saindo do campo.
- Um código `att-` de outro produto pai é sempre recusado, evitando aplicar um complemento no produto errado.
- Você pode marcar a linha primeiro e escolher o código depois. O botão de aplicar fica bloqueado enquanto houver linha marcada sem código.
- As escolhas ficam salvas se você recarregar a tela de revisão.

Quando o código atual do cadastro existe no Excel (para complementos, dentro do mesmo produto pai), o item é considerado correto. Se o nome no Excel for diferente, a linha mostra um aviso e o campo de busca continua disponível.

## Proteções incluídas

- bloqueia a operação quando Catálogo e Complementos pertencem a lojas diferentes;
- confere novamente a loja e o nome de cada cadastro imediatamente antes de salvar;
- aplica complementos somente em `Cód. PDV` da linha individual, nunca no campo coletivo superior;
- relaciona cada complemento pelo nome dele e pelo produto pai na plataforma de destino;
- limita a busca manual aos complementos daquele mesmo produto pai;
- rejeita códigos de complementos pertencentes a outro produto pai;
- não aplica correspondências ambíguas, ausentes ou com conflito de códigos no Excel;
- mostra todos os resultados para revisão antes de qualquer salvamento;
- recarrega e verifica os códigos gravados após a resposta do portal.

## Resultado esperado

O objetivo é reduzir um trabalho repetitivo de copiar e colar códigos um por um, sem perder a conferência humana. A extensão acelera a localização e o preenchimento dos códigos PDV, mas mantém uma tela de revisão para que nenhuma correspondência duvidosa seja aplicada silenciosamente.

## Observações

- A extensão lê arquivos `.xlsx` com as quatro colunas esperadas. O formato gerado por ela é o recomendado.
- Se as páginas do portal estavam abertas durante a atualização da extensão, atualize a(s) tela(s) antes de analisar.
- Produtos e complementos que já possuem o código correto são identificados e não são alterados.

## Autoria

Desenvolvido por [math7x](https://github.com/math7x).
