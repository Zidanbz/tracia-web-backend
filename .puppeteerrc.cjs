/** @type {import('puppeteer').Configuration} */
module.exports = {
  chrome: {
    skipDownload: false,
  },
  'chrome-headless-shell': {
    skipDownload: true,
  },
  firefox: {
    skipDownload: true,
  },
};
