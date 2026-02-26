import { Link } from "react-router-dom";
import Button from "./ui/Button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-slate-700 bg-slate-900/20 px-6 py-16 text-center">
      <p className="text-4xl font-bold text-slate-600">404</p>
      <p className="text-sm font-medium text-slate-400">Page not found</p>
      <p className="max-w-sm text-xs text-slate-500">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <Link to="/">
        <Button variant="secondary">Go to Home</Button>
      </Link>
    </div>
  );
}
