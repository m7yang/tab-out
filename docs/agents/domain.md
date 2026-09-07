# Domain Docs

Use this guide when changing domain terminology, product behavior, or architecture.

## Read the relevant domain context

- Read the relevant sections of root `CONTEXT.md` when naming domain concepts or changing their behavior.
- Read ADRs in `docs/adr/` when the task touches the decisions they document.

If either does not exist, proceed silently. Do not flag its absence or suggest creating it upfront.

## File structure

This is a single-context repo:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When output names a domain concept—such as in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the needed concept is absent, reconsider whether the repo uses that term or note a genuine gap for future domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
