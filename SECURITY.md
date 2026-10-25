# Política de segurança

## Versões suportadas

O projeto está em pré-alpha; apenas a branch `main` recebe correções.

## Reportando uma vulnerabilidade

Não abra issue pública para falhas de segurança. Use o [reporte privado de vulnerabilidades do GitHub](../../security/advisories/new) descrevendo:

- o problema e o impacto (ex.: vazamento de cookies/headers para outro domínio, execução de código vindo de uma página, escrita fora da pasta de downloads);
- passos para reproduzir;
- navegador e versão.

Você receberá uma resposta assim que possível. Correções são publicadas com crédito a quem reportou, se desejado.

## Superfícies sensíveis

- Regras `declarativeNetRequest` que reaplicam `Cookie`/`Referer`: devem valer apenas para requisições da extensão e ser removidas ao fim de cada download.
- Dados vindos de páginas (manifestos, títulos, URLs) são sempre tratados como não confiáveis e validados.
- Nenhum código remoto é carregado ou executado.
