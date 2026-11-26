/** Built-in browser component strings */
export default {
  scriptTimeout: 'Page script execution timed out',
  loadFailedReason: 'Page failed to load: {{reason}}',
  loadFailedNetwork:
    'Page failed to load (network error): a system proxy may be blocking the site; direct connection was attempted but still failed. Check whether the address is reachable in your system browser. For intranet pages, make sure you are connected to the intranet',
  loadFailedCode: 'Page failed to load ({{code}}): {{description}}',
  checkUrlNetwork: 'check the URL and network',
  browserNotCreated: 'Built-in browser not created yet',
  loadTimeout:
    'Page load timed out (20s): the URL may be unreachable, or the page is waiting for login/redirect. Current address: {{url}}',
  emptyAddress: '(empty)',
  domCollectFailed: 'Failed to collect page DOM',
  screenshotEmpty: 'Page screenshot is empty. Make sure the page has finished loading',
  scrollTopStuck: 'The page could not scroll back to the top; capture aborted (the page may block scrolling). Please retry',
  guestLayoutMismatch:
    'Page viewport does not match the design baseline width and auto-correction did not converge; capture aborted. Please retry',
  captureReloaded: 'The page reloaded during capture; screenshot aborted. Please retry',
  compositorStale:
    'Page rendering has not updated for a long time; capture aborted to avoid duplicated content. Please retry',
  notLoaded: 'No page loaded',
  refresh: 'Refresh',
  emptyUrlHint: 'Enter a dev environment page URL to load'
}
