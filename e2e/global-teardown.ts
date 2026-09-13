export default function globalTeardown(): void {
  const pid = process.env.E2E_LIGHTPANDA_PID;
  if (pid === undefined) return;
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    // already gone
  }
}
