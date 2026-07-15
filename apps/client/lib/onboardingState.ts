// Where in onboarding the user last was. Module-level on purpose: it survives
// the deep-link re-navigation after an OAuth connect (which used to reset the
// flow to step 1), and resets naturally with a full app restart.
let lastRoute = "/onboarding";

export function setOnboardingRoute(route: string) {
  lastRoute = route;
}

export function getOnboardingRoute() {
  return lastRoute;
}

// Sign-out / account switch happens within the same process, so `lastRoute`
// would otherwise carry the previous user's mid-flow step into a fresh
// onboarding (landing on step 3 with no back stack). Reset it to the start.
export function resetOnboardingRoute() {
  lastRoute = "/onboarding";
}
