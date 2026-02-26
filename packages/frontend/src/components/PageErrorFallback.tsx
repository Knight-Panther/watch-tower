import type { FallbackProps } from "react-error-boundary";
import Button from "./ui/Button";

export default function PageErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-red-800/50 bg-red-950/10 px-6 py-16 text-center">
      <p className="text-sm font-medium text-red-300">Something went wrong</p>
      <p className="max-w-md text-xs text-red-400/70">
        {error instanceof Error ? error.message : "An unexpected error occurred while rendering this page."}
      </p>
      <Button variant="secondary" onClick={resetErrorBoundary}>
        Try Again
      </Button>
    </div>
  );
}
