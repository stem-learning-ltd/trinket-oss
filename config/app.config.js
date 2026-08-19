var config       = require('config'),
    constants    = require('./constants'),
    // Load routes BEFORE db because mongoose-schema-extend conflicts with Joi 17
    routes       = require('./routes'),
    api_routes   = require('./api_routes'),
    routeParser  = require('../lib/util/routeParser'),
    assetVersion = require('../lib/util/assetVersion'),
    db           = require('./db'),
    redis        = require('./redis'),
    node_env     = process.env.NODE_ENV || 'development';

config.isDev  = node_env === 'development';
config.isProd = node_env === 'production';
config.isTest = node_env === 'test';

// client-facing url
config.url = config.app.url.protocol + '://' + config.app.url.hostname;
if (config.app.url.port) config.url += ':' + config.app.url.port;

// viewing certain snapshots from browser
config.sandboxUrl = config.sandbox.url.protocol + '://' + config.sandbox.url.serverSubdomain + config.sandbox.url.domain;
if (config.sandbox.url.port) config.sandboxUrl += ':' + config.sandbox.url.port;

// ENG-2239: give every unset static-asset prefix a deploy-stable value.
// With the prefixes empty, stringUtils.addPrefix (and its browser mirror in
// public/js/trinket-config.js, which gets these prefixes via trinket.config)
// stamped Date.now() per request into every asset URL — unique URLs on every
// page load, so neither browsers nor Cloudflare could ever cache the frontend.
// The cache-prefix-<version> form is served by routeParser's existing
// cache-prefix-{timestamp} wildcard route, which also keeps URLs minted by a
// previous deploy working while a rollout is in flight. Must run before
// routeParser.parse() below, which registers a static route per prefix.
Object.keys(config.app.prefixes || {}).forEach(function(type) {
  if (!config.app.prefixes[type]) {
    config.app.prefixes[type] = config.app.cachePrefix + assetVersion;
  }
});

config.routes = routeParser.parse(api_routes.concat(routes));

module.exports = config;
