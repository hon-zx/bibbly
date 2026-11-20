# Prompts

The requests that built Bibbly, word for word and in order, so the reasoning
behind the code travels with it. Each file holds one prompt, when it was sent,
and what it led to.

| # | Prompt | Led to |
|---|---|---|
| 1 | [Product brief](2026-11-12-01-product-brief.md) | The interactive prototype (`apps/web/`) |
| 2 | [Build the apps and the Stick firmware](2026-11-12-02-build-the-apps-and-stick.md) | `packages/core`, the desktop, phone and server apps, the Stick firmware |
| 3 | [Repository, Bibbly.io and connected apps](2026-11-19-03-repo-and-connected-apps.md) | `packages/connectors`, the sign-in broker, connected apps in both apps, this repository setup |
| 4 | [Continue](2026-11-20-04-continue.md) | The phone side of connected apps, docs |

## Adding a prompt

Add a file named `YYYY-MM-DD-NN-short-title.md` (NN continues the numbering)
with the prompt in a ` ```text ` block exactly as written, then a row in the
table above. Commit it with the code it produced. `CLAUDE.md` asks Claude to do
this for every new request.
