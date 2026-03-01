interface SkeletonProps {
  className?: string;
}

/** Single line shimmer for text placeholders */
export function SkeletonText({ className = "w-48 h-4" }: SkeletonProps) {
  return <div className={`animate-pulse bg-slate-800 rounded ${className}`} />;
}

/** Rectangle shimmer for card/image placeholders */
export function SkeletonCard({ className = "w-full h-32" }: SkeletonProps) {
  return <div className={`animate-pulse bg-slate-800 rounded-lg ${className}`} />;
}

/** Table row shimmer — renders N columns of varying width */
export function SkeletonRow({ columns = 5 }: { columns?: number }) {
  const widths = ["w-16", "w-48", "w-32", "w-24", "w-20", "w-36", "w-28"];
  return (
    <tr className="border-b border-slate-800/50">
      {Array.from({ length: columns }, (_, i) => (
        <td key={i} className="px-4 py-3">
          <div className={`animate-pulse bg-slate-800 rounded h-4 ${widths[i % widths.length]}`} />
        </td>
      ))}
    </tr>
  );
}

/** Repeated skeleton rows for table loading state */
export function SkeletonTable({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </>
  );
}

/** Generic skeleton wrapper — pass className to control size/shape */
export function Skeleton({ className = "w-full h-4" }: SkeletonProps) {
  return <div className={`animate-pulse bg-slate-800 rounded ${className}`} />;
}
