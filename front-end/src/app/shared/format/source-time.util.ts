const WALL_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;

/**
 * Print a timezone-free source timestamp as ``YYYY-MM-DD HH:MM:SS``. It never goes through
 * ``Date``, so the browser can't shift it. Values with an offset or in another shape are
 * returned unchanged.
 */
export function formatSourceTime(value: string): string {
  const match = WALL_TIME.exec(value);
  return match ? match[1] + ' ' + match[2] : value;
}
