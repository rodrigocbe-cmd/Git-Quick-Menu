# Contexto: extensão do VS Code com um menu Git no estilo do Visual Studio

## Objetivo

Criar uma **extensão para o Visual Studio Code** que adicione um menu
**Git** à barra de menus superior, parecido com o menu Git do
**Visual Studio**.

### Comparação visual

**VS Code hoje:**

``` text
File   Edit   Selection   View   Go   Run   Terminal   Help
```

**Visual Studio:**

``` text
File   Edit   View   Git   Project   Build   Debug   Test   Tools   Extensions   Window   Help
```

**Resultado desejado no VS Code:**

``` text
File   Edit   Selection   View   Go   Run   Terminal   Git   Help
                                                       ↑
                                                  novo menu
```

Ao clicar em **Git**, abre-se um submenu com as operações:

``` text
Git
├── New Branch...
├── Checkout...
├── Commit
├── Commit & Push
├── Pull
├── Push
├── Fetch
├── Sync
├── ───────────────
├── Manage Branches
├── Manage Remotes
└── Git Settings
```

## Esclarecimento importante

O foco **não** é uma extensão de histórico visual como GitLens ou Git
Graph, nem uma nova barra lateral. A ideia é **adicionar um item
diretamente à barra de menus principal do VS Code**, como o menu `Git`
do Visual Studio.

## Nome da extensão

### Sugestões

| Estilo | Opções |
|---|---|
| Descritivo (fácil de achar no Marketplace) | **Git Menu Bar**, Git Top Menu, Menu Git Classic |
| Remete ao Visual Studio, sem usar a marca | VS-Style Git Menu, Studio Git Menu, Familiar Git Menu |
| Curto / "de marca" | GitBar, MenuGit, Gitmenu, BranchBar |

### Recomendação

- **Nome:** Git Menu Bar
- **ID da extensão:** `git-menu-bar`
- **Prefixo dos comandos:** `gitMenuBar.*`
- **Descrição sugerida:** "Adds a Visual Studio-style Git menu to VS Code"

### Cuidados com marcas

- Não usar "Visual Studio" ou "VS Code" no nome principal, para não
  parecer uma extensão oficial da Microsoft. Mencionar isso só na
  descrição.
- A política de marca do Git desencoraja nomes colados como "GitFoo".
  Formatos como "Git Menu Bar" são mais seguros do que "GitBar".

## API do VS Code envolvida

- `contributes.commands`
- `contributes.submenus`
- `contributes.menus`
- `menubar/main` (ver a pendência abaixo)

### ✅ Decisão: `menubar/main` não é suportado

**`menubar/main` não é um ponto de contribuição público** do VS Code: o
menu principal do app desktop é fechado para extensões (existe apenas a
proposta `menuBar/home`, restrita ao VS Code Web). Por isso o projeto
foi criado como **Git Quick Menu** (ID `git-quick-menu`, prefixo
`gitQuickMenu.*`, categoria "Git Menu" para não colidir com os comandos
"Git:" nativos), usando as alternativas suportadas abaixo, todas
implementadas.

Alternativas suportadas para o submenu "Git":

- barra de título do editor (`editor/title`);
- item na Status Bar que abre um Quick Pick com as operações;
- menu da view de SCM (`scm/title`);
- Command Palette (todos os comandos com a categoria "Git").

Nesse cenário, um nome como **Git Quick Menu** pode fazer mais sentido.

## Exemplo conceitual de `package.json`

``` json
{
    "contributes": {
        "submenus": [
            {
                "id": "gitMenuBar.menu",
                "label": "Git"
            }
        ],
        "menus": {
            "menubar/main": [
                {
                    "submenu": "gitMenuBar.menu",
                    "group": "navigation@5"
                }
            ],
            "gitMenuBar.menu": [
                { "command": "gitMenuBar.newBranch" },
                { "command": "gitMenuBar.checkout" },
                { "command": "gitMenuBar.commit" },
                { "command": "gitMenuBar.push" },
                { "command": "gitMenuBar.pull" }
            ]
        }
    }
}
```

A própria extensão implementa os comandos.

## Funcionalidades desejadas

1. New Branch
2. Checkout Branch
3. Commit
4. Commit & Push
5. Pull
6. Push
7. Fetch
8. Sync
9. Manage Branches
10. Manage Remotes
11. Stash
12. Git Log
13. Git Settings

Extra: detectar automaticamente se o workspace atual tem um repositório
Git, habilitando ou desabilitando os itens com `when` clauses.

## Implementação

- Linguagem: **TypeScript**, no padrão de desenvolvimento de extensões
  do VS Code.
- Não é preciso implementar o Git do zero. A extensão pode:
  - executar comandos Git (`git branch`, `git checkout`, `git commit`,
    `git push` etc.);
  - ou reutilizar a API ou os comandos da extensão Git nativa do VS Code
    (`vscode.git`) quando fizer sentido.

## Próximos passos

0. **Validar se `menubar/main` funciona** e decidir entre o menu
   principal e as alternativas.
1. Criar a estrutura inicial da extensão.
2. Criar o `package.json`.
3. Escrever o código TypeScript.
4. Adicionar o menu `Git` (na barra principal ou na alternativa
   escolhida).
5. Implementar os comandos principais.
6. Permitir testar com `F5` no VS Code.
7. Gerar um `.vsix` para instalação.
