var config      = require('config'),
    path        = require('path'),
    _           = require('underscore'),
    lodash      = require('lodash'),
    moment      = require('moment'),
    numeral     = require('numeral'),
    nunjucks    = require('nunjucks'),
    env         = nunjucks.configure(config.app.templates, {watch:config.isDev || config.isTest ? true : false, autoescape: true}),
    StringUtils = require('./stringUtils'),
    cachify     = require('./cachify'),
    translate   = require('./translate'),
    roles       = require('./roles'),
    component   = require('./component'),
    constants   = require('../../config/constants'),
    features    = require('./features'),
    crypto      = require('crypto');

// Short-lived signed token authorising code execution against the exec stack.
// Minted per page render and handed to the browser in trinket.config; the
// python3/pygame managers verify the HMAC + expiry (shared EXEC_TOKEN_SECRET)
// before accepting a run, so the internet can't drive the execution tier
// directly. Fails open (returns '') when the secret is unset, so local/dev and
// a misconfigured rollout degrade to unauthenticated exec rather than blocking
// every run. Anonymous page loads still get a token (public trinkets must run);
// the point is to force execution through an app-served page (rate-limitable,
// behind the WAF), not to require login.
env.addGlobal('execToken', function() {
  var secret = process.env.EXEC_TOKEN_SECRET;
  if (!secret) return '';
  var exp = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24h TTL
  var payload = 'v1.' + exp;
  var sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // base64url
  return payload + '.' + sig;
});

// Mirrors features.isSelfServiceEnabled() for use in templates:
// {% if selfServiceEnabled() %} ... {% endif %}
env.addGlobal('selfServiceEnabled', function() {
  return features.isSelfServiceEnabled();
});

env.addFilter('cachePrefix', function(src, key) {
  return StringUtils.addPrefix(src, config.app.prefixes, key);
});
env.addFilter('json', function(str, opt) {
  if (opt === 'pretty') {
    return JSON.stringify(str, null, 2);
  } else {
    return JSON.stringify(str);
  }
});
env.addFilter('translate', function(str, locale) {
  return translate(str, locale);
});
env.addFilter('userAvatar', function(str) {
  if (!str) {
    return '/img/avatar-default.svg';
  }
  // Already a full URL
  if (/^http/.test(str)) {
    return str;
  }
  // Already a local path
  if (/^\//.test(str)) {
    return str;
  }
  // Relative path - prepend cloud host if configured
  var cloudHost = config.aws.buckets.useravatars.host || '';
  if (cloudHost.length > 0 && !cloudHost.includes('example.com')) {
    return cloudHost + '/' + str;
  }
  // Default to local img path
  return '/img/' + str;
});
env.addFilter('encrypt', function(obj) {
  return roles.encrypt(obj);
});
function escapeJSON(data) {
  if (typeof data === 'undefined' || data === null) {
    return null;
  }

  if (data instanceof Array) {
    for (var i = 0; i < data.length; i++) {
      data[i] = escapeJSON(data[i]);
    }
  }
  else if (typeof data === 'object') {
    for (var i in data) {
      if (data.hasOwnProperty(i)) {
        data[i] = escapeJSON(data[i]);
      }
    }
  }
  else if (typeof data === 'string') {
    // lodash and underscore can produce different results
    // lodash is used on the client-side so we'll use it here too
    data = lodash.escape(data);
  }

  return data;
}
env.addFilter('escapeJSON', function(obj) {
  var e = escapeJSON(obj);
  return e;
});

module.exports = {
  render: function(template, context) {
    if (config.isDev || config.isTest) {
      env.cache = {};
    }
    return new Promise(function(resolve, reject) {
      nunjucks.render(template, context, function(err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  },
  compile: function(src, info) {
    // Vision passes src (template source string) and info.filename (absolute path)
    // Extract template name relative to templates directory for nunjucks.render()
    // We need to convert absolute path to relative path from templates directory
    var templatesDir = path.resolve(config.app.templates);
    var templateName = info.filename.replace(templatesDir, '');
    // Remove leading slash if present
    if (templateName.charAt(0) === '/' || templateName.charAt(0) === '\\') {
      templateName = templateName.substring(1);
    }

    var subdomain = function(instructor, course) {
      if (config.app.usersubdomains) {
        return '/' + course.slug;
      }
      else {
        return ['', 'u', instructor.slug, 'classes', course.slug].join('/');
      }
    };
    var host = function(instructor) {
      var url = config.app.url.protocol + '://';
      if (config.app.usersubdomains && instructor) {
        url += instructor.slug + '.'
      }
      url += config.app.url.hostname;
      return url;
    };

    return function(context) {
      // kill the nunjucks cache when in dev mode
      if (config.isDev || config.isTest) {
        env.cache = {};
      }

      _.extend(context, {
        config     : config,
        moment     : moment,
        numeral    : numeral,
        subdomain  : subdomain,
        host       : host,
        cachify_js : cachify.js,
        translate  : translate,
        component  : component,
        constants  : constants
      });

      // Use nunjucks.render with template name (like old Hapi 4.x approach)
      // This allows duplicate block names in conditionals to work
      try {
        return nunjucks.render(templateName, context);
      } catch (err) {
        console.error('Nunjucks render error for template:', templateName);
        console.error('Error:', err.message);
        console.error('Stack:', err.stack);
        throw err;
      }
    };
  },
  env : env
}
