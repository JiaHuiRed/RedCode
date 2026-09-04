---
name: effect
description: Work with Effect v4 TypeScript in this repo — services, layers, Schema, typed errors, test helpers. Use when writing or debugging Effect code, or when an Effect API does not behave the way you remember it.
---

# Effect

This codebase uses Effect for typed, composable TypeScript services, schemas, and workflows.

## Source Of Truth

Use the current Effect v4 source, not memory or older Effect v2/v3 examples. The APIs moved a lot
between v2/v3 and v4 — anything you remember is more likely stale than right.

1. **The full TypeScript source ships inside the package. No clone needed.** Read
   `packages/<pkg>/node_modules/effect/src/*.ts` — note this is the **package-level** `node_modules`
   (`packages/opencode/node_modules/effect/src/`), not the repo root. This repo runs `4.0.0-beta.x`.
2. Search that `src/` tree for exact signatures, overloads, and naming patterns before answering or
   implementing Effect-specific code. `codegraph_explore` also indexes it.
3. Also inspect existing repo code for local house style before introducing new patterns.
4. Prefer answers and implementations backed by specific source files or nearby repo examples.

## Guidelines

- Prefer current Effect v4 APIs and project-local patterns over old blog posts, examples, or package-memory guesses.
- Use `Effect.gen(function* () { ... })` for multi-step workflows.
- Use `Effect.fn("Name")` or `Effect.fnUntraced(...)` for named effects when adding reusable service methods or important workflows.
- Prefer Effect `Schema` for API and domain data shapes. Use branded schemas for IDs and `Schema.TaggedErrorClass` for typed domain errors when modeling new error surfaces.
- Keep HTTP handlers thin: decode input, read request context, call services, and map transport errors. Put business rules in services.
- In Effect service code, prefer Effect-aware platform abstractions and dependencies over ad hoc promises where the surrounding code already does so.
- Keep layer composition explicit. Avoid broad hidden provisioning that makes missing dependencies hard to see.
- In tests, prefer the repo's existing Effect test helpers and live tests for filesystem, git, child process, locks, or timing behavior.
- Do not introduce `any`, non-null assertions, unchecked casts, or older Effect APIs just to satisfy types.
- Do not answer from memory. Verify against `node_modules/effect/src/` or nearby repo code first.
  A concrete example of why: this repo's Effect beta has **no `Effect.either`** — to get at a failure
  value you use `Effect.flip`. Guessing the v3 name compiles to nothing and wastes a round trip.

## Testing Patterns

- Use `testEffect(...)` from `packages/opencode/test/lib/effect.ts` for tests that exercise Effect services, layers, runtime context, scoped resources, or platform integrations.
- Use `it.live(...)` for filesystem, git repositories, HTTP servers, sockets, child processes, locks, real time, and other live platform behavior.
- **Anything that touches the database wants `it.instance(...)`, not `it.effect(...)`.** `it.effect` does
  not stand up a `TestInstance`, so calls like `session.create` hit a foreign-key error that reads like
  a bug in the code under test. If a DB-backed test fails on FK, check which runner it uses first.
- Run tests from package directories such as `packages/opencode`; never run package tests from the repo root.
- Prefer explicit test layers over ad hoc managed runtimes. Keep dependency provisioning visible in the test file.
- Use scoped fixtures and finalizers for resources that must be cleaned up, including temporary directories, flags, databases, fibers, servers, and global state.
