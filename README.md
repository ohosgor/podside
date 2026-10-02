# podside

A Kubernetes pod pane that lives beside [Claude Code](https://claude.com/claude-code).

podside is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview): it draws a live pod list next to your conversation, lets you read logs and `describe` output with one key, and tells Claude which pod you are looking at, so you can just ask "why is this pod failing?".

It is inspired by the keyboard-first flow of [k9s](https://k9scli.io), but it is a separate project with no affiliation to k9s.

## What it does

- **Live pod list**, grouped by namespace, refreshed every 5 seconds while the pane is open
- **Health at a glance**: `●` running, `◐` starting, `✕` failing, `○` completed, with totals in the top bar
- **Logs** (following, newest at the bottom) and **describe** output for the selected pod
- **Ask Claude**: sends the pod's `describe` output and recent logs to Claude for a diagnosis
- **Selection as context**: while the pane is open, every prompt you send carries the selected pod, so "this pod" means something
- **A one-line summary above the prompt** (context, namespace, healthy and failing counts) once you have opened the pane
- **Read-only by design**: podside only runs `kubectl get`, `logs`, `describe`, `version` and `config` reads. It never writes to your cluster, and its context switcher passes `--context` instead of touching your kubeconfig.

## Install

Requires Claude Code v2.1.287 or later and `kubectl` on your `PATH`.

```
/plugin marketplace add ohosgor/podside
/plugin install podside@podside
```

Or from your shell:

```sh
claude plugin marketplace add ohosgor/podside
claude plugin install podside@podside
```

## Use

```
/podside              # all namespaces
/podside my-namespace # one namespace
```

The pane takes the keyboard when it opens. `Esc` hands it back to the prompt; click the pane or press `ctrl+x` then `Tab` to return.

| Key | Action |
| --- | --- |
| `j` `k` | Move the selection down / up (`↑` `↓` and `Tab` work too) |
| `l` | Logs of the selected pod |
| `d` | Describe the selected pod |
| `a` | Ask Claude about the selected pod |
| `b` | Back to the list |
| `f` | Toggle failing pods only |
| `n` | Next namespace |
| `r` | Refresh now |
| `h` | Show or hide the built-in help |

The **context**, **namespace** and **search** fields at the top are reachable with `Tab`. A short guide sits at the bottom of the pane on first use; `h` hides it and podside remembers that.

## Develop

```sh
git clone https://github.com/ohosgor/podside
claude --plugin-dir ./podside   # hot-reloads on save
claude plugin validate ./podside
claude plugin test ./podside
```

The hooks module is `hooks/register.tsx`; its tests are in `register.test.tsx` and run against a stubbed `kubectl`.

## Security

A mod runs inside Claude Code with your permissions. podside's own calls are limited to the `kubectl` reads listed above, `$.prompt.submit` for "Ask Claude", and drawing its pane. You can list everything it hooks and calls without running it:

```sh
claude plugin validate .
```

## Data and privacy

- **What podside runs:** only `kubectl`, with your own kubeconfig: `config get-contexts`, `config current-context`, `config view --minify`, `version`, `get ns`, `get pods`, `logs` and `describe pod`. It talks to your cluster through `kubectl` and makes no other network requests.
- **What reaches Claude:** while the pane is open, each prompt you send carries the selected pod's namespace, name, status, readiness, restarts, age, node and IP. When you press `a`, the pod's `describe` output and its last 120 log lines are sent as a prompt. Nothing is sent while the pane is closed or no pod is selected.
- **What it stores:** whether you hid the help (`h`), in Claude Code's local plugin store. Pod data lives only in the session's memory.
- **What it never does:** write to your cluster, change your kubeconfig, read environment variables or credentials, or send data anywhere else.

## License

[Apache-2.0](LICENSE)
