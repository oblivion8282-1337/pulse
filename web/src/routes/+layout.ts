// SPA mode — we render everything on the client and rely on the FastAPI
// backend for data. Disable SSR globally to keep the bundle simple and
// avoid having to ship server-side cookie auth.
export const ssr = false;
export const prerender = false;
