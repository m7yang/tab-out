# UI Implementation

Read this guide when changing React components/hooks, shared primitives, styling, or UI selectors. Source paths are relative to the repository root.

## React Compiler

- React Compiler is enabled for this repo.
- Do not add `useMemo`, `useCallback`, or `React.memo` as default render-performance guards in new code.
- Use manual memoization only when function or object identity is part of the behavior contract, such as stable values passed through React context, callbacks returned from custom hooks where consumers depend on stable identity, effect/listener/timer cleanup patterns that require stable references, or third-party component APIs that depend on referential equality.
- When touching existing manual memoization, remove it only with focused verification. Existing hooks may be preserving behavior or compiler output.

## Components, Anchors, And Styling

- Preserve the compact dashboard density and existing visual language during narrow fixes.
- Prefer existing local components and wrappers under `src/components/ui/`.
- Treat `src/components/ui/` as the shared shadcn/Base UI primitive layer. Preserve upstream-supported components, props, variants, orientations, and states when product callers use only a subset; express product-specific narrowing in callers or wrappers outside `src/components/ui/`. Change the shared surface only for an intentional library-wide customization, behavior or accessibility fix, or reviewed upstream sync.
- The repo uses Base UI, shadcn configuration, Tailwind v4 utilities, and `lucide-react`. Use those patterns for new UI where they fit, but do not churn existing inline SVGs during unrelated fixes.
- Add stable UI anchors to user-facing surfaces and actions that agents, tests, or live QA need to identify. Prefer existing semantic classes when they also serve styling, `data-slot` for shared UI primitive parts, `data-tabout="<landmark>"` for stable product-level landmarks, and `data-tabout-part="<part>"` for important sub-actions inside them. Do not use `data-testid` as the default anchor, and do not name every wrapper element; use anchors for meaningful surfaces, actions, and rare repeatedly-debugged layout parts.
- Use `data-tabout` values that match `CONTEXT.md` domain language for product landmarks, such as `domain-card`, `page-chip`, `activation-history`, `working-set`, or `filter-query` when it maps to the visible filter. Use plain DOM/action part names for `data-tabout-part`, such as `close-button`, `pin-button`, or `source-option`; avoid React component names unless the component name is also the product term.
- Place `data-tabout` and `data-tabout-part` near the front of JSX props, after element-defining props such as `type`, `role`, `href`, `value`, or `tabIndex`, and before `className`, accessibility props, and event handlers.
- Use explicit `data-*` state attributes instead of semantic class names when a marker exists only for tests, QA, or state inspection and is not consumed by CSS, layout, animation, or runtime selectors.
- Tests may use UI anchors for layout surfaces, repeated dashboard items, and extension/browser-smoke checks where role or text selectors are weak. Prefer role, label, or text selectors for true controls when those selectors are stable and user-meaningful.
- Do not mass-retrofit UI anchors across untouched surfaces. Add or adjust anchors when changing or debugging that surface; a focused pass is acceptable only for frequently referenced top-level landmarks such as the dashboard shell, Dashboard View, filter, Domain Card, Page Chip, Activation History, Working Set, tooltip content, or menu content.
- Add `corner-shape: squircle` to non-round UI elements that use `border-radius`.
- Do not add squircle styling to true circles or pills such as `border-radius: 50%` or `999px`.
- Squircle corners read less rounded than ordinary rounded corners. As a visual rule of thumb, a `4px` squircle looks similar to a `2px` non-squircle corner.
