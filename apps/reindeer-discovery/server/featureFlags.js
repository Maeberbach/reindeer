// Feature flags for the Discovery app.
//
// These flags allow new functionality to be merged behind a toggle
// so it can be developed and tested without affecting live behaviour.
//
// All flags default to OFF (false) for safety.

const featureFlags = {
  // Per-estate subscription gate.
  // When true, write endpoints are blocked for estates whose
  // subscription is expired or locked (HTTP 402).
  subscriptionGate: false,

  // Multi-estate support — a single Discovery instance serving
  // multiple estates. Reserved for future use.
  multiEstate: false,
};

// Allow individual flags to be overridden via environment variables
// (e.g. REINDEER_FEATURE_SUBSCRIPTION_GATE=true) without code changes.
if (process.env.REINDEER_FEATURE_SUBSCRIPTION_GATE === 'true') featureFlags.subscriptionGate = true;
if (process.env.REINDEER_FEATURE_MULTI_ESTATE === 'true') featureFlags.multiEstate = true;

export function isSubscriptionGateEnabled() {
  return featureFlags.subscriptionGate === true;
}

export function isMultiEstateEnabled() {
  return featureFlags.multiEstate === true;
}

export { featureFlags };
