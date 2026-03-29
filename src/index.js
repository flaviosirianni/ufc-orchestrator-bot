import './core/env.js';
import { launchBotRuntime } from './platform/launcher.js';

launchBotRuntime().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
