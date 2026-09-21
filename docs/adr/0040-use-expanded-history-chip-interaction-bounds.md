# ADR 0040: Use Expanded History Chip Interaction Bounds

Activation History and Domain Card Page Chips both collapse immediately when the pointer leaves the expanded surface. The resting row boundary made rapid scanning easy, but caused revealed History text to disappear when the pointer moved onto it. The visible expanded chip is now the interaction boundary, with no exit grace period.

History retains its measured resting slot and separate painted copy. That copy receives pointer input for the visible page, and both surfaces share one context menu and hover boundary so covered rows cannot steal hover or receive clicks. The canonical chip retains keyboard and accessibility identity. Favicon actions, native scrolling, menu ownership, and existing keyboard dismissal behavior remain unchanged; Escape dismissal is outside this decision.

See the [Title Expansion contract](../../CONTEXT.md) and [expansion ownership](0021-expansion-ownership-lives-in-the-title-expansion-controller.md).
