(function(Trinket) {
  function Server(language, parent) {
    this._client    = undefined;
    this._connected = false;
    this._running   = false;
    this._reconnect = false;
    this._language  = language;
    this._history   = [];
    this._parent    = parent || { logClientMetric : function() {} };

    this._reinitClient = function() {
      // disconnect current client
      try {
        this._client.socket.disconnect();
      } catch(e) {
        console.log('disconnect error:', e);
      }

      this._client = undefined;

      // init new client
      this._initClient();
      this._connected = false;
      this._running   = false;
      this._reconnect = false;
    }

    this._initClient = function() {
      if (this._client) return;

      var api_config = this._language + '_api';
      this._client = {
          host   : trinket.config[api_config]
        , socket : undefined
      };
    }

    this._initClient();
  }

  Server.prototype.getConnection = function(options) {
    var self = this;

    var t0 = performance.now();
    var connection_timer = setTimeout(function() {
      var t1 = performance.now();
      self._parent.logClientMetric({
          event_type : "no_connection_after_5s"
        , duration   : Math.floor(t1 - t0)
      });
    }, 5000);

    if (this._connected) {
      if (this._running) {
        this._reinitClient();
      }
      else {
        // reusing the connection seems to throw an error on evaluate
        // reinit until that is resolved
        // return $.Deferred().resolve().promise();
        this._reinitClient();
      }   
    }
    else if (this._reconnect) {
      this._reinitClient();
    }

    var socket_options = {
        'force new connection'      : true
      , 'sync disconnect on unload' : true
      , 'reconnectionAttempts'      : 6
    };

    if (options && options.socket_options) {
      _.assign(socket_options, options.socket_options);
    }

    // Attach the app-minted execution token so the exec-stack managers can
    // verify the run came from an app-served page (see lib/util/nunjucks.js).
    // Covers both python3 and pygame — both use this TrinketServer.
    if (typeof trinket !== 'undefined' && trinket.config && trinket.config.execToken) {
      socket_options.auth = { token: trinket.config.execToken };
    }

    // Extract path from host URL for nginx routing (e.g., /python3/socket.io/)
    var hostUrl = self._client.host;
    var socketHost = hostUrl;
    try {
      var url = new URL(hostUrl);
      if (url.pathname && url.pathname !== '/') {
        socket_options.path = url.pathname + '/socket.io/';
        socketHost = url.origin;
      }
    } catch(e) {
      console.log('URL parse error:', e);
    }

    var promise = new Promise(function(resolve, reject) {
      var connectErrorCount = 0;
      var maxConnectErrors = 3;
      var rejected = false;
      var resolved = false;

      // Absolute timeout - reject if not connected within 5 seconds
      var absoluteTimeout = setTimeout(function() {
        if (!resolved && !rejected) {
          rejectOnce('Connection timed out. Server may be unavailable.');
        }
      }, 5000);

      function rejectOnce(reason) {
        if (rejected || resolved) return;
        rejected = true;
        clearTimeout(absoluteTimeout);
        if (connection_timer) {
          clearTimeout(connection_timer);
        }
        try {
          self._client.socket.disconnect();
        } catch(e) {}
        reject(new Error(reason));
      }

      self._client.socket = io.connect(socketHost, socket_options);

      if (options && options.handlers) {
        _.each(options.handlers, function(value, key) {
          self._client.socket.on(key, value);
        });
      }

      self._client.socket.on('connect', function() {
        if (rejected) return;
        resolved = true;
        clearTimeout(absoluteTimeout);
        if (connection_timer) {
          clearTimeout(connection_timer);
        }
        var t1 = performance.now();
        self._parent.logClientMetric({
            event_type : "connection"
          , duration   : Math.floor(t1 - t0)
        });

        resolve();
      });

      self._client.socket.on('connect_error', function(err) {
        connectErrorCount++;
        var t1 = performance.now();
        self._parent.logClientMetric({
            event_type : "connect_error"
          , duration   : Math.floor(t1 - t0)
          , message    : err.message
          , attempt    : connectErrorCount
        });

        // Reject after a few failed attempts instead of waiting for all retries
        if (connectErrorCount >= maxConnectErrors) {
          rejectOnce('Unable to connect to server. Please check that the server is running.');
        }
      });

      // not sure how to trigger / emulate this
      self._client.socket.on('connect_timeout', function(timeout) {
        var t1 = performance.now();
        self._parent.logClientMetric({
            event_type : "connect_timeout"
          , duration   : Math.floor(t1 - t0)
        });

        rejectOnce('Connection timed out');
      });

      self._client.socket.on('reconnect_failed', function() {
        var t1 = performance.now();
        self._parent.logClientMetric({
            event_type : "connect_failed"
          , duration   : Math.floor(t1 - t0)
        });

        rejectOnce('Connection failed after multiple attempts');
      });
    });

    return promise;
  }

  Server.prototype.startPrompt = function(jqconsole, options) {
    var self        = this
      , prompt_args = [];

    function prompt(input) {
      if (/^\s*$/.test(input)) {
        self.startPrompt(jqconsole, options);
      }
      else {
        var init = options.init;
        options.init = false;

        self.console(input, {
          init                : init,
          files               : options.files,
          file_added          : options.file_added,
          script_error        : options.script_error,
          compile_error       : options.compile_error,
          clear               : options.clear,
          shell_connect_error : options.shell_connect_error,
          stdout              : function(out) {
            out = options.stdout_callback(out);
            jqconsole.Write(out.output);

            if (!/\n$/.test(out.output) && jqconsole.GetState() !== "input") {
              jqconsole.Input(function(input) {
                self.write(input + '\n');
              });

              if (jqconsole._enteringHistory && out.continuation) {
                self.enterHistory(jqconsole);
              }
            }
          },
          done          : function(result) {
            if (self._console_timer) {
              clearTimeout(self._console_timer);
            }
            options.callback();
            if (result && result.error) {
              if (options.done_error_handler) {
                options.done_error_handler(result);
              }
              else {
                result.error = result.error.replace(/</g, '&lt;');
                jqconsole.Write(result.error, 'jqconsole-error', false);
              }
            }
            if (jqconsole.GetState() === "input") {
              jqconsole.AbortPrompt();
            }
            self.startPrompt(jqconsole, options);
          }
        });
      }
    }

    prompt_args.push(true, prompt);

    if (options.multiline_callback) {
      // used inside multiline_callback
      self.inMultilineString = false;

      options.multiline_callback.bind(self);

      prompt_args.push(options.multiline_callback);

      if (options.async_multiline) {
        prompt_args.push(options.async_multiline);
      }
    }

    if (typeof options.callback === 'undefined') {
      options.callback = function() {}
    }
    if (typeof options.stdout_callback === 'undefined') {
      options.stdout_callback = function(out) {
        return out;
      }
    }

    jqconsole.Prompt.apply(jqconsole, prompt_args);

    self.enterHistory(jqconsole);
  }

  Server.prototype.write = function(input) {
    this._client.socket.emit('write', {
      input : input
    });
  }

  Server.prototype.connected = function(value) {
    if (typeof value === 'boolean') {
      this._connected = value;
    }

    return this._connected;
  }
  Server.prototype.running = function(value) {
    if (typeof value === 'boolean') {
      this._running = value;
    }

    return this._running;
  }
  Server.prototype.reconnect = function(value) {
    if (typeof value === 'boolean') {
      this._reconnect = value;

      if (this._reconnect) {
        this._connected = false;
        this._running   = false;
      }
    }

    return this._reconnect;
  }

  Server.prototype.client = function() {
    return this._client;
  }

  Server.prototype.run = function(code, options) {
    if (options.child_ready) {
      this._client.socket.on('child ready', options.child_ready);
    }
    if (options.stdout) {
      this._client.socket.on('stdout', options.stdout);
    }
    if (options.clear) {
      this._client.socket.on('clear', options.clear);
    }
    if (options.script_error) {
      this._client.socket.on('script error', options.script_error);
    }
    if (options.compile_error) {
      this._client.socket.on('compile error', options.compile_error);
    }
    if (options.done) {
      this._client.socket.on('done', options.done);
    }
    if (options.exit) {
      this._client.socket.on('exit', options.exit);
    }
    if (options.file_added) {
      this._client.socket.on('file added', options.file_added);
    }

    if (options.shell_connect_error) {
      this._client.socket.on('shell connect error', options.shell_connect_error);
    }

    this._client.socket.emit('run', {
      code : code
    });
  }

  Server.prototype.stop = function() {
    this._client.socket.emit('stop');
  }

  Server.prototype.console = function(input, options) {
    var self = this;

    var t0 = performance.now();
    this._console_timer = setTimeout(function() {
      var t1 = performance.now();
      self._parent.logClientMetric({
          event_type : "no_console_response_after_5s"
        , duration   : Math.floor(t1 - t0)
      });
    }, 5000);

    if (options.init) {
      if (options.stdout) {
        this._client.socket.on('stdout', options.stdout);
      }
      if (options.clear) {
        this._client.socket.on('clear', options.clear);
      }
      if (options.script_error) {
        this._client.socket.on('script error', options.script_error);
      }
      if (options.done) {
        this._client.socket.on('done', options.done);
      }
      if (options.file_added) {
        this._client.socket.on('file added', options.file_added);
      }

      if (options.shell_connect_error) {
        this._client.socket.on('shell connect error', options.shell_connect_error);
      }
    }
    this._client.socket.emit('console', {
      init  : options.init,
      files : JSON.stringify(options.files),
      input : input
    });
  }

  Server.prototype.setHistory = function(commands) {
    this._history = commands;
  }

  Server.prototype.disconnect = function() {
    try {
      this._client.socket.disconnect();
    } catch(e) {
      console.log('disconnect error:', e);
    }

    this._reconnect = true;
  }

  Server.prototype.enterHistory = function(jqconsole) {
    var command, chrs, i, jqEvent;

    jqconsole.Focus();

    if (this._history.length) {
      jqconsole._enteringHistory = true;

      command = this._history.shift();
      chrs    = command.split('');

      for (i = 0; i < chrs.length; i++) {
        jqEvent = $.Event('keypress');
        jqEvent.which = chrs[i].charCodeAt(0);
        jqconsole.$input_source.trigger(jqEvent);
      }

      if (!this._history.length) {
        jqconsole._enteringHistory = false;
      }

      jqEvent = $.Event('keydown');
      jqEvent.which = '\r'.charCodeAt(0);
      jqconsole.$input_source.trigger(jqEvent)
    }
  }

  Trinket.export('embed.server', Server);
})(window.TrinketIO);
