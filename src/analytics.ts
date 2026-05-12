export type GtagParam = string | number | boolean;

export function trackEvent(
  eventName: string,
  params?: Record<string, GtagParam>
): void {
  if (typeof window === "undefined") return;
  const fn = window.gtag;
  if (typeof fn !== "function") return;
  fn("event", eventName, params);
}
