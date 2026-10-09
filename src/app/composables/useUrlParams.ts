/** URL of another page of this app, keeping the query string (OVERLAY_WS and the like). */
export function pageUrl(route: string): string {
  return `${window.location.pathname}${window.location.search}#${route}`;
}
