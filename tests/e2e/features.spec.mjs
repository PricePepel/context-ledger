// Card H11: every entry in docs/features.json opens and reaches its last step, so the
// map an agent drives cannot drift from the app. Card H14: entries that start a swarm
// run are checked in swarm.spec.mjs instead, one at a time with the other swarm tests:
// a ledger runs one swarm at a time, and two spec files run in parallel.
import { loadFeatures } from '../../scripts/drive.mjs';
import { checkFeature, featureTitle } from './feature-check.mjs';
import { test } from './fixtures.mjs';

for (const feature of loadFeatures()) if (!feature.runsSwarm) test(featureTitle(feature), checkFeature(feature));
