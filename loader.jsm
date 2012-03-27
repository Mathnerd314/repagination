/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["BASE_PATH", "require", "unload", "_setupLoader"];

const {
  classes: Cc,
  interfaces: Ci,
  utils: Cu,
  Constructor: ctor
} = Components;
const {
  getWeakReference: weak,
  reportError: reportError
} = Cu;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// hide our internals
// Since require() uses .scriptloader, the loaded require scopes will have
// access to the named stuff within this module scope, but we actually want
// them to have access to certain stuff.
(function setup_scope(exports) {
  function itor(obj, name, cls, iface, init) {
    if (init) {
      XPCOMUtils.defineLazyGetter(obj, name, function() ctor(cls, iface, init));
      XPCOMUtils.defineLazyGetter(obj, "Plain" + name, function() ctor(cls, iface));
    }
    else {
      XPCOMUtils.defineLazyGetter(obj, name, function() ctor(cls, iface));
      XPCOMUtils.defineLazyGetter(obj, name.toLowerCase(), function() new this[name]());
    }
  }
 
  exports.Services = Object.create(Services);
  const Instances = exports.Instances = {};
  itor(Instances, "XHR", "@mozilla.org/xmlextras/xmlhttprequest;1", "nsIXMLHttpRequest");
  itor(Instances, "ScriptError", "@mozilla.org/scripterror;1", "nsIScriptError", "init");
  itor(Instances, "Timer", "@mozilla.org/timer;1", "nsITimer", "init");

  const {SELF_PATH, BASE_PATH} = (function() {
    let rv;
    try { throw new Error("narf"); }
    catch (ex) {
      rv = {
        SELF_PATH: ex.fileName,
        BASE_PATH: /^(.+\/).*?$/.exec(ex.fileName)[1]
      };
    }
    return rv;
  })();
  exports.BASE_PATH = BASE_PATH;
 
  // logging stubs
  var log = function() {} // stub
  var LOG_DEBUG = 0, LOG_INFO = 0, LOG_ERROR = 0;

  var _unloaders = [];
  let _runUnloader = function _runUnloader(fn, args) {
      try {
        fn.apply(null, args);
      }
      catch (ex) {
        log(LOG_ERROR, "unloader failed", ex);
      }
  }
  exports.unload = function unload(fn) {
    if (fn == "shutdown") {
      log(LOG_INFO, "shutdown");
      for (let i = _unloaders.length; ~(--i);) {
        _runUnloader(_unloaders[i]);
      }
      _unloaders.splice(0);
      return;
    }

    // add an unloader
    if (typeof(fn) != "function") {
      throw new Error("unloader is not a function");
    }
    _unloaders.push(fn);
    return function() {
      _runUnloader(fn, arguments);
      _unloaders = _unloaders.filter(function(c) c != fn);
    };
  } 

  const _registry = Object.create(null);
  exports.require = function require(module) {
    module = BASE_PATH + module + ".js";
   
    // already loaded?
    if (module in _registry) {
      return _registry[module];
    }

    // try to load the module
    log(LOG_DEBUG, "going to load: " + module);
    let scope = {exports: Object.create(null)};
    try {
      Services.scriptloader.loadSubScript(module, scope);
    }
    catch (ex) {
      log(LOG_ERROR, "failed to load " + module, ex);
      throw ex;
    }

    _registry[module] = scope.exports;
    log(LOG_DEBUG, "loaded module: " + module);

    return scope.exports;
  } 
  exports.lazyRequire = function lazyRequire(module) {
    function lazyBind(props, prop) {
      log(LOG_DEBUG, "lazily binding " + props + " for module " + module);
      let m = require(module);
      for (let [,p] in Iterator(props)) {
        delete this[p];
        this[prop] = m[p];
      }
      return this[prop];
    }

    // Already loaded?
    if (module in _registry) {
      log(LOG_DEBUG, "not lazily binding " + module + "; already loaded");
      return _registry[module];
    }

    let props = Array.slice(arguments, 1);
    let rv = {};
    let binder = lazyBind.bind(rv, props);
    for (let [,p] in Iterator(props)) {
      let _p = p;
      XPCOMUtils.defineLazyGetter(rv, _p, function() binder(_p));
    }
    return rv;
  }

  unload(function() {
    let keys = Object.keys(_registry);
    for (let i = keys.length; ~(--i);) {
      delete _registry[keys[i]];
    }
    // unload ourselves
    Cu.unload(SELF_PATH);
  });

  exports._setupLoader = function _setupLoader(data, callback) {
    delete exports._setupLoader;

    let _am = {};
    Cu.import("resource://gre/modules/AddonManager.jsm", _am);
    _am.AddonManager.getAddonByID(data.id, function loader_startup(addon) {
      let logging;
      try {
        logging = require("logging");
        for (let [k,v] in Iterator(logging)) {
          exports[k] = v;
        }
        logging.setLogPrefix(addon.name);

        let prefs = require("preferences");
        prefs.init(addon.id);
        exports.prefs = prefs.prefs;
        exports.globalPrefs = prefs.globalPrefs;

        try {
          prefs.prefs.observe("loglevel", function(p,v) logging.setLogLevel(v));
        }
        catch (ex) {
          logging.log(logging.LOG_ERROR, "failed to set log level", ex);
        }
      }
      catch (ex) {
        // probably do not have a working log() yet
        reportError(ex);
        return;
      }

      try {
        if (callback) {
          logging.log(logging.LOG_DEBUG, "loader: running callback");
          callback();
        }
      }
      catch (ex) {
        logging.log(logging.LOG_ERROR, "callback failed!", ex);
      }
      logging.log(logging.LOG_DEBUG, "loader: done");
    });
  }

})(this);

/* vim: set et ts=2 sw=2 : */
