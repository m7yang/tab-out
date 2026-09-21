import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import type { ReactNode } from 'react'

// The dashboard is the whole new-tab page: without a boundary, one render
// throw unmounts the root and the user gets a blank tab (see the storage-
// revived tone-map crash). The fallback is deliberately self-contained —
// plain elements only, no app contexts or ui/ components, so it cannot
// share a failure cause with the tree it replaces.
export function DashboardErrorFallback({ error }: FallbackProps) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border border-(--warm-gray) bg-tab-card p-6 [corner-shape:squircle]">
        <h1 className="text-base font-semibold text-foreground">Tab Out hit an error</h1>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          The dashboard crashed while rendering. Reloading usually recovers it.
        </p>
        {message && (
          <pre className="mt-3 overflow-x-auto rounded-lg [corner-shape:squircle] bg-[rgba(115,115,115,0.08)] p-2 text-xs leading-4 whitespace-pre-wrap text-muted-foreground">{message}</pre>
        )}
        <button
          type="button"
          className="mt-4 inline-flex h-8 cursor-pointer items-center justify-center rounded-xl border border-(--warm-gray) bg-transparent px-3 text-sm font-medium text-foreground [corner-shape:squircle] hover:border-(--accent-amber) hover:bg-[rgba(82,82,82,0.08)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  )
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      FallbackComponent={DashboardErrorFallback}
      onError={(error, info) => {
        console.error('[tab-out] dashboard render error', error, info.componentStack)
      }}
    >
      {children}
    </ErrorBoundary>
  )
}
