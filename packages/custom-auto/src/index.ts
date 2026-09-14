export {
  CUSTOM_AUTO_SEATS,
  CustomAutoProfileSchema,
  CustomAutoRouteSchema,
  MANAGED_FREE_PROVIDER_IDS,
  TRUST_DOMAIN,
  TrustDomainViolationError,
  assertTrustDomain,
  validateCustomAutoProfile,
  type CustomAutoProfile,
  type CustomAutoRoute,
  type CustomAutoSeat,
} from "./profile.js";

export {
  CUSTOM_AUTO_NAMESPACE,
  DEFAULT_CUSTOM_AUTO_OWNER,
  CustomAutoStore,
  createCustomAutoStore,
} from "./store.js";
