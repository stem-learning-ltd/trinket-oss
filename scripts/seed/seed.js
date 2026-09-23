#!/usr/bin/env node
/**
 * Seed the LOCAL database with test accounts and one trinket per execution
 * path, then print the URLs to open for manual testing.
 *
 * Usage: docker compose exec app npm run seed
 *
 * Safe to re-run: users are matched by username and trinkets by shortCode and
 * updated in place, so the printed URLs never change. To start from an empty
 * database: docker compose down -v, then up again and re-seed.
 *
 * Refuses to run unless both the database and the app URL are local. The
 * accounts get a new random password on every run, printed at the end.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var mongoose = require('mongoose');
var _ = require('underscore');
var config = require('config');

var manifest = require('./manifest');

var LOCAL_DB_HOSTS = ['mongodb', 'localhost', '127.0.0.1'];
var LOCAL_APP_HOSTS = ['localhost', '127.0.0.1'];
// Fresh on every run and printed at the end, never stored in the repo: the
// repo is public, so a fixed password would be a known admin login on any
// instance where someone ran the seed.
var PASSWORD = crypto.randomBytes(12).toString('base64url');
var USERS = [
  { username: 'seedadmin',   fullname: 'Seed Admin',   email: 'seedadmin@example.com',   admin: true },
  { username: 'seedstudent', fullname: 'Seed Student', email: 'seedstudent@example.com', admin: false },
];
var MAIN_FILE = { html: 'index.html' }; // everything else is main.py

// --- refuse anything that isn't a local dev setup --------------------------
// The database check alone isn't enough: a stock self-hosted install
// (docker-compose.yml) also uses the "mongodb" host and no NODE_ENV. Its
// public URL is what tells it apart from a laptop.

var mongo = config.db.mongo;
var appHost = config.app.url.hostname;
if (process.env.NODE_ENV === 'production' || mongo.uri ||
    LOCAL_DB_HOSTS.indexOf(mongo.host) < 0 || LOCAL_APP_HOSTS.indexOf(appHost) < 0) {
  console.error('Refusing to seed: this only runs on a local dev setup.');
  console.error('  NODE_ENV=' + (process.env.NODE_ENV || '') + ', db.mongo.host=' + mongo.host +
                (mongo.uri ? ', db.mongo.uri is set' : '') + ', app.url.hostname=' + appHost);
  process.exit(1);
}

require('../../config/db');
var User = require('../../lib/models/user');
var Roles = require('../../lib/models/roles');
var Trinket = require('../../lib/models/trinket');

var baseUrl = config.app.url.protocol + '://' + config.app.url.hostname +
              (config.app.url.port ? ':' + config.app.url.port : '');

// --- users -----------------------------------------------------------------

async function seedUser(spec) {
  var user = await User.findById(spec.username);
  if (!user) {
    user = User({ username: spec.username });
  }
  user.fullname = spec.fullname;
  user.email = spec.email;
  user.password = PASSWORD; // hashed by the model's pre-save hook
  user.verified = true;
  await user.save(); // first save also gives a new user the default 'user' role

  if (spec.admin && !user.hasRole('admin')) {
    // Same role shape as scripts/make-admin.js.
    var permissions = await Roles.getPermissions('admin');
    var site = _.find(user.roles, function(r) { return r.context === 'site'; });
    if (site) {
      site.roles.push('admin');
      site.permissions = _.union(site.permissions || [], permissions || []);
    } else {
      user.roles.push({ context: 'site', roles: ['admin'], permissions: permissions || [], thru: {}, limits: {} });
    }
    user.markModified('roles');
    await user.save();
  }
  return user;
}

// --- trinkets --------------------------------------------------------------

function readFiles(entry) {
  var dir = path.join(__dirname, 'trinkets', entry.shortCode);
  var main = MAIN_FILE[entry.lang] || 'main.py';
  var names = fs.readdirSync(dir).filter(function(n) {
    return fs.statSync(path.join(dir, n)).isFile();
  });
  if (names.indexOf(main) < 0) {
    throw new Error(entry.shortCode + ': missing ' + main + ' in ' + dir);
  }
  names = [main].concat(_.without(names, main).sort());
  return names.map(function(name) {
    return { name: name, content: fs.readFileSync(path.join(dir, name), 'utf8') };
  });
}

async function seedTrinket(entry, owner) {
  var files = readFiles(entry);
  var trinket = await Trinket.findById(entry.shortCode);
  if (!trinket) {
    trinket = Trinket({ shortCode: entry.shortCode });
  }
  trinket.lang = entry.lang;
  trinket.name = entry.name;
  trinket.description = entry.check;
  // The editor and the shells both accept a JSON array of {name, content};
  // a single file is stored as plain code, like the app does.
  trinket.code = files.length === 1 ? files[0].content : JSON.stringify(files);
  trinket._owner = owner._id;
  trinket._creator = owner._id;
  trinket.deletedAt = null;
  await trinket.save();
  return trinket;
}

// --- output ----------------------------------------------------------------

var SECTIONS = [
  { title: 'Python 3 (server-side)', langs: ['python3'] },
  { title: 'Pygame (server-side, VNC window)', langs: ['pygame'] },
  { title: 'Browser-side (no server)', langs: ['python', 'html'] },
];

function printUrls() {
  var line = new Array(78).join('=');
  console.log('\n' + line);
  console.log(' Seeded. Log in at ' + baseUrl + '/login with either account.');
  console.log(' The password is new on every run (the previous one no longer works):');
  USERS.forEach(function(u) {
    console.log('   ' + u.email + '  /  ' + PASSWORD + (u.admin ? '   (admin: ' + baseUrl + '/admin)' : ''));
  });
  console.log(' Pages work logged out too. "Full page" is the editor; "Embed" is the');
  console.log(' embeddable view.');

  SECTIONS.forEach(function(section) {
    var entries = manifest.filter(function(e) { return section.langs.indexOf(e.lang) >= 0; });
    if (!entries.length) return;
    console.log('\n ' + section.title);
    console.log(' ' + new Array(section.title.length + 1).join('-'));
    entries.forEach(function(e) {
      console.log('\n  ' + e.name);
      console.log('    Full page : ' + baseUrl + '/' + e.lang + '/' + e.shortCode);
      console.log('    Embed     : ' + baseUrl + '/embed/' + e.lang + '/' + e.shortCode);
      console.log('    Expect    : ' + e.check);
    });
  });

  console.log('\n Blank editors (nothing saved): ' + baseUrl + '/embed/python3  ' +
              baseUrl + '/embed/pygame');
  console.log(' Shell log (abandoned-session and limit tests):');
  console.log('   docker compose -f serverside/docker-compose.yml --profile python3 logs -f python3-shell');
  console.log(line + '\n');
}

// --- main ------------------------------------------------------------------

async function main() {
  var users = [];
  for (var i = 0; i < USERS.length; i++) {
    users.push(await seedUser(USERS[i]));
    console.log('user     ' + USERS[i].username);
  }
  var owner = users[0];
  for (var j = 0; j < manifest.length; j++) {
    await seedTrinket(manifest[j], owner);
    console.log('trinket  ' + manifest[j].shortCode);
  }
  printUrls();
}

function run() {
  main()
    .then(function() { return mongoose.disconnect(); })
    .then(function() { process.exit(0); })
    .catch(function(err) {
      console.error('Seed failed:', err && err.stack || err);
      process.exit(1);
    });
}

mongoose.connection.on('error', function(err) {
  console.error('MongoDB connection error:', err.message);
  console.error('Is the stack running? docker compose up -d');
  process.exit(1);
});

if (mongoose.connection.readyState === 1) {
  run();
} else {
  mongoose.connection.once('open', run);
}
