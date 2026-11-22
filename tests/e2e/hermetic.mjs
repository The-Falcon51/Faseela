// Keeps the browser suites off the network. Requests to the local test server pass; Supabase REST reads are
// answered like an empty project (tables: [], RPC: null), storage images with a 1x1 PNG; everything else outside gets an empty 404. Suites stay
// reproducible offline and never touch the live project; a suite's own mocks (page.route / context.route
// registered later) still take precedence over this catch-all.
// 1x1 transparent PNG for signed storage images (field media, profile photos).
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

export async function blockExternal(target) {
  await target.route((url) => !LOCAL.test(url.href), (route) => {
    const url = route.request().url();
    if (/\/storage\/v1\/object\//.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    if (/\/rest\/v1\/rpc\//.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    if (/\/rest\/v1\//.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return target;
}

/** Wraps a Playwright browser so every new context and page starts with blockExternal. */
export function hermetic(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => blockExternal(await newContext(options));
  browser.newPage = async (options) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('close', () => context.close().catch(() => {}));
    return page;
  };
  return browser;
}
