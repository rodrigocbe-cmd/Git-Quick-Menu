# Git Quick Menu

A **Git** menu for VS Code, with the common Git operations grouped in one place.

> This is not an official Microsoft extension.

## Requirements

[Git](https://git-scm.com/downloads). The extension runs on the Node.js
bundled with VS Code, so nothing else is needed. If Git is not found on
startup, the extension offers to install it (with `winget` on Windows, the
Xcode Command Line Tools on macOS) or opens the download page.

## Where the menu shows up

### Main menu bar (opt-in)

```text
File   Edit   Selection   View   Go   Run   Terminal   Git   Help
```

Run **Git Menu: Add Git to Main Menu Bar** (or turn on
`gitQuickMenu.mainMenuBar`) and reload the window.

VS Code has no official API for top-level menus, so this option **modifies a
file of the VS Code installation** (`workbench.desktop.main.js`) and updates its
checksum in `product.json`, so VS Code doesn't warn that the installation is
corrupt. Keep in mind:

- VS Code updates replace the file. The extension re-applies the change on the
  next start and asks you to reload.
- **Git Menu: Remove Git from Main Menu Bar** undoes the change. Uninstalling
  the extension undoes it too.
- If VS Code is installed for all users (`C:\Program Files`), you need to run
  it as administrator once to apply the change.

### Other places

| Place | How to open it |
|---|---|
| Status Bar | Click **Git** in the bottom-left corner |
| Shortcut | `Ctrl+Alt+G` (`Cmd+Alt+G` on macOS) |
| Editor title bar | Source Control icon, top right of the editor |
| Source Control view | Source Control icon in the view title |
| Command Palette | Type `Git Menu:` |

## Operations

```text
Git
├── New Branch...
├── Checkout...
├── ───────────────
├── Commit
├── Commit & Push
├── ───────────────
├── Pull
├── Push
├── Fetch
├── Sync
├── ───────────────
├── Manage Branches...   (checkout, merge, rename, delete)
├── Manage Remotes...    (add, fetch, change URL, rename, remove)
├── Stash...             (stash, pop, apply, view, drop)
├── Git Log              (commit list, opens the diff)
├── ───────────────
└── Git Settings...
```

Items are enabled only when the workspace has a Git repository open. With no
repository, the Quick Pick offers **Initialize Repository** and **Clone
Repository**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitQuickMenu.mainMenuBar` | `false` | Adds **Git** to the main menu bar (modifies VS Code; see above) |
| `gitQuickMenu.showStatusBarItem` | `true` | Shows the **Git** item in the Status Bar |
| `gitQuickMenu.showInEditorTitle` | `true` | Shows the submenu in the editor title bar |
| `gitQuickMenu.showInSourceControl` | `true` | Shows the submenu in the Source Control view |
| `gitQuickMenu.logMaxEntries` | `100` | Number of commits shown by **Git Log** |

## Languages

The extension follows the VS Code display language (**Configure Display
Language**). Available: English (default) and Portuguese (Brazil).

- `package.nls.json` / `package.nls.<locale>.json`: menu, command and setting
  texts from `package.json`.
- `l10n/bundle.l10n.<locale>.json`: texts from the code (`vscode.l10n.t`).
  The key is the English text itself.

To add a language, copy the pt-BR files with the new locale (for example
`es`) and translate the values.

## Development

Requirements: [Node.js](https://nodejs.org/) 20+ and VS Code 1.90+.

```bash
npm install
npm run compile
```

- **Test:** open the folder in VS Code and press `F5`. A new window (Extension
  Development Host) opens with the extension loaded.
- **Package:** `npm run package` creates `git-quick-menu-<version>.vsix`.
- **Install the .vsix:** `code --install-extension git-quick-menu-0.1.0.vsix`

## How it works

The extension uses the public API of the built-in `vscode.git` extension for
branches, commit, push/pull/fetch and remotes. That reuses its authentication
and keeps the Source Control view in sync. For operations the API does not
expose (merge, rename, stash, `git show`), it runs the `git` executable
directly, respecting the `git.path` setting.

```text
src/
├── extension.ts      # activation, status bar, context key
├── menu.ts           # Git menu as a Quick Pick
├── commands.ts       # implementation of the commands
├── gitService.ts     # Git API access, repository picker, runGit
├── menubar.ts        # add/remove commands for the main menu bar, re-apply after updates
├── menubarPatch.ts   # patch of the VS Code workbench (no vscode dependency)
├── uninstall.ts      # vscode:uninstall hook: removes the patch
└── typings/git.d.ts  # subset of the vscode.git API types
```

## Credits

The extension icon is based on the [Git logo](https://git-scm.com/downloads/logos)
by Jason Long, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). This extension is
not affiliated with or endorsed by the Git project.
