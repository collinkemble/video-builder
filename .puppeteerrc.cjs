const { join } = require('path');

/**
 * Puppeteer configuration for Heroku Fir (CNB buildpacks).
 * Tells Puppeteer where to store/find the Chrome binary.
 *
 * Matches the working Slide Generator setup:
 * Cache goes inside node_modules so it persists from build to runtime
 * as part of the CNB node_modules layer.
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, 'node_modules', '.cache', 'puppeteer'),
};
