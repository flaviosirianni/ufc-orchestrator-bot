import { bootstrapNutritionBot } from './runtime.js';

export async function bootstrapBot({ manifest } = {}) {
  return bootstrapNutritionBot({ manifest });
}
