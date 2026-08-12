# Lock Down Public Registration + Self-Service UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the general public from creating accounts on `ide.stem.org.uk` and remove the UI that invites signup/remix, while leaving the OSS default (open signup) and staff provisioning untouched.

**Architecture:** One config-driven feature flag, `features.selfService` (default `true`). A helper `features.isSelfServiceEnabled()` gates three server-side signup entry points (`users.create`, `pages.signup`, Google OAuth); a matching nunjucks global `selfServiceEnabled()` gates the signup/remix/prompt UI in templates. Production sets the flag `false`. Existing-user login and the admin CSV upload are never touched.

**Tech Stack:** Node.js, Hapi 20, Mongoose, nunjucks templates, `config` (node-config), Mocha + Chai + supertest (`test/helpers/flow.js`).

**Spec:** `docs/superpowers/specs/2026-08-12-lock-down-public-registration-design.md`
**Branch:** `eng-2081-remove-ui-elements-which-reference-being-able-to-create-an` (already checked out)

**Working directory:** all paths are relative to the repo root `trinket-oss/`. Run all commands from there.

---

## Background the implementer needs

- **Two routes hit the same handler.** `POST /users` (HTML form, `config/routes.js:70`) and `POST /api/users` (JSON API, `config/api_routes.js:1114`) both map to `users.create`. Gating `users.create` closes both.
- **Config is mutable at runtime here.** `app.js:43` does `config.viewEngine = viewEngine`, so tests may assign `config.features.selfService = false` and restore it.
- **Models are globals.** `app.js:341` lists `User`, `Course`, etc. in the gleak ignore list — reference `User` bare in tests (as `test/lib/api/registration.js` already does).
- **Test bootstrap.** `npm test` runs `mocha` (`--recursive --check-leaks`, see `test/mocha.opts`). API tests are orchestrated by `test/lib/api/index.js`, which runs each suite as an exported function; `registration` runs first. Unit tests under `test/lib/util/*.js` use top-level `describe(...)` and run standalone.
- **Existing feature-flag idiom.** `config/default.yaml` has a `features:` block; `lib/util/features.js` exposes `isCoursesEnabled()`-style helpers with a default-true-when-unset rule; `fly/config/app/production.yaml` overrides features for production (deep-merged when `NODE_ENV=production`).
- **Routing caveat (Tasks 7–8):** there is **no** `GET /about` or `GET /help` route in `config/routes.js`. `about.html` / `help.html` are edited here per ENG-2081, but confirm how they are served on the deployed instance during verification (Task 10). The edits are still required.

---

## File Structure

**Config**
- `config/default.yaml` — add `features.selfService: true` (OSS default).
- `fly/config/app/production.yaml` — add `features.selfService: false` and `app.embed.enableLogin: false` (production lock-down).

**Server logic**
- `lib/util/features.js` — add `isSelfServiceEnabled()`.
- `lib/util/nunjucks.js` — add `selfServiceEnabled()` nunjucks global.
- `lib/controllers/users.js` — 403 in `create` when disabled.
- `lib/controllers/pages.js` — redirect `/login` from `signup` when disabled.
- `lib/controllers/auth.js` — block `google` / `googleCallback` when disabled.

**Templates**
- `lib/views/base.html` — gate nav Sign Up link.
- `lib/views/embed/base.html` — gate embed nav Sign Up link + non-owner remix/copy buttons.
- `lib/views/includes/pro-tips.html` — gate `copyTrinket()` pro-tip.
- `lib/views/static/help.html` — reword "sign up to save" prose (gated).
- `lib/views/static/about.html` — rewrite in past tense.

**Tests**
- `test/lib/util/features.js` — new unit test for `isSelfServiceEnabled()`.
- `test/lib/api/registration.js` — extend with disabled-state integration tests + enabled-state link assertion.

---

## Task 1: Feature flag + helper

**Files:**
- Modify: `config/default.yaml` (features block, lines 1-3)
- Modify: `lib/util/features.js`
- Test: `test/lib/util/features.js` (create)

- [ ] **Step 1: Write the failing unit test**

Create `test/lib/util/features.js`:

