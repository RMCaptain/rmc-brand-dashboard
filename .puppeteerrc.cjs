const { join } = require('path');

/**
 * Puppeteer configuration.
 *
 * Render (and most PaaS) only persist the project source directory from the
 * build step to the runtime container. Puppeteer's default browser cache lives
 * in ~/.cache/puppeteer, which is OUTSIDE the project dir and therefore wiped
 * between build and runtime — causing "Browser was not found at the configured
 * executablePath" at runtime.
 *
 * Pinning cacheDirectory inside the project dir makes the downloaded Chrome
 * persist into the runtime container. The buildCommand also runs
 * `npx puppeteer browsers install chrome` so the binary is present after
 * `npm install`.
 */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
