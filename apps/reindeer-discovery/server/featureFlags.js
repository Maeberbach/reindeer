/**
 * Feature flags for Reindeer: Discovery.
 *
 * Mirrors apps/reindeer-registry/server/featureFlags.js.
 * If you change one, change the other.
 */

export const FEATURE_FLAGS = {
  subscriptionGate: false,
  multiEstate: false,
};

export function isSubscriptionGateEnabled() {
  if (process.env.REINDEER_FEATURE_SUBSCRIPTION_GATE === 'true') return true;
  return FEATURE_FLAGS.subscriptionGate === true;
}

export function isMultiEstateEnabled() {
  return FEATURE_FLAGS.multiEstate === true;
}