```js
var should   = require('chai').should(),
    config   = require('config'),
    features = require('../../../lib/util/features');

describe('Feature flags: self-service', function() {
  var original;

  beforeEach(function() {
    original = config.features.selfService;
  });

  afterEach(function() {
    config.features.selfService = original;
  });

  it('returns true when the flag is enabled', function() {
    config.features.selfService = true;
    features.isSelfServiceEnabled().should.equal(true);
  });

  it('returns false when the flag is disabled', function() {
    config.features.selfService = false;
    features.isSelfServiceEnabled().should.equal(false);
  });

  it('defaults to true when the flag is unset', function() {
    delete config.features.selfService;
    features.isSelfServiceEnabled().should.equal(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/lib/util/features.js`
Expected: FAIL — `features.isSelfServiceEnabled is not a function`.

- [ ] **Step 3: Add the flag to `config/default.yaml`**

Change the top of the `features:` block from:

```yaml
features:
  courses: true   # Enable/disable courses feature entirely
```

to:

```yaml
features:
  courses: true   # Enable/disable courses feature entirely
  selfService: true  # Public may self-register and save/remix content (set false to lock down)
```

- [ ] **Step 4: Add the helper to `lib/util/features.js`**

After the `isCoursesEnabled` function, add:

```js
/**
 * Check if public self-service (signup + save/remix) is enabled
 * @returns {boolean} - True if enabled, false if disabled
 */
function isSelfServiceEnabled() {
  // Default to true if not specified
  if (!config.features || typeof config.features.selfService === 'undefined') {
    return true;
  }
  return config.features.selfService === true;
}
```

Then add it to `module.exports` (which currently starts with `isCoursesEnabled: isCoursesEnabled,`):

```js
module.exports = {
  isCoursesEnabled: isCoursesEnabled,
  isSelfServiceEnabled: isSelfServiceEnabled,
  isTrinketTypeEnabled: isTrinketTypeEnabled,
  getEnabledTrinketTypes: getEnabledTrinketTypes,
  getDisabledTrinketTypes: getDisabledTrinketTypes,
  isKnownTrinketType: isKnownTrinketType
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx mocha test/lib/util/features.js`
Expected: PASS (3 passing).

- [ ] **Step 6: Commit**

```bash
git add config/default.yaml lib/util/features.js test/lib/util/features.js
git commit -m "feat: add features.selfService flag and isSelfServiceEnabled() helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Server-side gate for signup (form + API)

**Files:**
- Modify: `lib/controllers/users.js` (require block ~line 25; `create` handler line 28)
- Modify: `lib/controllers/pages.js` (require block ~line 7; `signup` handler line 25)
- Test: `test/lib/api/registration.js` (append new describe)

- [ ] **Step 1: Write the failing integration tests**

At the end of `test/lib/api/registration.js`, **inside** the `module.exports = function() { describe('User Registration', function() { ... }) }` — i.e. as a new sibling `describe` just before the final closing `});` of `describe('User Registration' ...)` — add:

```js
    describe('When self-service is disabled', function() {
      var config = require('config');

      before(function() {
        config.features.selfService = false;
        flow.switchUser('');
      });

      after(function() {
        config.features.selfService = true;
      });

      it('should 403 the create endpoint and create no account', function(done) {
        flow.post('/api/users')
          .send(defaults.extend({ email: 'lockout@example.com', password: 'sekret1' }, 'recaptcha'))
          .end(function(err, res) {
            res.statusCode.should.eql(403);
            User.findByLogin('lockout@example.com', function(err, doc) {
              should.not.exist(doc);
              done();
            });
          });
      });

      it('should redirect GET /signup to /login', function(done) {
        flow.get('/signup').end(function(err, res) {
          res.statusCode.should.eql(302);
          url.parse(res.headers.location).pathname.should.eql('/login');
          done();
        });
      });
    });
```

(`config`, `url`, `should`, `defaults`, `flow` are all already required at the top of this file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx mocha --recursive test/lib/api/index.js`
Expected: the two new tests FAIL — create returns 200 (not 403) and `/signup` returns 200 (not 302).

- [ ] **Step 3: Guard `users.create`**

