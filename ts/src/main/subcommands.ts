import { applyFlagsToEnv, USAGE_TEXT, versionText } from '../shared/cli.js';
import type { ParsedCli } from '../shared/cli.js';
import { runDevicesCommand } from '../cli/devices.js';
import { runPushCommand } from '../cli/push.js';
import { runDiagnoseCommand } from '../cli/diagnose.js';
import { runRelayCommand } from './relay/run.js';

// Subcommands never serve and never take the instance lock, so each one exits the process here;
// `run` returns and app.ts continues into normal startup.
export async function runSubcommand(cli: ParsedCli): Promise<void> {
  switch (cli.command) {
    case 'version':
      console.log(versionText());
      tjs.exit(0);
      break;
    case 'help':
      console.log(USAGE_TEXT);
      tjs.exit(0);
      break;
    case 'push':
      tjs.exit(await runPushCommand(cli.rest ?? []));
      break;
    case 'relay':
      tjs.exit(await runRelayCommand(cli.rest ?? []));
      break;
    case 'devices':
      await runDevicesCommand();
      tjs.exit(0);
      break;
    case 'diagnose':
      // After applyFlagsToEnv: reports effective flags/env and honours --cache-dir.
      applyFlagsToEnv(cli.flags);
      await runDiagnoseCommand(cli.flags);
      tjs.exit(0);
      break;
    default:
      break;
  }
}
