import { bootstrapOvidiusMedibot } from './runtime.js';

export async function bootstrapBot({ manifest } = {}) {
  return bootstrapOvidiusMedibot({ manifest });
}
