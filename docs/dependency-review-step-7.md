# Dependências da etapa 7

Versões fixadas em 01/11/2026: `exceljs@4.4.0`, `yauzl@3.4.0`, `pdfmake@0.3.13` e `@types/yauzl@3.4.0` para desenvolvimento. As fontes Roboto utilizadas pelo PDF acompanham o pacote pdfmake, sem busca externa em runtime.

A leitura ZIP é validada e limitada antes do ExcelJS. A geração utiliza `Workbook.xlsx.writeBuffer`, que usa JSZip no ExcelJS instalado, e valores de célula tratados como texto. Não são usados os recursos de glob ou diretórios do gravador de streaming. PDF permite somente as fontes locais empacotadas e bloqueia acesso a URLs. As bibliotecas executam apenas no servidor.

## Avisos encontrados

O `npm audit` executado nesta etapa retornou **13 avisos: nove moderados e quatro altos**. Os quatro altos envolvem Nodemailer/Auth.js, que já estavam no projeto; a etapa não alterou suas versões. O transporte de mensagens atual é local, e o serviço próprio de SMTP utiliza destinatário validado e conteúdo controlado, sem aceitar opções `raw`, anexos ou caminhos fornecidos pelo usuário. Isso limita as superfícies descritas, mas os avisos precisam ser reavaliados antes da publicação e da ativação de SMTP.

Os nove moderados aparecem na árvore do ExcelJS, principalmente por dependências de `archiver`/`glob`/`minimatch` e `uuid`. A revisão do código instalado constatou que o fluxo usado não recebe padrões glob e não utiliza o gravador de streaming baseado em archiver. A chamada de uuid encontrada no ExcelJS é `v4()` sem buffer externo; o aviso citado trata de `v3`, `v5` e `v6` com buffer.

Essa é uma avaliação de alcance dos fluxos implementados, não uma declaração de ausência de vulnerabilidades. Os avisos permanecem no registro npm. Não foi executado `npm audit fix --force`, nem substituição de versões principais incompatíveis ou downgrade sugerido automaticamente. Atualizações futuras exigem repetir testes de formatos, limites, fontes, importação e autenticação.

Referências primárias: [aviso de minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [aviso de uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [ExcelJS](https://github.com/exceljs/exceljs), [yauzl](https://github.com/thejoshwolfe/yauzl) e [pdfmake](https://github.com/bpampuch/pdfmake).
