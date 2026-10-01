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
| `↑` `↓` / `Tab` | Move between pods; the focused pod is selected |
| `l` | Logs of the selected pod |
| `d` | Describe the selected pod |
| `a` | Ask Claude about the selected pod |
| `b` | Back to the list |
| `f` | Toggle failing pods only |
| `n` | Next namespace |
| `r` | Refresh now |

The **context**, **namespace** and **search** fields at the top are reachable with `Tab`.

## Develop

```sh
git clone https://github.com/ohosgor/podside
claude --plugin-dir ./podside/plugins/podside   # hot-reloads on save
claude plugin validate ./podside/plugins/podside
claude plugin test ./podside/plugins/podside
```

The hooks module is `plugins/podside/hooks/register.tsx`; its tests are in `register.test.tsx` and run against a stubbed `kubectl`.

## Security

A mod runs inside Claude Code with your permissions. podside's own calls are limited to the `kubectl` reads listed above, `$.prompt.submit` for "Ask Claude", and drawing its pane. You can list everything it hooks and calls without running it:

```sh
claude plugin validate ./plugins/podside
```

## License

[Apache-2.0](LICENSE)
