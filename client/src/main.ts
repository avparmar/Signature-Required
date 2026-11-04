// Placeholder client (Stage 1 builds the real one).
import { Rng } from '@sr/core';

const status = document.getElementById('status');
if (status) status.textContent = `Nothing to play yet. (Core loaded: rolled ${new Rng(Date.now()).int(1, 6)}.)`;
