let initialRoute = "";

/** Called once at startup, before the router runs. */
export function recordInitialRoute(): void {
  initialRoute = window.location.hash || "#/";
}

/** The route the page was loaded with; a page reached later by an in-app route change differs. */
export function getInitialRoute(): string {
  return initialRoute;
}
