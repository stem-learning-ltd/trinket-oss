/**
 * Shared knowledge about Skulpt "graphics" libraries for the run wrapper.
 *
 * Skulpt lets a trinket use only one graphics library at a time (they each take
 * over the display). The wrapper enforces this in Sk.onBeforeImport. Most
 * graphics libraries are leaf nodes, but sense_hat's Skulpt module imports the
 * `image` library internally (sense_hat/hat.py: `from image import Image`), so a
 * plain "one library only" rule wrongly rejects sense_hat's own dependency.
 *
 * This module owns the library list and the per-import decision so the rule is
 * unit-testable in isolation from the browser-only wrapper.
 */
;(function(root, factory) {
  var GraphicsLibraries = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GraphicsLibraries;   // Node (tests)
  } else {
    root.SkulptGraphicsLibraries = GraphicsLibraries;   // browser global
  }
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  var GRAPHICS_LIBRARIES_REGEXP = /^(turtle|processing|matplotlib\.pyplot|image|sense_hat)$/i;

  // Graphics libraries that another graphics library pulls in as an internal
  // dependency. Importing such a dependency while its owner is active must not
  // count as a second library. Keyed by owner -> list of allowed dependencies.
  var GRAPHICS_LIBRARY_DEPENDENCIES = {
    sense_hat: ['image']
  };

  function isGraphicsLibrary(name) {
    return GRAPHICS_LIBRARIES_REGEXP.test(name);
  }

  function isDependencyOf(owner, library) {
    var deps = GRAPHICS_LIBRARY_DEPENDENCIES[owner];
    return !!deps && deps.indexOf(library) !== -1;
  }

  /**
   * Decide what to do when a graphics library is imported.
   *
   *   'setup'    - run the library's graphics setup and make it the active one
   *   'ignore'   - allow the import but run no setup (internal dependency)
   *   'conflict' - reject: a different graphics library is already in use
   *
   * @param {string|undefined} activeLibrary - the library already set up this run
   * @param {string} library - the library now being imported
   */
  function importDecision(activeLibrary, library) {
    if (activeLibrary === undefined || activeLibrary === library) {
      return 'setup';
    }
    if (isDependencyOf(activeLibrary, library)) {
      return 'ignore';
    }
    return 'conflict';
  }

  return {
    GRAPHICS_LIBRARIES_REGEXP: GRAPHICS_LIBRARIES_REGEXP,
    isGraphicsLibrary: isGraphicsLibrary,
    importDecision: importDecision
  };
});
