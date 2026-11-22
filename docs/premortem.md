# Premortem do Code RAG

## O que a ferramenta faz

A skill instala um pacote em um repositório Git. O pacote lê a cópia de trabalho dos arquivos elegíveis, extrai trechos, símbolos, imports e requisitos, e mantém um índice PostgreSQL com pgvector. A consulta combina busca lexical, símbolos, vetores e dependências. O texto recuperado entra no contexto do agente. Os hooks tentam atualizar o índice após commits, merges e, no Claude Code, no fim do turno.

## Cenário de falha

Em noventa dias, um agente cita código de outro checkout e toma uma decisão com base num arquivo que já foi removido. A equipe confia na mensagem de sucesso de um hook, embora ela registre uma execução anterior. Na investigação, descobre que um arquivo privado que não constava do Git também chegou ao serviço de embeddings e que o Postgres de desenvolvimento aceitou conexões por interfaces de rede. A exposição aconteceu no ingest. A busca sem filtro e a poda incompleta fizeram os efeitos persistirem.

## Riscos verificados e decisões

| Prioridade | Evidência na versão anterior | Contenção implementada | Como verificar |
|---|---|---|---|
| P0 | O scanner percorria o sistema de arquivos sem consultar o Git. A presença da chave selecionava Voyage. | A coleta parte do índice do Git, respeita exclusões, descarta links e limita arquivos. Voyage exige escolha explícita. | Rastrear exemplos com credenciais sintéticas e verificar a coleta e as chamadas de rede em testes. |
| P0 | Nenhuma fonte de candidatos na consulta aplicava o namespace. Uma aresta podia ampliar o alcance do resultado. | A restrição por namespace precede todos os candidatos e também vale para a expansão do grafo. Registros legados sem procedência saem da busca até a reindexação. | Inserir um segundo namespace com símbolos e vetores competitivos e uma aresta cruzada. Consultar o primeiro. |
| P0 | O cliente de banco usava regex para aprovar SQL e expunha um método de SQL livre. A configuração Docker publicava o Postgres em todas as interfaces e usava senha padrão. | Comandos fixos parametrizados, migrações empacotadas, inspeção do catálogo de destino, senha explícita e porta em loopback. | Tentar migrar um banco descartável que contenha uma tabela de produto. Conferir o bind efetivo do Compose. |
| P1 | Prune dependia de um arquivo continuar produzindo trechos. Ingest e grafo podiam parar após gravações parciais. | Atualização por snapshot em uma transação, lock por namespace e propriedade de um worktree por namespace. | Apagar ou renomear a fonte, rodar dois ingests concorrentes, tentar a operação de outro checkout e interromper a transação no meio. |
| P1 | Vetores de modelos diferentes eram comparados como se pertencessem ao mesmo espaço. Trechos enormes perdiam o início ou o fim na recuperação. | Procedência dos vetores, reindexação a partir do Git, trechos limitados e orçamento aplicado à saída completa. | Exercitar a migração antiga e testar arquivos grandes, mudança de provedor e orçamentos pequenos. |
| P1 | Conteúdo e nomes de arquivos eram incorporados ao prompt diretamente. | Trechos delimitados, caminhos escapados e um aviso explícito de que conteúdo recuperado não concede permissões. | Usar uma fixture com texto imperativo e delimitadores Markdown. Avaliar o comportamento do agente separadamente. |
| P2 | Imports eram ligados por sufixos e a ordenação lexical usava `LIMIT` antes de ordenar por relevância. | Resolução relativa e mapeamento de extensões JS/TS, ordenação lexical antes do corte e limites por canal de recuperação. | Usar arquivos homônimos em módulos diferentes e verificar o destino da aresta. |

## Pontos cegos e testes de ruptura

| Hipótese | Falha plausível | Como detectar e conter |
|---|---|---|
| Os arquivos rastreados passaram por revisão antes do envio externo. | Um segredo ou dado privado em formato desconhecido passa pelo filtro. Dados já enviados e cópias do banco continuam existindo após a poda. | Manter o modo offline por padrão. Antes de autorizar Voyage, revisar as exclusões e a política de dados do provedor. Se houver exposição antiga, tratar backups, logs e credenciais separadamente. |
| O agente interpreta os trechos como dados. | O agente executa uma instrução de um README ou comentário que parecia relevante para a tarefa. | Testar com tarefas reais e exemplos adversariais inofensivos. Manter as permissões de ferramentas independentes da saída da busca. |
| O índice local cabe em memória e o escopo produz poucos candidatos. | A busca vetorial exata por namespace fica lenta e o índice HNSW legado adiciona custo de escrita. Um ingest grande pode atingir o limite de tempo do hook. | Medir p95 e recall em repositórios reais antes de alterar a estratégia. Executar a carga inicial manualmente. A busca aproximada pode perder candidatos quando o filtro ocorre após o scan. [Documentação do pgvector](https://github.com/pgvector/pgvector#filtering) |
| Um hook é concluído depois da última edição. | O hook mais recente expira esperando o lock. Um hook anterior registra sucesso usando um snapshot mais antigo. | Interpretar o log como o último resultado concluído. Rodar ingest explícito após falhas ou quando precisar verificar o estado atual. Uma fila durável só se justifica se o volume de uso demonstrar essa necessidade. |
| O banco de engenharia já está separado. | URLs com aliases diferentes apontam para o mesmo banco vazio, ou a conta do Postgres tem acesso a dados fora da aplicação. | Provisionar instância e credenciais dedicadas. A validação da URL e do catálogo protege contra erros comuns de configuração. A separação efetiva também depende do provisionamento. |

## Veredito

A versão anterior precisava de correções antes de reindexar repositórios privados. Os três critérios de liberação são a coleta offline por padrão, o escopo de busca aplicado a todas as fontes de candidatos e uma atualização que preserva o último snapshot válido ao falhar. A versão revisada serve para uso local de engenharia após os testes de build, migração e integração. O cenário com envio externo exige revisão de dados e autorização. A qualidade semântica e o desempenho em escala ainda precisam de medições representativas. O projeto não tem telemetria suficiente para atribuir probabilidades de falha.

As próximas decisões dependem de evidência. Antes de adotar parsing AST, BM25 ou outro serviço, medir a recuperação atual com tarefas reais de implementação, contratos e testes. Para código confidencial que exija semântica, avaliar um modelo local antes de introduzir outra dependência externa. Preservar o CLI e o armazenamento existentes reduziu o custo da atualização.
