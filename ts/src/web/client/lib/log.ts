/** Minimal browser-safe logger for web/client. Wraps console directly so the
 *  browser UI bundle never depends on the server-tier `logger.ts` (which is
 *  conceptually a different runtime, even though today it only uses console). */

export function error(component: string, message: string): void {
  console.error(`[${component}] ${message}`);
}
