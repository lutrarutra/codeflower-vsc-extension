<p align="center">
  <img src="media/icon.png" width="112" height="112" alt="code flower for VS Code icon">
</p>

<h1 align="center">code flower for VS Code</h1>

<p align="center">Chat with the agents in your code flower sandboxes, right in VS Code.</p>

<p align="center">
  <a href="https://github.com/lutrarutra/codeflower-app"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-app/main/assets/icon.png" width="20" height="20" alt=""> app</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/codeflower-sandbox"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-sandbox/main/assets/icon.png" width="20" height="20" alt=""> sandbox</a>
  &nbsp;·&nbsp;
  <b><img src="media/icon.png" width="20" height="20" alt=""> VS Code extension</b>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/storyteller"><img src="https://raw.githubusercontent.com/lutrarutra/storyteller/main/assets/icon.png" width="20" height="20" alt=""> storyteller</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/lutrarutra/codeflower-tunnel"><img src="https://raw.githubusercontent.com/lutrarutra/codeflower-tunnel/main/assets/icon.png" width="20" height="20" alt=""> tunnel</a>
  &nbsp;·&nbsp;
  <a href="https://codeflower.dev">codeflower.dev</a>
</p>

The VS Code extension of code flower. It connects to code flower workers (sandboxes started by the
[app](https://github.com/lutrarutra/codeflower-app)), lists them with their sessions in the sidebar,
and opens a chat per session, with the agent's reports and files beside it.

## Install

Download `codeflower-<version>.vsix` from the
[releases](https://github.com/lutrarutra/codeflower-vsc-extension/releases) and install it with
*Extensions → ⋯ → Install from VSIX…*, or:

```sh
code --install-extension codeflower-<version>.vsix
```

Then start a worker with the app, run **code flower: Connect to worker** and paste the
`codeflower://…` line it printed, or click *Open in VS Code* in `codeflower client`. Connect as many
workers as you like. If the agent is not signed in for the project yet, the extension offers its
sign-in.

## Development

```sh
npm ci && npm --prefix webview ci
npm run check   # TypeScript
npm test        # unit tests
npm run build   # webview + dist/extension.cjs
```

F5 in this folder runs the extension alone. To develop it against a real worker (F5 "Extension + dev
worker", the integration tests), clone
[codeflower-workspace](https://github.com/lutrarutra/codeflower-workspace), which has this repo as the
`extension/` submodule. Its [architecture document](https://github.com/lutrarutra/codeflower-workspace/blob/main/docs/architecture.md)
describes how the parts fit together and the protocol the extension speaks with the bridge.