In `lib/controllers/users.js`, add `features` to the require block (after the `recaptcha` require at line 25 — change the trailing `;` to `,` and append):

```js
    recaptcha    = require('../util/recaptcha'),
    features     = require('../util/features');
```

Then make the guard the **first statement** in `create` (before the reCAPTCHA call at line 29):

```js
  create : async function(request, reply) {
    if (!features.isSelfServiceEnabled()) {
      throw errors.forbidden('Account registration is disabled on this instance.');
    }

    var recaptcha_result = await new Promise(function(resolve) {
```

(`errors` = `@hapi/boom` is already required at line 2. Throwing `errors.forbidden()` yields a 403 JSON response for `/api/users`; for the HTML `/users` form route, `app.js`'s onPreResponse renders `50x.html` with code 403.)

- [ ] **Step 4: Guard `pages.signup`**

In `lib/controllers/pages.js`, add `features` to the require block (after the `recaptcha` require at line 7):

```js
    recaptcha  = require('../util/recaptcha'),
    features   = require('../util/features');
```

Then make the guard the **first statement** in `signup` (line 25):

```js
  signup: function(request, reply) {
    if (!features.isSelfServiceEnabled()) {
      return reply.redirect('/login');
    }
    if (request.auth.isAuthenticated) {
      return reply.redirect('/welcome');
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx mocha --recursive test/lib/api/index.js`
Expected: PASS — including the two new tests and all pre-existing registration tests (which run while the flag is still `true`).

- [ ] **Step 6: Commit**

```bash
git add lib/controllers/users.js lib/controllers/pages.js test/lib/api/registration.js
git commit -m "feat: block signup form + API when self-service disabled (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Block Google OAuth when disabled

**Files:**
- Modify: `lib/controllers/auth.js` (require block ~line 6; `google` and `googleCallback` handlers)

> **Verification note:** Google OAuth is dormant in production (no `clientID` configured), so an automated test cannot meaningfully exercise this path without real credentials. This task is a defensive guard so that enabling Google later cannot silently re-open self-registration. Verify by code review + the manual step below.

- [ ] **Step 1: Add `features` to the require block**

In `lib/controllers/auth.js`, after the `userUtil` require (line 6):

```js
    userUtil      = require('../util/user'),
    features      = require('../util/features');
```

- [ ] **Step 2: Guard `google`**

Make the guard the first statement in `google : function(request, h) {`:

```js
  google : function(request, h) {
    if (!features.isSelfServiceEnabled()) {
      return request.success({ redirectTo: '/login' });
    }
    if (!config.app.auth || !config.app.auth.google || !config.app.auth.google.clientID) {
```

- [ ] **Step 3: Guard `googleCallback`**

Make the guard the first statement in `googleCallback : function(request, h) {`:

```js
  googleCallback : function(request, h) {
    if (!features.isSelfServiceEnabled()) {
      return h.redirect('/login');
    }
    if (!config.app.auth || !config.app.auth.google || !config.app.auth.google.clientID) {
```

- [ ] **Step 4: Manual verification**

With `config.features.selfService: false` set locally, confirm by reading the two handlers that neither reaches the Google token-exchange / user-creation code — both return before it. (No account can be created via OAuth.)

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/auth.js
git commit -m "feat: block Google OAuth when self-service disabled (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Expose the flag to templates

**Files:**
- Modify: `lib/util/nunjucks.js` (require block ~line 14; global registration ~line 26)

- [ ] **Step 1: Add `features` to the require block**

In `lib/util/nunjucks.js`, add to the require list (near the `constants` require at line 14):

```js
    features    = require('./features'),
```

- [ ] **Step 2: Register the nunjucks global**

Immediately after the existing `env.addGlobal('execToken', ...)` block (ends ~line 34), add:

```js
// Mirrors features.isSelfServiceEnabled() for use in templates:
// {% if selfServiceEnabled() %} ... {% endif %}
env.addGlobal('selfServiceEnabled', function() {
  return features.isSelfServiceEnabled();
});
```

- [ ] **Step 3: Verify it loads**

Run: `node -e "require('./lib/util/nunjucks'); console.log('nunjucks loaded ok')"`
Expected: prints `nunjucks loaded ok` with no require/circular errors.

(Behavioural verification of the global happens in Task 5's rendered-page test.)

- [ ] **Step 4: Commit**

```bash
git add lib/util/nunjucks.js
git commit -m "feat: add selfServiceEnabled() nunjucks global

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Hide Sign Up links in navigation

**Files:**
- Modify: `lib/views/base.html:186-188`
- Modify: `lib/views/embed/base.html:124`
- Test: `test/lib/api/registration.js` (add one enabled-state + one disabled-state assertion)

- [ ] **Step 1: Write the failing tests**

Add an **enabled-state** assertion as a new `it` inside the existing top-level `describe('User Registration', ...)` (flag is `true` by default here):

```js
    it('should show a Sign Up link on the login page when self-service is enabled', function(done) {
      flow.get('/login').end(function(err, res) {
        res.text.should.contain('href="/signup"');
        done();
      });
    });
```

Add a **disabled-state** assertion inside the `describe('When self-service is disabled', ...)` block from Task 2:

```js
      it('should not render any Sign Up link on the login page', function(done) {
        flow.get('/login').end(function(err, res) {
          res.text.should.not.contain('href="/signup"');
          done();
        });
      });
```

- [ ] **Step 2: Run to verify the disabled-state test fails**

Run: `npx mocha --recursive test/lib/api/index.js`
Expected: the "should not render any Sign Up link" test FAILS (link still present); the enabled-state test passes.

- [ ] **Step 3: Gate the main nav link (`lib/views/base.html`)**

Replace lines 186-188:

```html
              {% block signup %}
              <li><a href="/signup{% block nextAfterSignUp %}{% endblock %}">Sign Up</a></li>
              {% endblock %}
```

with:

```html
              {% if selfServiceEnabled() %}
              {% block signup %}
              <li><a href="/signup{% block nextAfterSignUp %}{% endblock %}">Sign Up</a></li>
              {% endblock %}
              {% endif %}
```

(Leave the adjacent `Log In` link untouched.)

- [ ] **Step 4: Gate the embed nav link (`lib/views/embed/base.html:124`)**

Replace:

```html
            <li><a href="//{{config.app.url.hostname}}/signup" target="_blank">Sign Up</a></li>
```

with:

```html
            {% if selfServiceEnabled() %}<li><a href="//{{config.app.url.hostname}}/signup" target="_blank">Sign Up</a></li>{% endif %}
```

- [ ] **Step 5: Run to verify both tests pass**

Run: `npx mocha --recursive test/lib/api/index.js`
Expected: PASS (both new assertions green).

- [ ] **Step 6: Commit**

```bash
git add lib/views/base.html lib/views/embed/base.html test/lib/api/registration.js
git commit -m "feat: hide Sign Up nav links when self-service disabled (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Hide non-owner Remix/Copy in the embed toolbar

**Files:**
- Modify: `lib/views/embed/base.html:184-203` (three button variants inside the `{% if copyingEnabled %}` block)

> **Why no automated test:** these buttons only render given a specific combination of `copyingEnabled`, `user`, `isOwner`, and `trinket.id` context supplied by `trinket.js` at embed render time. Building a faithful embed-render fixture risks testing the fixture, not the change. This task is verified manually against a running instance (Task 10). Do **not** silently skip verification — complete the manual checklist.

Goal: when locked down, remove affordances that save **someone else's** trinket (guest remix/copy, "Copy", non-owner "Remix"), but keep an **owner's** ability to Save their own trinket.

- [ ] **Step 1: Gate the guest remix/copy button**

Replace lines 183-189:

```html
            <!-- no user, remix if trinket.id, copy if inline -->
            <a title="{{ 'Remix this trinket.' if trinket.id else 'Save a copy of this trinket.' }}"
               class="save-it menu-button allow-original ui-option guest-option has-tip item right-off-canvas-toggle {% if user %} hide{% endif %}"
               data-action="menu.user">
              <i class="fa fa-save"></i>
              <label class="show-for-medium-up">{{ 'Remix' if trinket.id else 'Copy' }}</label>
            </a>
```

with (wrap in `{% if selfServiceEnabled() %}`):

```html
            <!-- no user, remix if trinket.id, copy if inline -->
            {% if selfServiceEnabled() %}
            <a title="{{ 'Remix this trinket.' if trinket.id else 'Save a copy of this trinket.' }}"
               class="save-it menu-button allow-original ui-option guest-option has-tip item right-off-canvas-toggle {% if user %} hide{% endif %}"
               data-action="menu.user">
              <i class="fa fa-save"></i>
              <label class="show-for-medium-up">{{ 'Remix' if trinket.id else 'Copy' }}</label>
            </a>
            {% endif %}
```

- [ ] **Step 2: Gate the "Copy" (create-copy) button**

Replace lines 190-197:

```html
            <!-- user, no trinket.id -->
            <a title="Save a copy of this trinket."
               class="save-it create-copy menu-button allow-original ui-option user-option owner-option has-tip item {{ 'disabled' if isOwner }} {% if not user or library %}hide{% endif %}"
               data-action="{{ 'menu.upgrade' if upgradeNeeded else 'library.add' }}">
              <i class="fa fa-save"></i>
              <label class="show-for-medium-up">Copy</label>
            </a>
```

with:

```html
            <!-- user, no trinket.id -->
            {% if selfServiceEnabled() %}
            <a title="Save a copy of this trinket."
               class="save-it create-copy menu-button allow-original ui-option user-option owner-option has-tip item {{ 'disabled' if isOwner }} {% if not user or library %}hide{% endif %}"
               data-action="{{ 'menu.upgrade' if upgradeNeeded else 'library.add' }}">
              <i class="fa fa-save"></i>
              <label class="show-for-medium-up">Copy</label>
            </a>
            {% endif %}
```

- [ ] **Step 3: Gate only the non-owner branch of the create-remix button**

This button is "Save" for an owner and "Remix" for a non-owner. Keep it for owners; hide it for non-owners when locked down. Replace lines 198-203:

```html
            <!-- user, trinket.id -->
            <a title="{{'Save changes.' if isOwner else 'Remix this trinket.'}}"
               class="save-it create-remix menu-button allow-original ui-option user-option owner-option has-tip item {% if isOwner %}disabled blue-highlight{% else %}green-highlight{% endif %} {% if not user or library %}hide{% endif %}"
               data-action="{{ 'menu.upgrade' if upgradeNeeded else ('code.save' if isOwner else 'library.add') }}">
              <i class="fa {{'fa-save' if isOwner else 'fa-code-fork'}}"></i>
              <label class="show-for-medium-up">{{'Save' if isOwner else 'Remix'}}</label>
            </a>
```

with (wrap in `{% if isOwner or selfServiceEnabled() %}`):

```html
            <!-- user, trinket.id (owner Save kept; non-owner Remix hidden when locked down) -->
            {% if isOwner or selfServiceEnabled() %}
            <a title="{{'Save changes.' if isOwner else 'Remix this trinket.'}}"
               class="save-it create-remix menu-button allow-original ui-option user-option owner-option has-tip item {% if isOwner %}disabled blue-highlight{% else %}green-highlight{% endif %} {% if not user or library %}hide{% endif %}"
               data-action="{{ 'menu.upgrade' if upgradeNeeded else ('code.save' if isOwner else 'library.add') }}">
              <i class="fa {{'fa-save' if isOwner else 'fa-code-fork'}}"></i>
              <label class="show-for-medium-up">{{'Save' if isOwner else 'Remix'}}</label>
            </a>
            {% endif %}
```

Leave the `save-remix` (Save your own remix) and `revert-remix` (Restore) buttons at lines 204-217 unchanged — they manage a user's own remix, not creation from someone else's trinket.

- [ ] **Step 4: Sanity-check the template parses**

Run: `node -e "var n=require('nunjucks'); n.configure('lib/views',{autoescape:true}); console.log('embed template dir configured')"`
Expected: prints without a template-syntax error at configure time. (Full render is checked manually in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add lib/views/embed/base.html
git commit -m "feat: hide non-owner Remix/Copy in embed when self-service disabled (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Reword the Share-modal pro-tip and Help prose

**Files:**
- Modify: `lib/views/includes/pro-tips.html` (the `copyTrinket()` macro)
- Modify: `lib/views/static/help.html:20-21`

- [ ] **Step 1: Gate the `copyTrinket()` pro-tip**

The `copyTrinket()` macro is rendered in the Share modal (`shareModals.html:47,139`) and the editor. Replace the macro:

```html
{% macro copyTrinket() %}
{{ tip() }} You can save a copy for yourself with the <i class="fa fa-copy"></i> Copy or <i class="fa fa-save"></i> Remix button.
{% endmacro %}
```

with:

```html
{% macro copyTrinket() %}
{% if selfServiceEnabled() %}
{{ tip() }} You can save a copy for yourself with the <i class="fa fa-copy"></i> Copy or <i class="fa fa-save"></i> Remix button.
{% endif %}
{% endmacro %}
```

(nunjucks globals are available inside macros, so `selfServiceEnabled()` resolves here. When disabled the macro renders empty, removing the Share-modal prompt.)

- [ ] **Step 2: Reword the Help "Saving Your Work" prose**

In `lib/views/static/help.html`, replace line 21:

```html
    <p>Sign up for an account to save your trinkets. Once logged in, your work is automatically saved.</p>
```

with:

```html
    {% if selfServiceEnabled() %}
    <p>Sign up for an account to save your trinkets. Once logged in, your work is automatically saved.</p>
    {% else %}
    <p>Once you are logged in, your work is automatically saved.</p>
    {% endif %}
```

- [ ] **Step 3: Sanity-check templates parse**

Run: `node -e "var n=require('nunjucks'); n.configure('lib/views',{autoescape:true}); var e=n.render('includes/pro-tips.html'); console.log('pro-tips rendered')"`
Expected: prints `pro-tips rendered` (macro file compiles).

- [ ] **Step 4: Manual verification (deferred to Task 10)**

Note the two scenarios to check in Task 10: Share modal on someone else's trinket shows no "Copy or Remix" pro-tip when locked down; the Help page's "Saving Your Work" paragraph no longer invites signup.

- [ ] **Step 5: Commit**

```bash
git add lib/views/includes/pro-tips.html lib/views/static/help.html
git commit -m "feat: gate Share-modal/Help save-a-copy prompts on self-service (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Rewrite the About page in past tense

**Files:**
- Modify: `lib/views/static/about.html`

> **Note:** this is an unconditional content change (not flag-gated) because it is copy for the STEM Learning deployment on the `fly-production` line. There is no `GET /about` route in `config/routes.js`; confirm how `/about` is served on the deployed instance during Task 10.

- [ ] **Step 1: Replace the content block**

Replace lines 16-30 (the `<p class="lead">` through the GitHub button paragraph) with past-tense copy:

```html
    <p class="lead">Trinket was an open source browser-based coding platform that let you write and run code without installing anything.</p>

    <p>Originally created by Elliott Hauser and Brian Marks, Trinket was built to make coding accessible to learners everywhere. This instance was maintained by STEM Learning to support its courses; new public accounts are no longer created here.</p>

    <h3>Features</h3>
    <ul>
      <li>Wrote and ran Python, HTML, and more in the browser</li>
      <li>Created and shared interactive coding projects</li>
      <li>Built courses with embedded code examples</li>
      <li>Required no downloads or installation</li>
    </ul>

    <h3>Open Source</h3>
    <p>Trinket was released under the CC0 1.0 license. You can still run your own instance, contribute to development, or use the code however you like.</p>
    <p><a href="https://github.com/trinketapp/trinket-oss" class="button"><i class="fa fa-github"></i> View on GitHub</a></p>
```

- [ ] **Step 2: Sanity-check the template parses**

Run: `node -e "var n=require('nunjucks'); n.configure('lib/views',{autoescape:true}); console.log('about template dir ok')"`
Expected: prints without error.

- [ ] **Step 3: Commit**

```bash
git add lib/views/static/about.html
git commit -m "feat: rewrite About page in past tense (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Lock down production config

**Files:**
- Modify: `fly/config/app/production.yaml` (features block; app.embed block)

- [ ] **Step 1: Disable self-service in the production features block**

In `fly/config/app/production.yaml`, under the existing `features:` block (which currently has `courses: false`, `assets: true`, `trinkets:` …), add:

```yaml
features:
  courses: false
  selfService: false   # ENG-2081: staff-provisioned accounts only; no public signup/remix
  assets: true
```

(Insert the `selfService: false` line; keep the surrounding keys as they are.)

- [ ] **Step 2: Disable the inline embed login form**

Under the `app:` block, add an `embed.enableLogin: false` override (this hides the inline embed account/login form, whose only purpose was save/remix/signup — resolves spec open item #2). If an `app: embed:` block does not yet exist in this file, add:

```yaml
app:
  embed:
    enableLogin: false
```

If an `app:` block already exists, add the nested `embed: { enableLogin: false }` under it (YAML deep-merges over `config/default.yaml`, which has `app.embed.enableLogin: true`).

- [ ] **Step 3: Verify the production config still parses as YAML**

Run: `node -e "console.log(require('js-yaml').load(require('fs').readFileSync('fly/config/app/production.yaml','utf8')).features.selfService)"`
Expected: prints `false`. (If `js-yaml` is unavailable, use `npx js-yaml fly/config/app/production.yaml | grep selfService`.)

- [ ] **Step 4: Commit**

```bash
git add fly/config/app/production.yaml
git commit -m "chore(fly): lock down production - disable self-service + embed login (ENG-2081)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all suites PASS, including `test/lib/util/features.js` and the new `registration.js` cases. No new gleak/`--check-leaks` failures.

- [ ] **Step 2: Manual verification — locked down**

Run the app locally with self-service disabled (e.g. add `features: { selfService: false }` to `config/local.yaml`, or `NODE_CONFIG='{"features":{"selfService":false}}' npm start`), logged **out**, and confirm:

- [ ] Visiting `/signup` → redirected to `/login`.
- [ ] `POST /api/users` (e.g. `curl -i -X POST localhost:<port>/api/users -d email=x@y.z -d password=abc123`) → `403`.
- [ ] No "Sign Up" link in the top-right nav on any page (check `/login`, `/`).
- [ ] Viewing someone else's trinket embed: **no** Remix/Copy button; the Share modal shows **no** "Copy or Remix" pro-tip.
- [ ] Help page "Saving Your Work" paragraph does not invite sign-up.
- [ ] About page reads in past tense. (Confirm how `/about` and `/help` are served on this deployment — there is no route in `config/routes.js`.)

- [ ] **Step 3: Manual verification — owner still works (locked down)**

Log in as a provisioned user who **owns** a trinket and confirm the embed toolbar still shows **Save** for their own trinket (owner path preserved).

- [ ] **Step 4: Manual verification — OSS default unchanged**

With the flag unset/true (default `config/default.yaml`), confirm signup works end-to-end, the Sign Up links appear, and the Remix/Copy buttons and pro-tip render as before.

- [ ] **Step 5: Final review**

Confirm untouched behaviours still work: existing-user `/login`, and admin CSV provisioning at `/admin/upload` (creates users regardless of the flag). Then hand off for PR.

---

## Self-review notes (author)

- **Spec coverage:** flag+helper (Task 1) ✓; server gate for signup form/API (Task 2) ✓; Google OAuth block (Task 3) ✓; template global (Task 4) ✓; Sign Up nav links (Task 5) ✓; non-owner Remix/Copy with owner-Save preserved (Task 6) ✓; Share-modal prompt + Help prose (Task 7) ✓; about.html past tense (Task 8) ✓; production `selfService:false` + `enableLogin:false` (Task 9) ✓; admin upload & login untouched, verified (Task 10) ✓. Index landing page is out of scope (ENG-2082).
- **Naming consistency:** helper `isSelfServiceEnabled()` (server) and nunjucks global `selfServiceEnabled()` (templates) used consistently in every task.
- **Known caveats surfaced (not silent):** Google guard has no automated test (dormant path); embed remix change is manually verified (fixture risk); `/about` and `/help` have no route in this codebase and must be verified on the deployment.
