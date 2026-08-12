# Lock down public registration + self-service UI

**Date:** 2026-08-12
**Linear:** [ENG-2081](https://linear.app/stem-learning/issue/ENG-2081/remove-ui-elements-which-reference-being-able-to-create-an-account) (UI removal) + the "actual functionality" follow-up it defers
**Related:** ENG-2082 (index.html landing-page text — out of scope here)
**Status:** Approved design — pending implementation plan

## Problem

`ide.stem.org.uk` runs an instance of Trinket for STEM Learning's own provisioned
users. Because it looks like public Trinket and is now being linked from courses,
members of the general public are self-registering: the ENG-2081 comments record
3 new public accounts on 29 Jul 2026 and 4 more on 30 Jul 2026.

Accounts should only be created by STEM Learning staff, via the existing admin
bulk upload at `/admin/upload`. We need to (a) stop the public from creating
accounts at all, and (b) remove the UI that invites them to create accounts,
sign in to save, or remix/create their own trinkets.

## Goals

- The general public cannot create an account by any route (form, API, or OAuth).
- No UI element invites account creation or saving/remixing content once the
  instance is locked down.
- Existing (staff-provisioned) users can still log in and use the platform.
- Staff can still provision accounts via the existing admin CSV upload.
- The open-source default is unchanged: a vanilla checkout still has open
  self-service signup.

## Non-goals

- Removing the *underlying* remix/save functionality (endpoints/models). ENG-2081
  scopes this to UI only; only the registration functionality is gated server-side
  here. Deeper removal of remix functionality can be a later ticket.
- Index/landing-page copy and buttons — tracked separately in ENG-2082.
- Any change to how staff provision accounts (the CSV upload is accepted as-is).

## Design

### The switch: one feature flag

Add a single flag following the existing `features.*` idiom
(`config/default.yaml` → `lib/util/features.js` helper → `fly/config/app/production.yaml`
override, deep-merged when `NODE_ENV=production`).

- **`config/default.yaml`**: add `features.selfService: true` (open-source default —
  keeps public signup open for vanilla checkouts).
- **`lib/util/features.js`**: add `isSelfServiceEnabled()` returning `true` when
  `config.features.selfService` is undefined (safe default, mirroring
  `isCoursesEnabled()`), else the boolean. Export it.
- **`fly/config/app/production.yaml`**: add `features.selfService: false` under the
  existing `features:` block. This is the switch that locks down `ide.stem.org.uk`.

Semantics of the flag: *"the public may create accounts and save/remix content on
this instance."* When `false`, all the entry points and UI below are closed.

> Flag name is provisional — `selfService` was chosen because it also covers the
> remix/save surface, not just signup. Alternatives: `publicSignup`, `openAccess`.

### Part A — Functionality gate (server-side)

Enforced in controllers so the API cannot be hit directly to bypass the UI. All
guards are `if (!features.isSelfServiceEnabled()) { ... }`.

| Entry point | File | Behaviour when locked down |
|---|---|---|
| `pages.signup` | `lib/controllers/pages.js:25` | `reply.redirect('/login')` at the top of the handler |
| `users.create` (`POST /api/users`) | `lib/controllers/users.js:28` | Return `403 Forbidden` immediately, before reCAPTCHA / DB work — no account created |
| `auth.google` + `auth.googleCallback` | `lib/controllers/auth.js` | Blocked entirely: redirect to `/login` with a flash message. (Google is dormant today — no credentials in production — but the account-creating code path exists and must not silently re-open signup if enabled later.) |

Optional belt-and-braces: a `selfServiceEnabled` route `pre`-guard on
`POST /api/users` in `config/api_routes.js`, mirroring the existing
`pre: ['isAdmin(user)']` pattern, so the route is protected in the route table too.

**Deliberately untouched:**

- `admin.uploadUsers` (`POST /admin/upload`, `isAdmin`-gated) — calls `User.save()`
  directly, so staff provisioning is unaffected.
- `users.login` and session auth — existing users keep logging in.

### Part B — UI removal (ENG-2081)

Expose the flag to templates as a nunjucks global (in `lib/util/nunjucks.js`,
mirroring the existing `execToken` global) — e.g. `selfServiceEnabled()` — so
template checks honour the default-true semantics regardless of whether the key is
present in config. Then gate each element with
`{% if selfServiceEnabled() %} … {% endif %}`.

| Element | Location | Action when locked down |
|---|---|---|
| Sign Up nav button (all pages, logged-out) | `lib/views/base.html:186` (`{% block signup %}`) | Hide |
| Sign Up nav button (embed view) | `lib/views/embed/base.html:124` | Hide |
| Remix/Copy affordance — **all users** (save someone else's trinket as a copy) | `lib/views/embed/base.html:183–215` | Hide the remix/copy actions for non-owners. **Preserve the owner's "Save" of their own trinket** (same button renders "Save" when `isOwner`, "Remix" otherwise — gate only the non-owner branch). |
| Share-modal prompt + editor pro-tip ("save a copy with Copy/Remix") | `tips.copyTrinket()` macro, used in `lib/views/includes/shareModals.html:47,139` and `lib/views/includes/pro-tips.html:6` | Remove / reword so it no longer invites remixing |
| "Sign up for an account to save your trinkets" prose | `lib/views/static/help.html:21` | Reword to reflect provisioned accounts |
| Inline embed login/signup form | `lib/views/embed/base.html:393–398` | **Open item** — purpose was save/remix/signup (the "Create Account" link is already commented out at :398). Proposed: hide the inline form when locked down; keep the main `/login` page reachable. |
| about.html marketing copy | `lib/views/static/about.html` | Rewrite in past tense (this deployment is a preserved/archived instance, not an actively-marketed product) |

Out of scope (tracked in ENG-2082): the `index.html` landing-page text and buttons.

Already inert, no action needed: the commented-out "Create Account" links at
`embed/base.html:398`, `asset-browser.html:76`, `embed.js:837`; the `submitSignUp*`
handlers in `includes/recaptcha.html` (only fire from the now-unreachable signup form).

### Error handling / UX

- Signup-form visitors → silently redirected to `/login`.
- Direct `POST /api/users` (bots, old course links) → `403`, no DB hit, no account.
- Google routes → redirect to `/login` with a brief flash
  ("Accounts are provisioned by STEM Learning").

## Testing

- **Unit:** `isSelfServiceEnabled()` returns correct values for `true` / `false` /
  undefined.
- **Integration (flag off):** `GET /signup` → 302 → `/login`; `POST /api/users`
  → 403 and no user created; `GET /auth/google` → redirect to `/login`; rendered
  `base.html` / `embed/base.html` / `login.html` contain no `/signup` link, no
  remix/copy affordance for a non-owner, and no save-to-account prompt.
- **Regression (flag off):** `admin.uploadUsers` still creates users; existing
  user `POST /login` still succeeds; an owner can still Save their own trinket.
- **Default (flag absent/true):** every signup, remix, and prompt path behaves
  exactly as today (open-source default preserved).

## Files touched (estimate)

Config/controllers: `config/default.yaml`, `lib/util/features.js`,
`lib/util/nunjucks.js`, `lib/controllers/pages.js`, `lib/controllers/users.js`,
`lib/controllers/auth.js`, `fly/config/app/production.yaml`
(+ optional `config/api_routes.js` for the `pre`-guard).
Templates: `base.html`, `embed/base.html`, `includes/pro-tips.html`,
`static/help.html`, `static/about.html`.
Plus tests. One coherent, reversible PR on branch
`eng-2081-remove-ui-elements-which-reference-being-able-to-create-an`.

## Open items to settle before / during implementation

1. **Flag name** — `selfService` vs `publicSignup` / `openAccess`.
2. **Inline embed login form** (`embed/base.html:393–398`) — hide it, or keep it so
   provisioned users can log in from within an embed?
3. **about.html wording** — exact past-tense copy.
4. **Share-modal prompt** — confirm `copyTrinket()` is the only prompt string in the
   share modal (rest of `shareModals.html` looks purely functional: link/embed copy).
