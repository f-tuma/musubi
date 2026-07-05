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
