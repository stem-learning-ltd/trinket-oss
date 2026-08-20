var assetVersion = require('./assetVersion');

module.exports = {
  // string interpolation:
  // e.g. interpolate('my name is {name}', {name:'ben'})
  interpolate : function(string, values) {
    return string.replace(
      /{([^{}]*)}/g,
      function (a, b) {
        var r    = values;
        var path = b.split('.');
        while(path.length && r !== undefined && r !== null) {
          r = r[path.shift()];
        }

        if (r !== undefined && r !== null && r.toString) {
          r = r.toString();
        }

        return typeof r === 'string' || typeof r === 'number' ? r : a;
      }
    );
  },

  addPrefix : function(string, prefixes, key) {
    if (!/^\/\//.test(string)) {
      var path = string.split('/');
      key = key || path[1];
      if (prefixes[ key ]) {
        string = '/' + prefixes[ key ] + string;
      }
      else {
        // Fallback for asset types with no configured prefix. Deploy-stable
        // version, NOT Date.now() per call — per-request stamps made every
        // asset URL unique, defeating all caching (ENG-2239).
        string = '/cache-prefix-' + assetVersion + string;
      }
    }

    return string;
  }
};
