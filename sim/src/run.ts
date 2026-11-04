/** Headless game runner (placeholder until the core loop exists; see issue #3 and #8). */
import { Rng } from '@sr/core';

const seed = Number(process.argv[2] ?? 1);
const rng = new Rng(seed);
console.log(`Signature Required sim: seed ${seed}, first roll ${rng.int(1, 6)}. Nothing to simulate yet.`);
