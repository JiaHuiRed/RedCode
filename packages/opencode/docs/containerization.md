# Containerization

RedCode has no built-in sandbox (see [SECURITY.md](../../../SECURITY.md)). The
permission system is a UX confirmation layer, not an isolation boundary. If
you need real isolation, put a boundary around the whole process yourself.
Two patterns are documented below — both usable today with what's already in
this repo — plus a third pattern that isn't built yet, described so it's
clear what a stronger boundary would look like if someone wants to build it.

## Pattern 1: Plain Docker

Simplest boundary: run the whole `opencode` process inside a container. The
agent's shell/write/edit tools only ever touch the container's filesystem;
the workspace is whatever you bind-mount in.

`packages/opencode/Dockerfile` packages the compiled CLI binary, so build
the binary first:

```bash
cd packages/opencode
bun run build   # produces dist/redcode-windows-x64/bin/redcode.exe
docker build -f Dockerfile -t redcode-sandbox ..
```

Then run it against a project directory, passing through only the provider
credentials you need:

```bash
docker run --rm -it \
  -v "$(pwd)/my-project:/workspace" \
  -w /workspace \
  -e ANTHROPIC_API_KEY \
  redcode-sandbox
```

Trade-off: provider API keys enter the container as environment variables.
The container boundary protects your host filesystem and processes from a
misbehaving or hijacked agent run, but it does not protect your API keys
from that same agent run — a compromised session inside the container can
still exfiltrate whatever credentials you passed in.

## Pattern 2: VM isolation

For a stronger boundary than a container (protects against container
escapes, isolates at the kernel level), run RedCode inside a disposable VM:

- Snapshot the VM before starting a session; revert to the snapshot after —
  treat the VM as single-use, not a persistent environment.
- Don't share the host clipboard or a host folder beyond the one project
  directory you intend the agent to touch.
- Same credential caveat as Docker: whatever provider keys you put inside
  the VM are reachable by the agent running inside it.

## Pattern 3 (not implemented): route only tool calls into isolation

Both patterns above put the *entire* process — TUI/GUI rendering, session
state, and provider auth — inside the boundary, which means credentials
have to enter the sandbox too. A tighter design keeps `redcode` and provider
auth on the host, and routes only the tools that touch the outside world
(shell execution, file write/edit — see the permission table in
[SECURITY.md](../../../SECURITY.md)) into a local sandbox (a micro-VM or
policy-controlled subprocess), with everything else running normally on the
host. That way a compromised shell/write call can't reach host credentials
even though the UI and LLM calls never leave the host.

Nothing like this exists in RedCode today — this section describes the
shape of the stronger design, not a shipped feature. If you build something
like this, a plugin hooking `tool.execute.before`/`after` in
`packages/opencode/src/permission/` is the natural place to route matching
tool calls elsewhere before they run locally.
