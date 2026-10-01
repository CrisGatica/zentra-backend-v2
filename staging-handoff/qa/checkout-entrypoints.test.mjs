import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

function functionSource(source, name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/^function |^async function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

export async function verifyCheckoutEntryPoints({ backend, worker, db, catalog, pass }) {
  const base = backend.slice(0, backend.lastIndexOf('/'));
  const entries = {
    clean: base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean',
    lab: base + '/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab',
    audit: base + '/ZENTRA AUDIT/ZENTRA_AUDIT_v1.0.0'
  };
  const baseline = {
    clean: ['2fdce214189042dcce5e5defa94614153d4b6393c0d7a29371db84d525c306f8', '073abf3a04c557015483d935396e1d6de37b0a002ecc0947941e204afb9bfd1a'],
    lab: ['2fdce214189042dcce5e5defa94614153d4b6393c0d7a29371db84d525c306f8', '073abf3a04c557015483d935396e1d6de37b0a002ecc0947941e204afb9bfd1a'],
    audit: ['f978e6d813319c97b25bc4726bad2dd953b1fb00d1cbc7142e27984cbacb2003', '1ed50e714625b9d2d1500718beffdb7408a5f97faa4fe8e7e2440e7f161e863e']
  };
  const sources = {};
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const [name, directory] of Object.entries(entries)) {
    const source = sources[name] = await readFile(directory + '/popup.js', 'utf8');
    assert.equal(digest(source.slice(0, source.indexOf('async function openVerifiedLemonCheckout'))), baseline[name][0]);
    assert.equal(digest(source.slice(source.indexOf('function showSubscriptionMessage'))), baseline[name][1]);
    assert.equal(digest(functionSource(source, 'setupPlanModal')), '826c9a6f3d5520cba0cb529c68041eeabf53b355455d0cca05bdd3b5e71cb9b6');
    pass(name + ': popup code outside checkout functions unchanged by hash');

    const dom = new JSDOM(`<!doctype html><body>
      <button id="subscription-action-btn"></button><span id="subscription-plan-badge">starter</span>
      <div id="plan-modal"><h3 id="plan-modal-title"></h3><p id="plan-modal-subtitle"></p><div id="plan-modal-options"></div></div>
    </body>`, { url: 'https://checkout-fixture.test', runScripts: 'outside-only' });
    const w = dom.window;
    const tabs = [], requests = [], messages = [], listeners = new WeakMap();
    let authenticated = true, failure = null;
    const add = w.HTMLButtonElement.prototype.addEventListener;
    w.HTMLButtonElement.prototype.addEventListener = function (type, listener, options) {
      if (type === 'click') listeners.set(this, listener);
      return add.call(this, type, listener, options);
    };
    w.Response = Response; w.Headers = Headers;
    w.chrome = { runtime: { getManifest: () => ({ name: name === 'audit' ? 'Zentra Audit' : 'Zentra AI' }) },
      tabs: { create: async value => tabs.push(value) } };
    w.supabaseClient = { auth: { getSession: async () => ({ data: { session: authenticated ? { access_token: 'alice' } : null } }) } };
    w.zentraSubscription = { cachedUser: { plan: 'starter', audit_credits_remaining: 1 } };
    w.fetch = async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://zentra-backend-v2.onrender.com');
      assert.equal(url.pathname, '/api/lemon/checkout');
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer alice');
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ['productKey']);
      requests.push(body);
      if (failure) return failure();
      return fetch(worker.url + url.pathname, options);
    };
    w.showSubscriptionMessage = (message, type) => messages.push({ message, type });
    try {
      w.eval(await readFile(directory + '/zentra-api-client.js', 'utf8'));
      const functions = ['getPlanModalCopy', 'closePlanModal', 'getPlanActionConfig', 'openVerifiedLemonCheckout', 'openPlanModal', 'setupSubscriptionBar'];
      if (name !== 'audit') {
        functions.push('getCapacityModalCopy', 'getLocalAgencyCapacityState', 'openCapacityModal');
      }
      w.eval(source.slice(source.indexOf('const ZENTRA_LEMON_URLS'), source.indexOf('const ZENTRA_PROMPT_TONE_LABELS')) +
        functions.map(fn => functionSource(source, fn)).join('\n') + '\nwindow.checkoutFixtureUrls = ZENTRA_LEMON_URLS;');
      const pendingAudit = w.zentraOperations.begin('audit', 'https://fixture.test/', '11111111-1111-4111-8111-111111111111');
      const sourceBefore = JSON.stringify(pendingAudit);
      const optionKeys = name === 'audit' ? ['starter', 'pro', 'agency'] : ['starter', 'starterAnnual', 'pro', 'proAnnual', 'agency', 'agencyAnnual'];
      for (const key of optionKeys) {
        const url = w.checkoutFixtureUrls[key];
        await w.openVerifiedLemonCheckout(url);
        const productKey = requests.at(-1).productKey;
        const expected = name === 'audit' ? { starter: 'auditStarter', pro: 'auditPro', agency: 'auditAgency' }[key] :
          { starter: 'starter_monthly', starterAnnual: 'starter_yearly', pro: 'pro_monthly', proAnnual: 'pro_yearly', agency: 'agency_monthly', agencyAnnual: 'agency_yearly' }[key];
        assert.equal(productKey, expected);
        const mapping = catalog.byKey.get(expected);
        const opened = new URL(tabs.at(-1).url);
        assert.equal(opened.origin + opened.pathname, new URL(mapping.url).origin + new URL(mapping.url).pathname);
        const token = opened.searchParams.get('checkout[custom][zentra_binding]');
        assert.match(token, /^[a-f0-9]{64}$/);
        const row = (await db.query('select * from zentra_lemon_checkouts where token_hash=$1', [digest(token)])).rows[0];
        assert.equal(row.variant_id, mapping.variant); assert.equal(row.product_id, mapping.product);
        assert.equal(row.billing_interval, mapping.interval); assert.equal(row.auth_user_id, 'alice');
        assert.equal(row.family, name === 'audit' ? 'audit' : 'subscription');
      }
      pass(name + ': all actual UI plan/interval links reach correct DB-bound variants and authenticated identity');
      const before = tabs.length, beforeRequests = requests.length;
      for (const url of ['https://foreign.test/checkout/buy/x', w.checkoutFixtureUrls.pro + '?variantId=1683081&userId=bob', 'agency_weekly']) {
        await assert.rejects(w.openVerifiedLemonCheckout(url));
      }
      assert.equal(requests.length, beforeRequests); assert.equal(tabs.length, before);
      authenticated = false;
      const beforeBindings = (await db.query('select count(*) n from zentra_lemon_checkouts')).rows[0].n;
      await assert.rejects(w.openVerifiedLemonCheckout(w.checkoutFixtureUrls.pro));
      assert.equal(requests.length, beforeRequests); assert.equal(tabs.length, before);
      assert.equal((await db.query('select count(*) n from zentra_lemon_checkouts')).rows[0].n, beforeBindings);
      authenticated = true;
      pass(name + ': unknown/manipulated links and missing session create no tab or associated checkout');
      w.openPlanModal('free', ['starter', 'pro', 'agency']);
      const pro = w.document.querySelectorAll('[data-plan-url]')[name === 'audit' ? 1 : 2];
      await listeners.get(pro).call(pro, new w.MouseEvent('click'));
      assert.equal(pro.disabled, false); assert.equal(w.document.getElementById('plan-modal').style.display, 'none');
      assert.equal(requests.at(-1).productKey, name === 'audit' ? 'auditPro' : 'pro_monthly');
      assert.equal(JSON.stringify(pendingAudit), sourceBefore);
      pass(name + ': real plan button uses secure helper; running Audit object unchanged');
      const tabCount = tabs.length;
      w.openPlanModal('free', ['pro']);
      const retryButton = w.document.querySelector('[data-plan-url]');
      failure = () => new Response(JSON.stringify({ error: 'fixture unavailable' }), { status: 503 });
      await listeners.get(retryButton).call(retryButton, new w.MouseEvent('click'));
      assert.equal(tabs.length, tabCount); assert.equal(retryButton.disabled, false);
      assert.equal(w.document.getElementById('plan-modal').style.display, 'flex');
      assert.equal(messages.at(-1).type, 'error');
      failure = () => new Response(JSON.stringify({ success: true, url: 'https://foreign.test/checkout/buy/x' }));
      await assert.rejects(w.openVerifiedLemonCheckout(w.checkoutFixtureUrls.pro));
      assert.equal(tabs.length, tabCount);
      failure = null;
      pass(name + ': failure preserves selector, reenables button and never opens public/foreign fallback');
      if (name !== 'audit') {
        w.zentraSubscription.cachedUser = { plan: 'free' };
        w.setupSubscriptionBar();
        const button = w.document.getElementById('subscription-action-btn');
        const tabsBefore = tabs.length;
        await listeners.get(button).call(button, new w.MouseEvent('click'));
        assert.equal(tabs.length, tabsBefore);
        assert.equal(w.document.querySelectorAll('[data-plan-url]').length, 6);
        assert.equal(w.document.getElementById('plan-modal').style.display, 'flex');
        const selected = w.document.querySelector('[data-plan-url]');
        await listeners.get(selected).call(selected, new w.MouseEvent('click'));
        assert.equal(requests.at(-1).productKey, 'starter_monthly');
        pass(name + ': Free upgrade CTA opens existing secure selector rather than public website checkout');
      }
      if (name === 'audit') {
        w.zentraSubscription.cachedUser = { plan: 'agency', audit_credits_remaining: 1 };
        w.setupSubscriptionBar();
        const button = w.document.getElementById('subscription-action-btn');
        await listeners.get(button).call(button, new w.MouseEvent('click'));
        assert.equal(requests.at(-1).productKey, 'auditAgency');
        assert.equal(button.disabled, false); assert.equal(JSON.stringify(pendingAudit), sourceBefore);
        pass('Audit: Agency/manage duplicate entry also obtains bound one-time checkout');
      }
    } finally { dom.window.close(); }
  }
  assert.equal(functionSource(sources.clean, 'openVerifiedLemonCheckout'), functionSource(sources.lab, 'openVerifiedLemonCheckout'));
  const transport = source => functionSource(source, 'openVerifiedLemonCheckout').slice(functionSource(source, 'openVerifiedLemonCheckout').indexOf('  if (!productKey'));
  assert.equal(transport(sources.audit), transport(sources.clean));
  pass('Chrome clean/Lab helper identical; Audit reuses identical secure transport with one-time SKU aliases only');
}

