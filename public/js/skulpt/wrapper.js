(function(TrinketIO, $) {

var template = TrinketIO.import('utils.template');

var browser    = Detectizr.browser.name;
var browser_os = browser + ":" + Detectizr.os.name;
var killable   = browser === "midori" || browser === "iceweasel" || browser === "epiphany" ? false : true;

// assumes versions greater than or equal to
var browser_version = parseInt(Detectizr.browser.version);

var tagsToReplace = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;'
};

var oneLineEval     = 'evaluationresult = ',
    //finds lines starting with "print"
    re              = /^\s*print\b/,
    //finds import statements
    importre        = /^\s*(from\s+\w+\s+)?import\b/,
    //finds defining statements
    defre           = /(def|class|for|while|del)\b.*/,
    //test for empty line.
    emptyline       = /^\s*$/,
    // test for assignment (bare equals)
    equalsre        = /[^!=<>]=[^=]/,
    // finds lines starting with a comment
    comment         = /^\s*#/;

var LOADED_EXTERNAL_LIBRARIES = {};
// Loaded from /js/skulpt/graphics_libraries.js (bundled before this file).
var GraphicsLibraries = window.SkulptGraphicsLibraries;
var GRAPHICS_LIBRARIES_REGEXP = GraphicsLibraries.GRAPHICS_LIBRARIES_REGEXP;
var destroyGraphicsFn;
var defaultGraphicsSetup = {
  turtle : function(config, $target) {
    if (typeof destroyGraphicsFn === 'function') {
      destroyGraphicsFn();
    }

    var w = config.graphicsWidth();
    var h = config.graphicsHeight();
    var size = Math.min(w, h);
    if (!Sk.TurtleGraphics) {
      Sk.TurtleGraphics = {};
    }
    Sk.TurtleGraphics.width  = size;
    Sk.TurtleGraphics.height = size;
    Sk.TurtleGraphics.worldWidth = 400;
    Sk.TurtleGraphics.worldHeight = 400;
    Sk.TurtleGraphics.target = $target[0];
    Sk.TurtleGraphics.assets = function(asset) {
      if (!config.userAssets) return undefined;

      for (var i = 0; i < config.userAssets.length; i++) {
        if (config.userAssets[i].name === asset) {
          return config.userAssets[i].url;
        }
      }

      return undefined;
    };
    $target.data("graphicMode", "turtle");
    return $target.empty();
  },
  image : function(config, $target) {
    if (typeof destroyGraphicsFn === 'function') {
      destroyGraphicsFn();
    }

    Sk.canvas = "graphic";
    if (typeof(ImageMod) !== 'undefined') {
      ImageMod.canvasLib = [];
    }

    return $target.empty();
  },
  processing : function(config, $target) {
    var processingSkUrl = trinketConfig.prefix('/components/processing.sk/processing-sk-min.js');

    $target.data("graphicMode", "processing");

    return loadExternalLibraryInternal_(processingSkUrl, true).then(function() {
      var outputCode = document.getElementById('codeOutput');
      var skulpt_module = trinketConfig.prefix('/components/processing.sk/skulpt_module');
      ProcessingSk.init(
        skulpt_module,
        config.suspensionHandler,
        config.suspensionHandler['*'],
        function(e){
          return e.target === document.body || (outputCode && outputCode.contains(e.target));
        });

      Sk.externalLibraries["./processing/__init__.js"]["dependencies"] = [
        trinketConfig.prefix('/components/Processing.js/processing.min.js')
      ];

      if (typeof destroyGraphicsFn === 'function') {
        destroyGraphicsFn();
      }

      var processingCanvasId = Sk.canvas = 'processingCanvas';

      setTimeout(function() {
        window.readyForSnapshot = true;
      }, 10000);

      $target.focus();

      return $target.html(
        '<canvas style="display:none" id="' + processingCanvasId +
        '" width="400" height="400"></canvas>'
      );
    });
  },
  'matplotlib.pyplot' : function(config, $target) {
    if (typeof destroyGraphicsFn === 'function') {
      destroyGraphicsFn();
    }

    var matplotlibCanvasId = Sk.canvas = 'matplotlibCanvas';
    $target.data("graphicMode", "matplot");
    return $target.html(
      '<div id="' + matplotlibCanvasId + '"></div>'
    );
  },
  'sense_hat' : function(config, $target) {
    var senseHatUrl = trinketConfig.prefix('/js/embed/sense_hat.js');
    $target.data("graphicMode", "sense_hat");
    return loadExternalLibraryInternal_(senseHatUrl, true).then(function() {
      return SenseHat.init(config, $target);
    });
  }
};
var defaultExternalLibraries = {
  './numpy/__init__.js' : {
    path : trinketConfig.prefix('/components/skulpt_numpy/dist/numpy/__init__.js'),
  },
  './numpy/random/__init__.js' : {
    path : trinketConfig.prefix('/components/skulpt_numpy/dist/numpy/random/__init__.js'),
  },
  './matplotlib/__init__.js' : {
    path : trinketConfig.prefix('/components/skulpt_matplotlib/matplotlib/__init__.js')
  },
  './matplotlib/pyplot/__init__.js' : {
    path : trinketConfig.prefix('/components/skulpt_matplotlib/matplotlib/pyplot/__init__.js'),
    dependencies : [
      trinketConfig.component('d3', 'd3.min.js')
    ]
  },
  './json/__init__.js' : {
    path : trinketConfig.prefix('/components/json.sk/__init__.js'),
    dependencies : [
      trinketConfig.prefix('/components/json.sk/stringify.js')
    ]
  },
  './xml/__init__.js' : {
    path : trinketConfig.prefix('/components/xml.sk/__init__.js')
  },
  './xml/etree/__init__.js' : {
    path : trinketConfig.prefix('/components/xml.sk/etree/__init__.js')
  },
  './xml/etree/ElementTree.js' : {
    path : trinketConfig.prefix('/components/xml.sk/etree/ElementTree.js')
  },
  "src/lib/itertools.js" : {
    path : trinketConfig.prefix('/js/skulpt/itertools.js')
  },
  "src/lib/os.js" : {
    path : trinketConfig.prefix('/js/skulpt/os.js')
  },
  "./trinket/checks.js" : {
    path : trinketConfig.prefix('/js/skulpt/trinket/checks.js')
  },
  "./trinket/tester/__init__.py" : {
    path : trinketConfig.prefix('/js/skulpt/trinket/tester/__init__.py')
  },
  "./trinket/ast/__init__.py" : {
    path : trinketConfig.prefix('/js/skulpt/trinket/ast/__init__.py')
  },
  // This lets __init__ find its neighbor
  "./_ast.js" : {
    path : trinketConfig.prefix('/js/skulpt/trinket/ast/_ast.js')
  },
  "./trinket/__init__.js" : {
    path : trinketConfig.prefix('/js/skulpt/trinket/__init__.js')
  },
  "./turtletalk.py" : {
    path : trinketConfig.prefix('/js/skulpt/turtletalk.py')
  }
};

TrinketIO.export('Skulpt', function(config) {
  var defaultConfig = {
    evalMode          : 'main',
    allowGraphics     : true,
    autoEscape        : false,
    read              : defaultRead,
    write             : defaultWrite,
    error             : defaultError,
    graphicsSetup     : defaultGraphicsSetup,
    includeFileInErrors : false,
    graphicsWidth     : function() {
      return $(config.graphicsTarget()).parent().width();
    },
    graphicsHeight    : function() {
      return $(config.graphicsTarget()).parent().height();
    },
    externalLibraries : defaultExternalLibraries,
    onBeforeImport    : function (library) {
      var outputCode = document.getElementById('codeOutput');

      if (library === "pygame") {
        var pygameSkUrl = trinketConfig.prefix('/components/pygame.sk/pygame.js');
        return Sk.misceval.promiseToSuspension(loadExternalLibraryInternal_(pygameSkUrl, true).then(function() {
          Pygame.init(trinketConfig.prefix("/components/pygame.sk/skulpt_module"), function(e) {
            return e.target === document.body || (outputCode && outputCode.contains(e.target));
          });
        }));
      }
    },
    imageProxy        : function(asset) {
      //return the asset when its not found so we get a more intelligible exception
      if (!config.userAssets) return asset;

      for (var i = 0; i < config.userAssets.length; i++) {
        if (config.userAssets[i].name === asset) {
          return config.userAssets[i].url;
        }
      }

      return asset;
    }
  };

  config = $.extend({}, defaultConfig, config);
  if (config.allowGraphics) {
    config.graphicsSetup = $.extend(
      {},
      defaultGraphicsSetup,
      config.graphicsSetup
    );
    config.graphicsTarget = config.graphicsTarget || function() {
      return $('#graphic');
    };
  }

  var safeWrite = function(text) {
    if (config.autoEscape) {
      text = safeTags(text);
    }
    config.write(text);
  };

  var ABORT_CODE = '__abort_code__';

  var runCode = function(code, oneLiner, lines, onComplete, onError, onAbort) {
    var execution = {
      complete : false
    };

    if (config.evalMode !== 'repl') {
      if (Sk.TurtleGraphics && Sk.TurtleGraphics.reset) {
        Sk.TurtleGraphics.reset();
      }
    }

    var handleError = function(e) {
      var errorMessage = safeTags(e.toString());

      if (e.traceback && e.traceback.length) {
        e.filename = e.traceback[0].filename;
      }

      if (config.includeFileInErrors && e.filename) {
        errorMessage = errorMessage + " in " + e.filename.replace(/^\.\//, "");
      }


      if (config.evalMode === 'repl') {
        errorMessage += '\n';

        var index = -1;
        //find the line number
        if ((index = e.toString().indexOf("on line")) !== -1) {
          index = parseInt(e.toString().substr(index + 8), 10);
        }
        var line = 0;
        if (oneLiner) {
          errorMessage += '1>: ' + lines[0].substr(oneLineEval.length);
        }
        else {
          // print the accumulated code with a ">" before the broken line.
          // Don't add the last statement to the accumulated code
          errorMessage += lines.map(function (str) {
            return ++line + (index === line ? ">" : " ") + ": " + str;
          }).join('\n');
        }
      }

      config.error(errorMessage, e);
      if (onError && typeof onError === 'function') {
        onError(errorMessage, e);
      }
    }

    Sk.misceval.asyncToPromise(function() {
      return Sk.importMainWithBody(config.evalMode, false, code, true);
    }, config.suspensionHandler).then(function (module) {
      execution.complete = true;
      if (onComplete && typeof onComplete === 'function') {
        onComplete();
      }
    }, function (e) {
      if (e === ABORT_CODE) {
        if (onAbort && typeof onAbort === 'function') {
          onAbort();
        }
        return;
      }

      execution.complete = true;
      onError(e);
    });

    return execution;
  } // end runCode

  var lastExecution;

  return function evaluate(code, onComplete, onError, onAbort) {
    // exit early if code is entirely whitespace
    if (!code || /^\s*$/.test(code)) {
      return onComplete();
    }

    // return oneLiner, lines, errorMessage
    var configResults = SkRuntimeConfig(config, lastExecution, safeWrite, code, onComplete, onError);

    lastExecution = runCode(configResults.code, configResults.oneLiner, configResults.lines, onComplete, configResults.handleError, onAbort);

    return configResults.errorMessage ? false : true;
  };
});

function SkRuntimeConfig(config, lastExecution, safeWrite, code, onComplete, onError) {
  var graphicsLibrary, oneLiner, lines, errorMessage;

  if (lastExecution && !lastExecution.complete) {
    lastExecution.stop = true;
  }

  var default_settings = {
    print_function: false,
    division: true,
    absolute_import: null,
    unicode_literals: true,
    // skulpt specific
    set_repr: true,
    class_repr: true,
    inherit_from_object: true,
    super_args: true,
    octal_number_literal: true,
    bankers_rounding: true,
    python_version: true,
    dunder_next: true,
    dunder_round: true,
    exceptions: true,
    no_long_type: true,
    ceil_floor_int: true,
    l_suffix: false,
    silent_octal_literal: false
  };

  var python2 = {
    print_function: false,
    division: false,
    absolute_import: null,
    unicode_literals: false,
    // skulpt specific
    set_repr: false,
    class_repr: false,
    inherit_from_object: false,
    super_args: false,
    octal_number_literal: false,
    bankers_rounding: false,
    python_version: false,
    dunder_next: false,
    dunder_round: false,
    exceptions: false,
    no_long_type: false,
    ceil_floor_int: false,
    l_suffix: true,
    silent_octal_literal: true
  };

  var python3 = {
    print_function: true,
    division: true,
    absolute_import: null,
    unicode_literals: true,
    // skulpt specific
    set_repr: true,
    class_repr: true,
    inherit_from_object: true,
    super_args: true,
    octal_number_literal: true,
    bankers_rounding: true,
    python_version: true,
    dunder_next: true,
    dunder_round: true,
    exceptions: true,
    no_long_type: true,
    ceil_floor_int: true,
    l_suffix: false,
    silent_octal_literal: false
  };

  // add newlines in case the code was, e.g. pasted without them
  code = code.replace(/\r(?!\n)/gm, '\r\n');

  var hashbang = code.match(/^\s*#!.*?python(\d)/i);
  var versionInfo = code.match(/^\s*#\s*python\s*[=:]?\s*(\d)/i);

  if (versionInfo) {
    Sk.__future__ = (versionInfo[1] === '2') ? python2 : default_settings;
  }
  else if (hashbang) {
    Sk.__future__ = (hashbang[1] === '3') ? python3 : python2;
  }
  else {
    Sk.__future__ = default_settings;
  }

  var handleError = function(e) {
    var errorMessage = safeTags(e.toString())
      , errorIndex;

    if (e.traceback && e.traceback.length) {
      for (errorIndex = 0; errorIndex < e.traceback.length; errorIndex++) {
        if (config.userFiles && typeof config.userFiles[ e.traceback[errorIndex].filename ] !== 'undefined') {
          e.filename = e.traceback[errorIndex].filename;
          e.lineno   = e.traceback[errorIndex].lineno;
        }
      }

      if (typeof e.filename === 'undefined') {
        // filter out all the traceback that belongs to the main.py file
        // and then get the first error that appeared that makes much more
        // because that's where it actually goes wrong on this page
        e.traceback = e.traceback.filter(function(t) { return typeof t.filename !== "undefined" && t.filename === "main.py" });
        if (e.traceback[0]) {
          e.filename = e.traceback[0].filename;
          e.lineno   = e.traceback[0].lineno;
        }
      }
    }

    if (config.includeFileInErrors && e.filename) {
      errorMessage = errorMessage.replace(/on line \d+/, "on line " + e.lineno);
      errorMessage = errorMessage + " in " + e.filename.replace(/^\.\//, "");
    }

    if (config.evalMode === 'repl') {
      errorMessage += '\n';

      var index = -1;
      //find the line number
      if ((index = e.toString().indexOf("on line")) !== -1) {
        index = parseInt(e.toString().substr(index + 8), 10);
      }
      var line = 0;
      if (oneLiner) {
        errorMessage += '1>: ' + lines[0].substr(oneLineEval.length);
      }
      else {
        // print the accumulated code with a ">" before the broken line.
        // Don't add the last statement to the accumulated code
        errorMessage += lines.map(function (str) {
          return ++line + (index === line ? ">" : " ") + ": " + str;
        }).join('\n');
      }
    }

    config.error(errorMessage, e);
    if (onError && typeof onError === 'function') {
      onError(errorMessage, e);
    }
  }

  Sk.configure({
    inputfun      : config.inputfun,
    __future__    : Sk.__future__,
    retainglobals : (config.evalMode === 'repl'),
    output        : safeWrite,
    read          : function(path) {
      return config.read(path, Sk.builtinFiles["files"] || {}, config.userFiles || {});
    },
    write         : function() {
    },
    nonreadopen   : true,
    fileopen      : defaultFileOpen,
    filewrite     : defaultFileWrite,
    imageProxy    : config.imageProxy || '',
    uncaughtException : handleError,
    signals       : true,
    killableWhile : killable,
    killableFor   : false
  });

  config.suspensionHandler = {
    '*' : function() {
      if (window.Sk_interrupt === true) {
        throw new Error('interrupt');
      } else {
        return null;
      }
    }
  };

  if (!Sk.externalLibraries) {
    Sk.externalLibraries = {};
  }

  $.extend(Sk.externalLibraries, config.externalLibraries);

  if (config.allowGraphics) {
    Sk.availableWidth    = config.graphicsWidth();
    Sk.availableHeight   = config.graphicsHeight();
  }

  Sk.domOutput = function(html) {
    return $(config.graphicsTarget()).append(html).children().last();
  }

  Sk.onBeforeImport = function(library) {
    return Sk.misceval.chain(library, function() {
      if (GRAPHICS_LIBRARIES_REGEXP.test(library)) {
        if (!config.allowGraphics) {
          return 'Graphics libraries are not allowed';
        }

        var decision = GraphicsLibraries.importDecision(graphicsLibrary, library);

        if (decision === 'conflict') {
          return 'You may only use a single graphics library at a time and the ' + graphicsLibrary + ' library is already in use.'
        }

        // A graphics library's own internal dependency (e.g. sense_hat's
        // `from image import Image`): let it import, but run no setup and keep
        // the owning library active so its display is not torn down.
        if (decision === 'ignore') {
          return;
        }

        if (typeof(config.onGraphicsInit) === 'function') {
          config.onGraphicsInit();
        }

        // the Promse.resolve is there to make sure it's always a promise, if you
        // resolve a promise it will remove the unnecesairy layer or Promise
        return Sk.misceval.promiseToSuspension(Promise.resolve(config.graphicsSetup[library](config, $(config.graphicsTarget()))).then(function() {
          graphicsLibrary = library;
        }));
      }
    }, function(message) {
      if (message) {
        return message;
      }

      if (config.onBeforeImport) {
        return config.onBeforeImport(library);
      }

      return void(0);
    });
  };

  if (config.onAfterImport) {
    Sk.onAfterImport = config.onAfterImport;
  }

  if (config.evalMode === 'repl') {
    //split lines on linefeed
    lines    = code.split('\n').filter(function(str) { return !emptyline.test(str); }),
    oneLiner = lines.length === 1 || (/"""/.test(lines[0]) && /"""/.test(lines[lines.length -1]));

    if (oneLiner) {
      // if it's a statement that should be printed (not containing an = or def or class or an empty line)
      if (!equalsre.test(lines[0]) && !defre.test(lines[0]) && !importre.test(lines[0]) && lines[0].length > 0) {
        //if it doesn't contain print make sure it doesn't print None
        if (!re.test(lines[0]) && !comment.test(lines[0])) {
          //remove the statement
          //evaluate it if nessecary
          lines.unshift(oneLineEval + lines.shift());
          //print the result if not None
          lines.push("if not evaluationresult == None: print evaluationresult");
        }
      }
    }

    //filter out empty lines
    lines = lines.filter(function(str){ return !emptyline.test(str); });

    //don't compile if there isn't anything to compile.
    if (lines.length === 0) { return }

    code = lines.join('\n');
  }

  return {
      code         : code
    , lines        : lines
    , oneLiner     : oneLiner
    , errorMessage : errorMessage
    , handleError  : handleError
  };
}

TrinketIO.export('SkRuntimeConfig', SkRuntimeConfig);

function loadExternalLibrary(name) {
  var externalLibraryInfo, path;

  externalLibraryInfo = Sk.externalLibraries && Sk.externalLibraries[name];

  // if no external library info can be found, bail out
  if (!externalLibraryInfo) {
      return Promise.resolve();
  }

  // if the external library info is just a string, assume it is the path
  // otherwise dig into the info to find the path
  path = typeof externalLibraryInfo === "string" ?
      externalLibraryInfo :
      externalLibraryInfo.path;

  if (typeof path !== "string") {
      throw new Sk.builtin.ImportError("Invalid path specified for " + name);
  }

  return loadExternalLibraryInternal_(path, false).then(function(mod) {
    if (!mod) {
      throw new Sk.builtin.ImportError("Failed to load remote module '" + name + "'");
    }

    var promise;

    function mapUrlToPromise(path) {
        return loadExternalLibraryInternal_(path, true);
    }

    if (externalLibraryInfo.loadDepsSynchronously) {
      promise = Promise.map((externalLibraryInfo.dependencies || []), mapUrlToPromise, { concurrency: 1});
    } else {
      promise = Promise.all((externalLibraryInfo.dependencies || []).map(mapUrlToPromise));
    }

    return promise.then(function() {
      return mod;
    }).catch(function() {
      throw new Sk.builtin.ImportError("Failed to load dependencies required for " + name);
    });
  });
};

function loadExternalLibraryInternal_(path, inject) {
  return new Promise(function(resolve, reject) {

    if (LOADED_EXTERNAL_LIBRARIES[path]) {
      return resolve(LOADED_EXTERNAL_LIBRARIES[path]);
    }

    var scriptElement;
    var request;

    if (path == null) {
      reject();
    }

    if (inject) {
      scriptElement = document.createElement("script");
      scriptElement.type = "text/javascript";
      scriptElement.src = path;
      scriptElement.async = true
      scriptElement.onload = function() {
        resolve(true);
      }

      document.body.appendChild(scriptElement);
    } else {
      request = new XMLHttpRequest();
      request.open("GET", path);
      request.onload = function() {
        if (request.status === 200) {
          resolve(request.responseText);
        } else {
          reject();
        }
      };

      request.onerror = function() {
        reject();
      }
      request.send();
    }
  }).then(function (result) {
    LOADED_EXTERNAL_LIBRARIES[path] = result;

    return result;
  });
};

function defaultWrite(text) {
  var pre = $('#console-output');
  pre.removeClass('hide');
  pre.html(pre.html() + text);
}

function defaultError(message, rawError) {
  var type = 'code-error'
      , html;

  if (rawError instanceof Sk.builtin.ExternalError) {
    rawError = rawError.nativeError;
  }

  if (rawError && rawError.type === 'validation') {
    type    = 'info';
    message = rawError.message;
  }

  if ( (rawError && rawError.message === 'interrupt')
  ||   (message  && /\b(?:SystemExit|KeyboardInterrupt)\b/.test(message)) ) {
    return;
  }

  var html = template('statusMessageTemplate', {
    type    : type,
    message : message
  });
  var $msg = $(html);
  $('body').append($msg);
  $('body').addClass('has-status-bar');
  $msg.parent().foundation().trigger('open.fndtn.alert');
}

function defaultRead (filename, systemFiles, userFiles) {
  return Sk.misceval.promiseToSuspension(
    // check first for an externally loaded library
    loadExternalLibrary(filename).then(function(external) {
      if (external) {
        return external;
      }

      var src = userFiles[filename] || systemFiles[filename];

      if (src === undefined) {
        throw "File not found: '" + filename + "'";
      }

      return src;
    })
  );
}

function defaultFileOpen(skfile) {
  var event = document.createEvent("Event");
  event.data = skfile.mode.v + ":" + skfile.name;
  event.initEvent("SkfileOpen", true, true);
  document.dispatchEvent(event);
}

function defaultFileWrite(skfile, str) {
  var event = document.createEvent("Event");
  event.data = skfile.name + ":" + str.v;
  event.initEvent("SkfileWrite", true, true);
  document.dispatchEvent(event);
}

function safeTags(str) {
  return str.replace(/[&<>]/g, function(tag) {
    return tagsToReplace[tag] || tag;
  });
}

})(window.TrinketIO, window.jQuery);
