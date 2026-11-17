// Old address (wine-menu.pages.dev) -> new address (smappagroup-host-menu.pages.dev).
// Only page loads are moved; /api calls keep working on the old address so iPads that
// have not reloaded yet still get menu updates. The browser keeps the #menu-... part.
// We only redirect once the new address is actually up, so merging this early is safe.
const OLD_HOST = "wine-menu.pages.dev";
const NEW_ORIGIN = "https://smappagroup-host-menu.pages.dev";
let newSiteUp = false;
let checkedAt = 0;

async function newSiteReady() {
  if (newSiteUp) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  try {
    const r = await fetch(NEW_ORIGIN + "/api/version", { cf: { cacheTtl: 0 } });
    newSiteUp = r.ok;
  } catch {
    newSiteUp = false;
  }
  return newSiteUp;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (
    url.hostname === OLD_HOST &&
    context.request.method === "GET" &&
    !url.pathname.startsWith("/api/") &&
    (await newSiteReady())
  ) {
    return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 302);
  }
  return context.next();
}
