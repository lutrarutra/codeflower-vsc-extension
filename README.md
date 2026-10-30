<p align="center">
  <img src="media/icon.png" width="112" height="112" alt="code flower for VS Code icon">
</p>

<h1 align="center">code flower for VS Code</h1>

<p align="center">Chat with the agents in your code flower sandboxes, right in VS Code.</p>

<p align="center">
  <a href="https://github.com/lutrarutra/codeflower-launcher"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-launcher/main/assets/icon.png" width="20" height="20" alt=""> launcher</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/codeflower-sandbox"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-sandbox/main/assets/icon.png" width="20" height="20" alt=""> sandbox</a>
  &nbsp;·&nbsp;
  <b><img src="media/icon.png" width="20" height="20" alt=""> VS Code extension</b>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/storyteller"><img src="https://raw.githubusercontent.com/lutrarutra/storyteller/main/assets/icon.png" width="20" height="20" alt=""> storyteller</a>
  &nbsp;·&nbsp;
  <a href="https://codeflower.dev">codeflower.dev</a>
</p>

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
