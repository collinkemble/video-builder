const { join } = require('path');

/**
 * Puppeteer configuration for Heroku Fir (CNB buildpacks).
 *
 * On Heroku Fir, the node_modules directory persists from build to runtime
 * as a CNB layer. By placing the Chrome cache inside node_modules, we
 * ensure the downloaded Chrome binary is available at runtime.
 *
 * PUPPETEER_CACHE_DIR env var overrides this if set.
 */
module.exports = {
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || join(__dirname, 'node_modules', '.puppeteer-cache'),
};
