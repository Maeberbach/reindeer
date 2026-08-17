/**
 * Feature flags for Reindeer: Discovery.
 *
 * Mirrors apps/reindeer-registry/server/featureFlags.js.
 * If you change one, change the other.
 */

export const FEATURE_FLAGS = {
  subscriptionGate: false,
  multiEstate: false,
  // Heir visibility restrictions — when true, strip private fields
  // (pricing, recipient, ownership tags, ai_confidence) from heir-facing
  // endpoints. Toggled by Reindeer Corp admin before client distribution.
  heirVisibility: true,
};

export function isSubscriptionGateEnabled() {
  if (process.env.REINDEER_FEATURE_SUBSCRIPTION_GATE === 'true') return true;
  return FEATURE_FLAGS.subscriptionGate === true;
}

export function isMultiEstateEnabled() {
  return FEATURE_FLAGS.multiEstate === true;
}

export function isHeirVisibilityEnabled() {
  if (process.env.REINDEER_FEATURE_HEIR_VISIBILITY === 'false') return false;
  return FEATURE_FLAGS.heirVisibility === true;
}
