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

## How code flower fits together

The highlighted part is this repository, the VS Code extension.

```mermaid
flowchart LR
  you(["you"])
  ghcr[("ghcr.io<br/>sandbox image")]
  subgraph front["your machine, or the cluster's login node over Remote-SSH"]
    vsc["VS Code<br/>code flower extension"]
    cli["app<br/>codeflower CLI · client window"]
  end
  subgraph node["workstation or compute node (Slurm job or any shell)"]
    subgraph sb["sandbox: Docker · Podman · Apptainer"]
      bridge["bridge"]
      agent["agent<br/>Claude Code · Codex · dsh"]
      st["storyteller"]
    end
    data[("project state<br/>/data mounts")]
  end

  you -- "starts a worker" --> cli
  you -- "chats, reads reports" --> vsc
  ghcr -- "image" --> cli
  cli -- "starts, mounts folders" --> sb
  cli -. "vscode:// connect link" .-> vsc
  vsc <== "WebSocket: ACP + _codeflower/*" ==> bridge
  bridge -- "stdio ACP" --> agent
  agent -- "runs code, reads and writes" --> data
  agent -- "writes reports with" --> st
  st -- "report.html" --> data
  style vsc fill:#fff1c2,stroke:#1d1d1f,stroke-width:3px,color:#1d1d1f
```

1. Start a worker with the app (`codeflower interactive`, or the client window), on a workstation or
   as a cluster job. It downloads the sandbox image once and starts it with your folders mounted.
2. The worker prints a `codeflower://` address. Paste it into the VS Code extension, or click the worker's
   link in the client window.
3. Chat with the agent in VS Code. The extension talks to the sandbox's bridge over one WebSocket; the
   bridge runs the agent, which sees only the mounted folders.
4. The agent writes its findings as storyteller reports, which open in VS Code beside the chat.

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
