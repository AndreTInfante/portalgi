// Overwritten with the commit SHA by the deploy workflow (pages.yml).
// GitHub Pages caches modules for 10 minutes; after rapid deploys a browser
// can run a MIXED module graph (stale shader + fresh data layout = dead GL
// context). This stamp makes the running build verifiable at a glance.
export const BUILD = 'dev';