export async function verifyCapacityCheckoutEntries({ backend, worker, db, catalog, pass }) {
  const base = backend.slice(0, backend.lastIndexOf('/'));
  for (const [name, directory] of [['clean', base + '/publicacion/chrome-store/zentra-ai-chrome-store-clean'],
    ['lab', base + '/ZENTRA IA/ZENTRA_AI_v1.0.1_env_phase1_lab']]) {
    const source = await readFile(directory + '/popup.js', 'utf8');
    const dom = new JSDOM('<body><div id="plan-modal"><h3 id="plan-modal-title"></h3><p id="plan-modal-subtitle"></p><div id="plan-modal-options"></div></div></body>',
      { url: 'https://checkout-fixture.test', runScripts: 'outside-only' });
    const w = dom.window, listeners = new WeakMap(), tabs = [], requests = [], errors = [];
    const add = w.HTMLButtonElement.prototype.addEventListener;
    w.HTMLButtonElement.prototype.addEventListener = function (type, listener, options) {
      if (type === 'click') listeners.set(this, listener);
      return add.call(this, type, listener, options);
    };
    w.Response = Response; w.Headers = Headers;
    w.chrome = { tabs: { create: async value => tabs.push(value) } };
    w.supabaseClient = { auth: { getSession: async () => ({ data: { session: { access_token: 'alice' } } }) } };
    w.fetch = async (_input, options) => {
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['productKey']); requests.push(body);
      return fetch(worker.url + '/api/lemon/checkout', options);
    };
    w.showSubscriptionMessage = message => errors.push(message);
    try {
      w.eval(await readFile(directory + '/zentra-api-client.js', 'utf8'));
      w.eval(source.slice(source.indexOf('const ZENTRA_LEMON_URLS'), source.indexOf('const ZENTRA_PLAN_OPTIONS')) +
        ['getCapacityModalCopy', 'closePlanModal', 'openVerifiedLemonCheckout', 'openCapacityModal'].map(fn => functionSource(source, fn)).join('\n') +
        '\nwindow.checkoutFixtureOffers = ZENTRA_AGENCY_CAPACITY_OFFERS;');
      w.openCapacityModal({ offers: w.checkoutFixtureOffers });
      for (const button of w.document.querySelectorAll('[data-capacity-url]')) {
        await listeners.get(button).call(button, new w.MouseEvent('click'));
        const mapping = catalog.byKey.get(requests.at(-1).productKey);
        assert.equal(mapping.family, 'extra');
        const token = new URL(tabs.at(-1).url).searchParams.get('checkout[custom][zentra_binding]');
        const row = (await db.query('select * from zentra_lemon_checkouts where token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0];
        assert.equal(row.variant_id, mapping.variant); assert.equal(row.auth_user_id, 'alice'); assert.equal(row.family, 'extra');
        assert.equal(button.disabled, false);
      }
      assert.deepEqual(requests.map(r => r.productKey), ['growth', 'scale', 'unlimited']);
      assert.equal(tabs.length, 3); assert.equal(errors.length, 0);
      const changed = w.document.querySelector('[data-capacity-url]');
      changed.setAttribute('data-capacity-url', changed.getAttribute('data-capacity-url') + '?variantId=1&userId=bob');
      await listeners.get(changed).call(changed, new w.MouseEvent('click'));
      assert.equal(tabs.length, 3); assert.equal(requests.length, 3); assert.equal(errors.length, 1);
      pass(name + ': all actual capacity CTA buttons obtain verified extra SKUs; tampered link cannot open or change identity');
    } finally { dom.window.close(); }
  }
}
