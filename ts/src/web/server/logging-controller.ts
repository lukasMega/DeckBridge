// The logging + diagnostics half of the WebUI surface: the "Debug logging"
// toggle, where the log file lives, and the two diagnostics-report actions.
// Split out of web-ui-server.ts to keep that file under the 500-line check-loc
// gate; the report builder itself is pure and lives in diagnostics.ts.
import type { PersistedSettings } from './persisted-settings.js';
import { buildLiveDiagnostics, saveLiveDiagnostics } from './diagnostics-sources.js';
import type { LiveDiagnosticsInputs } from './diagnostics-sources.js';
import type { DiagnosticsOptions } from './diagnostics.js';
import { activeLogFilePath, logDir, logFilePath } from '../../log-file.js';
import { currentLogLevel, setLogLevel } from '../../logger.js';
import { isLogLevel, LOG_LEVELS } from '../../cli.js';
import { openPathInOS } from '../../os-utils.ts';

type ReqError = { error: string; status: number };

export class LoggingController {
  constructor(
    private readonly settings: PersistedSettings,
    /** Live sources only the server knows (dock state, ring buffers) — built
     *  fresh per report so it always reflects the moment it was taken. */
    private readonly liveInputs: () => LiveDiagnosticsInputs,
    private readonly broadcast: (event: string, payload: unknown) => void,
    private readonly emit: (event: string, ...args: unknown[]) => boolean,
  ) {}

  /** The level actually in effect, not merely the persisted one. */
  level(): string {
    return currentLogLevel();
  }

  path(): string {
    return activeLogFilePath() ?? logFilePath();
  }

  /** Validate + apply a level change: persist it, apply it to the main thread,
   *  and let app.ts push it to every USB worker ('setLogLevel'). Env is updated
   *  too, so workers spawned later inherit it at module load. */
  trySetLevel(level: unknown): ReqError | null {
    if (!isLogLevel(level)) {
      return { error: `level must be one of: ${LOG_LEVELS.join(', ')}`, status: 400 };
    }
    this.settings.setLogLevel(level);
    setLogLevel(level);
    tjs.env.DECKBRIDGE_LOG_LEVEL = level;
    this.broadcast('logLevel', { level });
    this.emit('setLogLevel', level);
    return null;
  }

  /** Reveal the log folder in the OS file manager. */
  async openFolder(): Promise<void> {
    await openPathInOS(logDir());
  }

  buildReport(opt: DiagnosticsOptions = {}): Promise<string> {
    return buildLiveDiagnostics(this.liveInputs(), opt);
  }

  saveReport(opt: DiagnosticsOptions = {}): Promise<string | null> {
    return saveLiveDiagnostics(this.liveInputs(), opt);
  }
}
