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
