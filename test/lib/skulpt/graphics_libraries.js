var expect = require('chai').expect;
var GraphicsLibraries = require('../../../public/js/skulpt/graphics_libraries.js');

describe('GraphicsLibraries.isGraphicsLibrary', function() {
  it('recognises the exclusive graphics libraries', function() {
    expect(GraphicsLibraries.isGraphicsLibrary('turtle')).to.equal(true);
    expect(GraphicsLibraries.isGraphicsLibrary('processing')).to.equal(true);
    expect(GraphicsLibraries.isGraphicsLibrary('matplotlib.pyplot')).to.equal(true);
    expect(GraphicsLibraries.isGraphicsLibrary('image')).to.equal(true);
    expect(GraphicsLibraries.isGraphicsLibrary('sense_hat')).to.equal(true);
  });

  it('does not match non-graphics or partial names', function() {
    expect(GraphicsLibraries.isGraphicsLibrary('time')).to.equal(false);
    expect(GraphicsLibraries.isGraphicsLibrary('sense')).to.equal(false);
    expect(GraphicsLibraries.isGraphicsLibrary('matplotlib')).to.equal(false);
    expect(GraphicsLibraries.isGraphicsLibrary('sense_hat.stick')).to.equal(false);
  });
});

describe('GraphicsLibraries.importDecision', function() {
  it('sets up the first graphics library imported', function() {
    expect(GraphicsLibraries.importDecision(undefined, 'turtle')).to.equal('setup');
    expect(GraphicsLibraries.importDecision(undefined, 'sense_hat')).to.equal('setup');
  });

  it('re-runs setup when the same library is imported again', function() {
    expect(GraphicsLibraries.importDecision('turtle', 'turtle')).to.equal('setup');
    expect(GraphicsLibraries.importDecision('sense_hat', 'sense_hat')).to.equal('setup');
  });

  it('conflicts when a different exclusive library is already in use', function() {
    expect(GraphicsLibraries.importDecision('turtle', 'processing')).to.equal('conflict');
    expect(GraphicsLibraries.importDecision('processing', 'turtle')).to.equal('conflict');
  });

  // Regression (ENG-1887): the Skulpt sense_hat module does `from image import
  // Image` (hat.py), so importing sense_hat triggers an internal `image` import.
  // That must NOT trip the single-graphics-library guard, and must NOT re-run
  // image's display-clearing setup (which would wipe the SenseHat LED matrix).
  it('ignores image imported as an internal dependency of sense_hat', function() {
    expect(GraphicsLibraries.importDecision('sense_hat', 'image')).to.equal('ignore');
  });

  it('still conflicts if image was taken as the primary library before sense_hat', function() {
    expect(GraphicsLibraries.importDecision('image', 'sense_hat')).to.equal('conflict');
  });
});
