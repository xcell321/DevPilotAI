import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center py-20 text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-muted">404</p>
      <h2 className="mt-2 text-lg font-semibold text-ink">Page not found</h2>
      <p className="mt-2 text-sm text-muted">
        This route does not exist in the DevPilot workspace.
      </p>
      <Link to="/" className="btn btn-primary mt-5">
        Back to overview
      </Link>
    </div>
  );
}
