# code flower for VS Code

The VS Code extension of code flower: it connects to code flower workers (sandboxes started by
[codeflower-launcher](https://github.com/lutrarutra/codeflower-launcher)), lists them with their
sessions, and opens a chat (a Svelte webview in `webview/`) per session.

## Install

Download `codeflower-<version>.vsix` from the
[releases](https://github.com/lutrarutra/codeflower-vsc-extension/releases) and install it with
*Extensions → ⋯ → Install from VSIX…*, or `code --install-extension codeflower-<version>.vsix`.

## Development

```sh
npm ci && npm --prefix webview ci
npm run check   # TypeScript
npm test        # unit tests
npm run build   # webview + dist/extension.cjs
```

F5 in this folder runs the extension alone. To develop it against a real worker (F5 "Extension + dev
worker", the run-codeflower driver, the integration tests), clone
[codeflower-workspace](https://github.com/lutrarutra/codeflower-workspace), which has this repo as
the `extension/` submodule. The protocol the extension speaks with the bridge is described in its
[architecture document](https://github.com/lutrarutra/codeflower-workspace/blob/main/docs/architecture.md).
