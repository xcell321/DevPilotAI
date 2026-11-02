interface AuthRejectionDetails {
  method?: string;
  path?: string;
  remoteAddress?: string;
}

export function formatAuthRejection(
  reason: string,
  details: AuthRejectionDetails,
): string {
  const method = details.method ?? 'UNKNOWN';
  const path = details.path ?? 'unknown';
  const remote = details.remoteAddress ?? 'unknown';
  return `[security] ${reason}: ${method} ${path} from ${remote}`;
}

export function logAuthRejection(
  reason: string,
  details: AuthRejectionDetails,
): void {
  console.warn(formatAuthRejection(reason, details));
}
