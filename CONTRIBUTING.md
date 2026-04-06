# Contributing to Watch Tower

Watch Tower is a production system built for real media clients.
It's open-sourced so other developers can learn from the architecture,
adapt it, or build on top of it — not as a community-driven OSS project.
That's an honest framing, and it shapes how contributions work here.

## Found a bug?

Open an Issue. Include:
- Which pipeline stage failed (ingest / dedup / scoring / translate / image / distribute)
- The error from worker or API logs (`LOG_LEVEL=debug` helps)
- Your LLM provider and platform setup
- Whether it's consistent or intermittent

No logs = hard to help.

## Have a question or idea?

Use Discussions, not Issues. Issues are for things that are broken.
Discussions are for "how does X work", "would you consider Y", or
"I'm building something similar and ran into Z".

## Want to submit a PR?

Small and focused wins every time. Before opening one:
- Make sure it doesn't touch multiple unrelated things
- Follow the existing code style (double quotes, semicolons, trailing commas)
- Don't add dependencies without a good reason
- Run `npx vitest run` — and stop `npm run dev` first or the tests will fail

PRs most likely to be merged:
- Bug fixes with a clear reproduction case
- New LLM provider (implement the `LLMProvider` interface in `packages/llm`)
- New social platform (implement `SocialProvider` in `packages/social`)
- RSS feed parsing improvements
- Documentation fixes

PRs that won't be merged right now:
- Multi-tenant or auth system changes (deliberately deferred)
- New infrastructure dependencies
- Breaking changes to pipeline stage contracts
- Speculative features without a concrete use case

## Dev setup

Follow Quick Start in the README. One non-obvious thing:
stop `npm run dev` before running `npx vitest run` — the dev worker
shares Redis queues and will steal test jobs, causing false failures.

---

Built and maintained by [Giorgi Teliashvili](https://github.com/Knight-Panther). Questions welcome.
