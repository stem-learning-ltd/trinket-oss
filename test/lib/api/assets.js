var should       = require('chai').should(),
    flow         = require('../../helpers/flow'),
    config       = require('config'),
    assetVersion = require('../../../lib/util/assetVersion');

module.exports = function() {
  describe('Static asset caching (ENG-2239)', function() {
    // The deploy-stable prefix every asset URL should carry, e.g.
    // /cache-prefix-1755600000000/js/trinket.js
    var expectedPrefix = '/' + config.app.cachePrefix + assetVersion + '/';

    before(function() { flow.switchUser(''); });

    it('renders asset URLs with the deploy-stable prefix', function(done) {
      flow.get('/').end(function(err, res) {
        res.statusCode.should.eql(200);
        res.text.should.contain(expectedPrefix);
        done();
      });
    });

    it('renders identical asset URLs across requests', function(done) {
      // Empty app.prefixes used to fall back to Date.now() per request,
      // making every asset URL unique and uncacheable.
      flow.get('/').end(function(err, first) {
        flow.get('/').end(function(err, second) {
          var re = /\/cache-prefix-\d+\//g;
          var a = first.text.match(re) || [];
          var b = second.text.match(re) || [];
          a.length.should.be.above(0);
          // every occurrence in both renders is the same single prefix
          [].concat(a, b).forEach(function(prefix) {
            prefix.should.eql(expectedPrefix);
          });
          done();
        });
      });
    });

    it('serves versioned assets with long-lived immutable cache headers', function(done) {
      flow.get(expectedPrefix + 'js/trinket.js').end(function(err, res) {
        res.statusCode.should.eql(200);
        res.headers['cache-control'].should.eql('public, max-age=31536000, immutable');
        done();
      });
    });

    it('still serves asset URLs minted by a previous deploy', function(done) {
      // rollover safety: HTML in flight from the previous image references the
      // old version; the cache-prefix-{timestamp} wildcard route must serve it
      flow.get('/cache-prefix-1234567890/js/trinket.js').end(function(err, res) {
        res.statusCode.should.eql(200);
        // ...but never hard-cached: during a rolling deploy this route serves
        // whatever content THIS machine has for ANY version string, so an
        // immutable header here would let shared caches pin one deploy's
        // content under another deploy's URL for a year
        res.headers['cache-control'].should.contain('no-store');
        res.headers['cache-control'].should.not.contain('immutable');
        done();
      });
    });

    it('serves errors under asset URLs with no-store, not the HTML error page', function(done) {
      // asset URLs are now stable and shared by every user, so a cached error
      // response would be served to everyone — keep errors uncacheable
      flow.get(expectedPrefix + 'js/no-such-file.js').end(function(err, res) {
        res.statusCode.should.eql(404);
        res.headers['cache-control'].should.contain('no-store');
        done();
      });
    });

    describe('when logged in', function() {
      before(function(done) { flow.switchUser('user', done); });
      after(function() { flow.switchUser(''); });

      it('never sets a session cookie on a cacheable asset response', function(done) {
        // the sliding-expiration session touch must skip asset requests:
        // Set-Cookie on a public, immutable response would let a shared cache
        // replay one user's session cookie to other users
        flow.get(expectedPrefix + 'js/trinket.js').end(function(err, res) {
          res.statusCode.should.eql(200);
          res.headers['cache-control'].should.eql('public, max-age=31536000, immutable');
          should.not.exist(res.headers['set-cookie']);
          done();
        });
      });
    });

    it('keeps page responses uncacheable', function(done) {
      flow.get('/').end(function(err, res) {
        res.statusCode.should.eql(200);
        res.headers['cache-control'].should.contain('no-store');
        done();
      });
    });
  });
};
