(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.ThreadedClass = f()}})(function(){var define,module,exports;return (function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KillTimeoutError = exports.RestartTimeoutError = void 0;
class RestartTimeoutError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'RestartTimeoutError';
    }
}
exports.RestartTimeoutError = RestartTimeoutError;
class KillTimeoutError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'KillTimeoutError';
    }
}
exports.KillTimeoutError = KillTimeoutError;

},{}],2:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeWorker = void 0;
const worker_1 = require("./worker");
// This code is actually not run in a child process, but in the parent process
// (it's used when multithreading is turned off.)
// All code in this file should still be considered to be sandboxed in the "virtual child process".
class FakeWorker extends worker_1.Worker {
    constructor(cb) {
        super();
        this.disabledMultithreading = true;
        this.mockProcessSend = cb;
    }
    killInstance() {
        // throw new Error('Trying to kill a non threaded process!')
    }
    sendInstanceMessageToParent(handle, msg, cb) {
        const message = Object.assign(Object.assign({}, msg), {
            messageType: 'instance',
            cmdId: handle.cmdId++,
            instanceId: handle.id
        });
        if (cb)
            handle.queue[message.cmdId + ''] = { cb };
        // Send message to Parent:
        this.mockProcessSend(message);
    }
    sendChildMessageToParent(handle, msg, cb) {
        const message = Object.assign(Object.assign({}, msg), {
            messageType: 'child',
            cmdId: handle.cmdId++
        });
        if (cb)
            handle.queue[message.cmdId + ''] = { cb };
        // Send message to Parent:
        this.mockProcessSend(message);
    }
}
exports.FakeWorker = FakeWorker;

},{"./worker":3}],3:[function(require,module,exports){
(function (process){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Worker = void 0;
const isRunning = require("is-running");
const lib_1 = require("../shared/lib");
const sharedApi_1 = require("../shared/sharedApi");
/** In a child process, there is running one (1) Worker, which handles the communication with the parent process. */
class Worker {
    constructor() {
        this.childHandler = {
            cmdId: 0,
            queue: {}
        };
        this.instanceHandles = {};
        this.callbacks = {};
        this.remoteFns = {};
        this.disabledMultithreading = false;
        this._parentPid = 0;
        this.log = (...data) => {
            this.sendLog(data);
        };
        this.logError = (...data) => {
            this.sendLog(['Error', ...data]);
        };
    }
    onMessageFromParent(m) {
        // A message was received from Parent
        if (m.messageType === 'instance') {
            let handle = this.instanceHandles[m.instanceId];
            if (!handle && m.cmd !== sharedApi_1.Message.To.Instance.CommandType.INIT) {
                console.log(`Child process: Unknown instanceId: "${m.instanceId}"`);
                return; // fail silently?
            }
            if (!handle) {
                // create temporary handle:
                handle = {
                    id: m.instanceId,
                    cmdId: 0,
                    queue: {},
                    instance: {}
                };
            }
            try {
                this.handleInstanceMessageFromParent(m, handle);
            }
            catch (e) {
                if (m.cmdId) {
                    this.replyInstanceError(handle, m, `Error: ${e.toString()} ${e.stack} thrown in handleInstanceMessageFromParent on instance "${m.instanceId}"`);
                }
                else
                    this.log('Error: ' + e.toString(), e.stack);
            }
        }
        else if (m.messageType === 'child') {
            let handle = this.childHandler;
            try {
                this.handleChildMessageFromParent(m, handle);
            }
            catch (e) {
                if (m.cmdId) {
                    this.replyChildError(handle, m, `Error: ${e.toString()} ${e.stack} thrown in handleChildMessageFromParent on child`);
                }
                else
                    this.log('Error: ' + e.toString(), e.stack);
            }
        }
    }
    decodeArgumentsFromParent(handle, args) {
        // Note: handle.instance could change if this was called for the constructor parameters, so it needs to be loose
        return (0, sharedApi_1.decodeArguments)(() => handle.instance, args, (a) => {
            const callbackId = a.value;
            if (!this.remoteFns[callbackId]) {
                this.remoteFns[callbackId] = ((...args) => {
                    const orgError = new Error();
                    return new Promise((resolve, reject) => {
                        const callbackId = a.value;
                        this.sendCallback(handle, callbackId, args, (err, encodedResult) => {
                            if (err) {
                                const errStack = (0, lib_1.stripStack)((0, lib_1.getErrorStack)(err), [
                                    /[\\/]parent-process[\\/]manager/,
                                    /[\\/]eventemitter3[\\/]index/
                                ]);
                                const orgStack = (orgError.stack + '')
                                    .split('\n')
                                    .slice(2) // Remove the first two lines, since they are internal to ThreadedClass
                                    .join('\n');
                                reject((0, lib_1.combineErrorStacks)(errStack, orgStack));
                                // reject(err)
                            }
                            else {
                                const result = encodedResult ? this.decodeArgumentsFromParent(handle, [encodedResult]) : [encodedResult];
                                resolve(result[0]);
                            }
                        });
                    });
                });
            }
            return this.remoteFns[callbackId];
        });
    }
    encodeArgumentsToParent(instance, args) {
        return (0, sharedApi_1.encodeArguments)(instance, this.callbacks, args, this.disabledMultithreading);
    }
    replyToInstanceMessage(handle, messageToReplyTo, reply) {
        this.sendInstanceReplyToParent(handle, messageToReplyTo.cmdId, undefined, reply);
    }
    replyToChildMessage(handle, messageToReplyTo, reply) {
        this.sendChildReplyToParent(handle, messageToReplyTo.cmdId, undefined, reply);
    }
    replyInstanceError(handle, messageToReplyTo, error) {
        this.sendInstanceReplyToParent(handle, messageToReplyTo.cmdId, error);
    }
    replyChildError(handle, messageToReplyTo, error) {
        this.sendChildReplyToParent(handle, messageToReplyTo.cmdId, error);
    }
    sendInstanceReplyToParent(handle, replyTo, error, reply) {
        let msg = {
            cmd: sharedApi_1.Message.From.Instance.CommandType.REPLY,
            replyTo: replyTo,
            error: error ? (error.stack || error).toString() : error,
            reply: reply
        };
        this.sendInstanceMessageToParent(handle, msg);
    }
    sendChildReplyToParent(handle, replyTo, error, reply) {
        let msg = {
            cmd: sharedApi_1.Message.From.Child.CommandType.REPLY,
            replyTo: replyTo,
            error: error ? (error.stack || error).toString() : error,
            reply: reply
        };
        this.sendChildMessageToParent(handle, msg);
    }
    sendLog(log) {
        let msg = {
            cmd: sharedApi_1.Message.From.Child.CommandType.LOG,
            log: log
        };
        this.sendChildMessageToParent(this.childHandler, msg);
    }
    sendCallback(handle, callbackId, args, cb) {
        let msg = {
            cmd: sharedApi_1.Message.From.Instance.CommandType.CALLBACK,
            callbackId: callbackId,
            args: args
        };
        this.sendInstanceMessageToParent(handle, msg, cb);
    }
    getAllProperties(obj) {
        let props = [];
        do {
            props = props.concat(Object.getOwnPropertyNames(obj));
            obj = Object.getPrototypeOf(obj);
        } while (obj);
        return props;
    }
    handleInstanceMessageFromParent(m, handle) {
        const instance = handle.instance;
        if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.INIT) {
            // This is the initial message sent from the parent process upon initialization.
            const msg = m;
            this._config = m.config;
            this._parentPid = m.parentPid;
            let pModuleClass;
            // Load in the class:
            if ((0, lib_1.isBrowser)()) {
                pModuleClass = new Promise((resolve, reject) => {
                    // @ts-ignore
                    let oReq = new XMLHttpRequest();
                    oReq.open('GET', msg.modulePath, true);
                    // oReq.responseType = 'blob'
                    oReq.onload = () => {
                        if (oReq.response) {
                            resolve(oReq.response);
                        }
                        else {
                            reject(Error(`Bad reply from ${msg.modulePath} in instance ${handle.id}`));
                        }
                    };
                    oReq.send();
                })
                    .then((bodyString) => {
                    // This is a terrible hack, I'm ashamed of myself.
                    // Better solutions are very much appreciated.
                    // tslint:disable-next-line:no-var-keyword
                    var f = null;
                    let fcn = `
						f = function() {
							${bodyString}
							;
							return ${msg.exportName}
						}
					`;
                    // tslint:disable-next-line:no-eval
                    let moduleClass = eval(fcn)();
                    f = f;
                    if (!moduleClass) {
                        throw Error(`${msg.exportName} not found in ${msg.modulePath}`);
                    }
                    return moduleClass;
                });
            }
            else {
                pModuleClass = Promise.resolve(require(msg.modulePath))
                    .then((module) => {
                    return module[msg.exportName];
                });
            }
            pModuleClass
                .then((moduleClass) => {
                if (!moduleClass) {
                    return Promise.reject('Failed to find class');
                }
                const handle = {
                    id: msg.instanceId,
                    cmdId: 0,
                    queue: {},
                    instance: null // Note: This is dangerous, but gets set right after.
                };
                const decodedArgs = this.decodeArgumentsFromParent(handle, msg.args);
                handle.instance = ((...args) => {
                    return new moduleClass(...args);
                }).apply(null, decodedArgs);
                this.instanceHandles[handle.id] = handle;
                const instance = handle.instance;
                const allProps = this.getAllProperties(instance);
                const props = [];
                allProps.forEach((prop) => {
                    if ([
                        'constructor',
                        '__defineGetter__',
                        '__defineSetter__',
                        'hasOwnProperty',
                        '__lookupGetter__',
                        '__lookupSetter__',
                        'isPrototypeOf',
                        'propertyIsEnumerable',
                        'toString',
                        'valueOf',
                        '__proto__',
                        'toLocaleString'
                    ].indexOf(prop) !== -1)
                        return;
                    let descriptor = Object.getOwnPropertyDescriptor(instance, prop);
                    let inProto = 0;
                    let proto = instance.__proto__;
                    while (!descriptor) {
                        if (!proto)
                            break;
                        descriptor = Object.getOwnPropertyDescriptor(proto, prop);
                        inProto++;
                        proto = proto.__proto__;
                    }
                    if (!descriptor)
                        descriptor = {};
                    let descr = {
                        // configurable:	!!descriptor.configurable,
                        inProto: inProto,
                        enumerable: !!descriptor.enumerable,
                        writable: !!descriptor.writable,
                        get: !!descriptor.get,
                        set: !!descriptor.set,
                        readable: !!(!descriptor.get && !descriptor.get) // if no getter or setter, ie an ordinary property
                    };
                    if (typeof instance[prop] === 'function') {
                        props.push({
                            key: prop,
                            type: sharedApi_1.InitPropType.FUNCTION,
                            descriptor: descr
                        });
                    }
                    else {
                        props.push({
                            key: prop,
                            type: sharedApi_1.InitPropType.VALUE,
                            descriptor: descr
                        });
                    }
                });
                this.replyToInstanceMessage(handle, msg, props);
                return;
            })
                .catch((err) => {
                const errStack = (0, lib_1.stripStack)(err.stack || err.toString(), [
                    /onMessageFromParent/,
                    /threadedclass-worker/
                ]);
                let errorResponse = `${errStack}\n executing constructor of instance "${m.instanceId}"`;
                this.replyInstanceError(handle, msg, errorResponse);
                return;
            });
            if (!m.config.disableMultithreading && !(0, lib_1.nodeSupportsWorkerThreads)()) {
                this.startOrphanMonitoring();
            }
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.PING) {
            // This is a message from the parent process. It's just a ping, used to check if this instance is alive.
            this.replyToInstanceMessage(handle, m, null);
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.REPLY) {
            // A reply to an earlier message.
            const msg = m;
            let cb = handle.queue[msg.replyTo + ''];
            if (!cb)
                throw Error(`cmdId "${msg.cmdId}" not found in instance ${m.instanceId}!`);
            if (msg.error) {
                cb.cb(msg.error);
            }
            else {
                cb.cb(null, msg.reply);
            }
            delete handle.queue[msg.replyTo + ''];
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.FUNCTION) {
            // A function/method has been called by the parent
            let msg = m;
            const fixedArgs = this.decodeArgumentsFromParent(handle, msg.args);
            let p;
            try {
                if (typeof instance[msg.fcn] === 'function') {
                    p = instance[msg.fcn](...fixedArgs);
                }
                else {
                    // in case instance[msg.fcn] does not exist, it will simply resolve to undefined
                    p = instance[msg.fcn];
                }
            }
            catch (error) {
                p = Promise.reject(error);
            }
            Promise.resolve(p)
                .then((result) => {
                const encodedResult = this.encodeArgumentsToParent(instance, [result]);
                this.replyToInstanceMessage(handle, msg, encodedResult[0]);
            })
                .catch((err) => {
                const errStack = (0, lib_1.stripStack)(err.stack || err.toString(), [
                    /onMessageFromParent/,
                    /threadedclass-worker/
                ]);
                let errorResponse = `${errStack}\n executing function "${msg.fcn}" of instance "${m.instanceId}"`;
                this.replyInstanceError(handle, msg, errorResponse);
            });
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.SET) {
            // A setter has been called by the parent
            let msg = m;
            const fixedValue = this.decodeArgumentsFromParent(handle, [msg.value])[0];
            instance[msg.property] = fixedValue;
            const encodedResult = this.encodeArgumentsToParent(instance, [fixedValue]);
            this.replyToInstanceMessage(handle, msg, encodedResult[0]);
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.KILL) {
            // A Kill-command has been sent by the parent.
            let msg = m;
            // kill off instance
            this.killInstance(handle);
            this.replyToInstanceMessage(handle, msg, null);
        }
        else if (m.cmd === sharedApi_1.Message.To.Instance.CommandType.CALLBACK) {
            // A callback has been called by the parent.
            // A "callback" is a function that has been sent to the parent process from the child instance.
            let msg = m;
            let callback = this.callbacks[msg.callbackId];
            if (callback) {
                try {
                    Promise.resolve(callback(...msg.args))
                        .then((result) => {
                        const encodedResult = this.encodeArgumentsToParent(instance, [result]);
                        this.replyToInstanceMessage(handle, msg, encodedResult[0]);
                    })
                        .catch((err) => {
                        let errorResponse = (err.stack || err.toString()) + `\n executing callback of instance "${m.instanceId}"`;
                        this.replyInstanceError(handle, msg, errorResponse);
                    });
                }
                catch (err) {
                    let errorResponse = (err.stack || err.toString()) + `\n executing (outer) callback of instance "${m.instanceId}"`;
                    this.replyInstanceError(handle, msg, errorResponse);
                }
            }
            else {
                this.replyInstanceError(handle, msg, `Callback "${msg.callbackId}" not found on instance "${m.instanceId}"`);
            }
        }
        else {
            (0, lib_1.assertNever)(m);
        }
    }
    handleChildMessageFromParent(m, handle) {
        if (m.cmd === sharedApi_1.Message.To.Child.CommandType.GET_MEM_USAGE) {
            let memUsage = (process ?
                process.memoryUsage() :
                // @ts-ignore web-worker global window
                window ?
                    // @ts-ignore web-worker global window
                    window.performance.memory :
                    { error: 'N/A' });
            const encodedResult = this.encodeArgumentsToParent({}, [memUsage])[0];
            this.replyToChildMessage(handle, m, encodedResult);
        }
    }
    startOrphanMonitoring() {
        if (this._config) {
            const pingTime = 5000;
            setInterval(() => {
                if (this._parentPid && !isRunning(this._parentPid)) {
                    console.log(`Parent pid ${this._parentPid} missing, exiting process!`);
                    setTimeout(() => {
                        process.exit(27);
                    }, 100);
                }
            }, pingTime);
        }
    }
}
exports.Worker = Worker;

}).call(this,require('_process'))

},{"../shared/lib":12,"../shared/sharedApi":13,"_process":22,"is-running":20}],4:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegisterExitHandlers = exports.ThreadedClassManager = void 0;
const tslib_1 = require("tslib");
const manager_1 = require("./parent-process/manager");
Object.defineProperty(exports, "ThreadedClassManager", { enumerable: true, get: function () { return manager_1.ThreadedClassManager; } });
Object.defineProperty(exports, "RegisterExitHandlers", { enumerable: true, get: function () { return manager_1.RegisterExitHandlers; } });
(0, tslib_1.__exportStar)(require("./api"), exports);
(0, tslib_1.__exportStar)(require("./parent-process/threadedClass"), exports);

},{"./api":1,"./parent-process/manager":5,"./parent-process/threadedClass":6,"tslib":23}],5:[function(require,module,exports){
(function (process){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThreadedClassManager = exports.ThreadedClassManagerInternal = exports.ThreadMode = exports.ThreadedClassManagerClassInternal = exports.childName = exports.ThreadedClassManagerClass = exports.RegisterExitHandlers = void 0;
const tslib_1 = require("tslib");
const sharedApi_1 = require("../shared/sharedApi");
const api_1 = require("../api");
const lib_1 = require("../shared/lib");
const webWorkers_1 = require("./workerPlatform/webWorkers");
const workerThreads_1 = require("./workerPlatform/workerThreads");
const childProcess_1 = require("./workerPlatform/childProcess");
const fakeWorker_1 = require("./workerPlatform/fakeWorker");
var RegisterExitHandlers;
(function (RegisterExitHandlers) {
    /**
     * Do a check if any exit handlers have been registered by someone else.
     * If not, will set up exit handlers to ensure child processes are killed on exit signal.
     */
    RegisterExitHandlers[RegisterExitHandlers["AUTO"] = -1] = "AUTO";
    /** Set up exit handlers to ensure child processes are killed on exit signal. */
    RegisterExitHandlers[RegisterExitHandlers["YES"] = 1] = "YES";
    /**
     * Don't set up any exit handlers (depending on your environment and Node version,
     * children might need to be manually killed).
     */
    RegisterExitHandlers[RegisterExitHandlers["NO"] = 0] = "NO";
})(RegisterExitHandlers = exports.RegisterExitHandlers || (exports.RegisterExitHandlers = {}));
class ThreadedClassManagerClass {
    constructor(internal) {
        this._internal = internal;
    }
    /** Enable debug messages */
    set debug(v) {
        this._internal.debug = v;
    }
    get debug() {
        return this._internal.debug;
    }
    /**
     * Enable strict mode.
     * When strict mode is enabled, checks will be done to ensure that best-practices are followed (such as listening to the proper events, etc).
     * Warnings will be output to the console if strict mode is enabled.
     */
    set strict(v) {
        this._internal.strict = v;
    }
    get strict() {
        return this._internal.strict;
    }
    /** Whether to register exit handlers. If not, then the application should ensure the threads are aborted on process exit */
    set handleExit(v) {
        this._internal.handleExit = v;
    }
    get handleExit() {
        return this._internal.handleExit;
    }
    /** Destroy a proxy class instance */
    destroy(proxy) {
        return this._internal.killProxy(proxy);
    }
    /** Destroys all proxy instances and closes all threads */
    destroyAll() {
        return this._internal.killAllChildren();
    }
    /** Returns the number of threads */
    getThreadCount() {
        return this._internal.getChildrenCount();
    }
    /** Returns memory usage for each thread */
    getThreadsMemoryUsage() {
        return this._internal.getMemoryUsage();
    }
    onEvent(proxy, event, cb) {
        return this._internal.onProxyEvent(proxy, event, cb);
    }
    /**
     * Restart the thread of the proxy instance
     * @param proxy
     * @param forceRestart If true, will kill the thread and restart it. If false, will only restart the thread if it is already dead.
     */
    restart(proxy, forceRestart) {
        return this._internal.restart(proxy, forceRestart);
    }
    /**
     * Returns a description of what threading mode the library will use in the current context.
     */
    getThreadMode() {
        if ((0, lib_1.isBrowser)()) {
            if ((0, lib_1.browserSupportsWebWorkers)()) {
                return ThreadMode.WEB_WORKER;
            }
            else {
                return ThreadMode.NOT_SUPPORTED;
            }
        }
        else {
            if ((0, lib_1.nodeSupportsWorkerThreads)()) {
                return ThreadMode.WORKER_THREADS;
            }
            else {
                return ThreadMode.CHILD_PROCESS;
            }
        }
    }
}
exports.ThreadedClassManagerClass = ThreadedClassManagerClass;
function childName(child) {
    return `Child_ ${Object.keys(child.instances).join(',')}`;
}
exports.childName = childName;
class ThreadedClassManagerClassInternal {
    constructor() {
        /** Set to true if you want to handle the exiting of child process yourselt */
        this.handleExit = RegisterExitHandlers.AUTO;
        this.isInitialized = false;
        this._threadId = 0;
        this._instanceId = 0;
        this._methodId = 0;
        this._children = {};
        this._pinging = true; // for testing only
        this.debug = false;
        this.strict = false;
        /** Pseudo-unique id to identify the parent ThreadedClass (for debugging) */
        this.uniqueId = Date.now() % 10000;
        /** Two-dimensional map, which maps Proxy -> event -> listener functions */
        this._proxyEventListeners = new Map();
        /** Contains a map of listeners, used to wait for a child to have been initialized */
        this._childInitializedListeners = new lib_1.ArrayMap();
    }
    findNextAvailableChild(config, pathToWorker) {
        this._init();
        let child = null;
        if (config.threadId) {
            child = this._children[config.threadId] || null;
        }
        else if (config.threadUsage) {
            child = this._findFreeChild(config.threadUsage);
        }
        if (!child) {
            // Create new child process:
            const newChild = {
                id: config.threadId || (`process_${this.uniqueId}_${this._threadId++}`),
                isNamed: !!config.threadId,
                pathToWorker: pathToWorker,
                process: this._createFork(config, pathToWorker),
                usage: config.threadUsage || 1,
                instances: {},
                methods: {},
                alive: true,
                isClosing: false,
                config,
                autoRestartFailCount: 0,
                autoRestartRetryTimeout: undefined,
                cmdId: 0,
                instanceMessageQueue: {},
                childMessageQueue: {},
                callbackId: 0,
                callbacks: {}
            };
            this._setupChildProcess(newChild);
            this._children[newChild.id] = newChild;
            child = newChild;
            if (this.debug)
                this.consoleLog(`New child: "${newChild.id}"`);
        }
        return child;
    }
    /**
     * Attach a proxy-instance to a child
     * @param child
     * @param proxy
     * @param onInstanceMessage
     */
    attachInstanceToChild(config, child, proxy, pathToModule, exportName, constructorArgs, onInstanceMessage) {
        const instance = {
            id: `instance_${this.uniqueId}_${this._instanceId++}` + (config.instanceName ? `_${config.instanceName}` : ''),
            child: child,
            proxy: proxy,
            usage: config.threadUsage,
            freezeLimit: config.freezeLimit,
            onMessageCallback: onInstanceMessage,
            pathToModule: pathToModule,
            exportName: exportName,
            constructorArgs: constructorArgs,
            initialized: false,
            config: config
        };
        child.instances[instance.id] = instance;
        if (this.debug)
            this.consoleLog(`Add instance "${instance.id}" to "${child.id}"`);
        return instance;
    }
    killProxy(proxy) {
        return new Promise((resolve, reject) => {
            let foundProxy = false;
            for (const childId of Object.keys(this._children)) {
                const child = this._children[childId];
                const instanceId = this.findProxyInstanceOfChild(child, proxy);
                if (instanceId) {
                    let instance = child.instances[instanceId];
                    foundProxy = true;
                    if (Object.keys(child.instances).length === 1) {
                        // if there is only one instance left, we can kill the child
                        this.killChild(childId, 'no instances left')
                            .then(resolve)
                            .catch(reject);
                    }
                    else {
                        const cleanup = () => {
                            delete child.instances[instanceId];
                        };
                        this.sendMessageToInstance(instance, {
                            cmd: sharedApi_1.Message.To.Instance.CommandType.KILL
                        }, () => {
                            cleanup();
                            resolve();
                        });
                        setTimeout(() => {
                            cleanup();
                            reject('Timeout: Kill child instance');
                        }, 1000);
                        if (instance.usage) {
                            child.usage -= instance.usage;
                        }
                    }
                    break;
                }
            }
            if (!foundProxy) {
                reject('killProxy: Proxy not found');
            }
        });
    }
    sendMessageToInstance(instance, messageConstr, cb) {
        try {
            if (!instance.child)
                throw new Error(`Instance ${instance.id} has been detached from child process`);
            if (!instance.child.alive)
                throw new Error(`Child process of instance ${instance.id} has been closed`);
            if (instance.child.isClosing)
                throw new Error(`Child process of instance ${instance.id} is closing`);
            const message = Object.assign(Object.assign({}, messageConstr), {
                messageType: 'instance',
                cmdId: instance.child.cmdId++,
                instanceId: instance.id
            });
            if (message.cmd !== sharedApi_1.Message.To.Instance.CommandType.INIT &&
                !instance.initialized)
                throw Error(`Child instance ${instance.id} is not initialized`);
            if (cb)
                instance.child.instanceMessageQueue[message.cmdId + ''] = cb;
            try {
                instance.child.process.send(message);
            }
            catch (e) {
                delete instance.child.instanceMessageQueue[message.cmdId + ''];
                if ((e.toString() || '').match(/circular structure/)) { // TypeError: Converting circular structure to JSON
                    throw new Error(`Unsupported attribute (circular structure) in instance ${instance.id}: ` + e.toString());
                }
                else {
                    throw e;
                }
            }
        }
        catch (e) {
            if (cb)
                cb(instance, (e.stack || e).toString());
            else
                throw e;
        }
    }
    sendMessageToChild(child, messageConstr, cb) {
        try {
            if (!child.alive)
                throw new Error(`Child process ${child.id} has been closed`);
            if (child.isClosing)
                throw new Error(`Child process  ${child.id} is closing`);
            const message = Object.assign(Object.assign({}, messageConstr), {
                messageType: 'child',
                cmdId: child.cmdId++
            });
            if (cb)
                child.childMessageQueue[message.cmdId + ''] = cb;
            try {
                child.process.send(message);
            }
            catch (e) {
                delete child.childMessageQueue[message.cmdId + ''];
                if ((e.toString() || '').match(/circular structure/)) { // TypeError: Converting circular structure to JSON
                    throw new Error(`Unsupported attribute (circular structure) in child ${child.id}: ` + e.toString());
                }
                else {
                    throw e;
                }
            }
        }
        catch (e) {
            if (cb)
                cb((e.stack || e).toString());
            else
                throw e;
        }
    }
    getChildrenCount() {
        return Object.keys(this._children).length;
    }
    getMemoryUsage() {
        return (0, tslib_1.__awaiter)(this, void 0, void 0, function* () {
            const memUsage = {};
            yield Promise.all(Object.keys(this._children).map((childId) => {
                return new Promise((resolve) => {
                    const child = this._children[childId];
                    this.sendMessageToChild(child, {
                        cmd: sharedApi_1.Message.To.Child.CommandType.GET_MEM_USAGE
                    }, (err, result0) => {
                        const result = result0 && (0, sharedApi_1.decodeArguments)(() => null, [result0], () => (() => Promise.resolve()))[0];
                        const o = Object.assign(Object.assign({}, (err ?
                            { error: err.toString() } :
                            result ?
                                result :
                                { error: 'unknown' })), { description: this.getChildDescriptor(child) });
                        memUsage[childId] = o;
                        resolve();
                    });
                });
            }));
            return memUsage;
        });
    }
    killAllChildren() {
        return Promise.all(Object.keys(this._children).map((id) => {
            const child = this._children[id];
            if (this.debug)
                this.consoleLog(`Killing child "${this.getChildDescriptor(child)}"`);
            return this.killChild(id, 'killAllChildren');
        })).then(() => {
            return;
        });
    }
    /** Restart the thread of a proxy instance */
    restart(proxy, forceRestart) {
        return (0, tslib_1.__awaiter)(this, void 0, void 0, function* () {
            let foundInstance;
            let foundChild;
            for (const child of Object.values(this._children)) {
                const foundInstanceId = this.findProxyInstanceOfChild(child, proxy);
                if (foundInstanceId) {
                    foundInstance = child.instances[foundInstanceId];
                    foundChild = child;
                    break;
                }
            }
            if (!foundChild)
                throw Error(`Child of proxy not found`);
            if (!foundInstance)
                throw Error(`Instance of proxy not found`);
            yield this.restartChild(foundChild, [foundInstance], forceRestart);
        });
    }
    restartChild(child, onlyInstances, forceRestart) {
        return (0, tslib_1.__awaiter)(this, void 0, void 0, function* () {
            if (child.alive && forceRestart) {
                yield this.killChild(child, 'restart child', false);
            }
            this.clearRestartTimeout(child);
            if (!child.alive) {
                // clear old process:
                child.process.removeAllListeners();
                // delete child.process
                Object.keys(child.instances).forEach((instanceId) => {
                    const instance = child.instances[instanceId];
                    instance.initialized = false;
                });
                // start new process
                child.alive = true;
                child.isClosing = false;
                child.process = this._createFork(child.config, child.pathToWorker);
                this._setupChildProcess(child);
            }
            let p = new Promise((resolve, reject) => {
                var _a;
                let timeout;
                if (child.config.restartTimeout !== 0) {
                    const restartTimeout = (_a = child.config.restartTimeout) !== null && _a !== void 0 ? _a : sharedApi_1.DEFAULT_RESTART_TIMEOUT;
                    timeout = setTimeout(() => {
                        reject(new api_1.RestartTimeoutError(`Timeout when trying to restart after ${restartTimeout}`));
                        // Remove listener:
                        this._childInitializedListeners.remove(child.id, onInit);
                    }, restartTimeout);
                }
                const onInit = () => {
                    if (timeout)
                        clearTimeout(timeout);
                    resolve();
                    // Remove listener:
                    this._childInitializedListeners.remove(child.id, onInit);
                };
                this._childInitializedListeners.push(child.id, onInit);
            });
            const promises = [p];
            let instances = (onlyInstances ||
                Object.keys(child.instances).map((instanceId) => {
                    return child.instances[instanceId];
                }));
            instances.forEach((instance) => {
                promises.push(new Promise((resolve, reject) => {
                    this.sendInit(child, instance, instance.config, (_instance, err) => {
                        // no need to do anything, the proxy is already initialized from earlier
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve();
                        }
                        return true;
                    });
                }));
            });
            yield Promise.all(promises);
        });
    }
    canRetryRestart(child) {
        var _a;
        const autoRestartRetryCount = (_a = child.config.autoRestartRetryCount) !== null && _a !== void 0 ? _a : sharedApi_1.DEFAULT_AUTO_RESTART_RETRY_COUNT;
        if (autoRestartRetryCount === 0)
            return true; // restart indefinitely
        return child.autoRestartFailCount < autoRestartRetryCount;
    }
    sendInit(child, instance, config, cb) {
        let encodedArgs = (0, sharedApi_1.encodeArguments)(instance, instance.child.callbacks, instance.constructorArgs, !!config.disableMultithreading);
        let msg = {
            cmd: sharedApi_1.Message.To.Instance.CommandType.INIT,
            modulePath: instance.pathToModule,
            exportName: instance.exportName,
            args: encodedArgs,
            config: config,
            parentPid: process.pid
        };
        instance.initialized = true;
        exports.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, (instance, e, initProps) => {
            if (!cb ||
                cb(instance, e, initProps)) {
                // Notify listeners that the instance is initialized:
                const listeners = this._childInitializedListeners.get(child.id);
                if (listeners) {
                    for (const listener of listeners) {
                        listener();
                    }
                }
            }
        });
    }
    startMonitoringChild(instance) {
        var _a;
        const pingTime = (_a = instance.freezeLimit) !== null && _a !== void 0 ? _a : sharedApi_1.DEFAULT_CHILD_FREEZE_TIME;
        if (pingTime === 0)
            return; // 0 disables the monitoring
        const monitorChild = () => {
            if (instance.child && instance.child.alive && this._pinging) {
                this._pingChild(instance, pingTime)
                    .then(() => {
                    // ping successful
                    // ping again later:
                    setTimeout(() => {
                        monitorChild();
                    }, pingTime);
                })
                    .catch(() => {
                    // Ping failed
                    if (instance.child &&
                        instance.child.alive &&
                        !instance.child.isClosing) {
                        // this.consoleLog(`Ping failed for Child "${instance.child.id }" of instance "${instance.id}"`)
                        this._childHasCrashed(instance.child, `Child process ("${this.getChildDescriptor(instance.child)}") of instance ${instance.id} ping timeout`);
                    }
                });
            }
        };
        setTimeout(() => {
            monitorChild();
        }, pingTime);
    }
    doMethod(child, methodName, cb) {
        // Return a promise that will execute the callback cb
        // but also put the promise in child.methods, so that the promise can be aborted
        // in the case of a child crash
        const methodId = 'm' + this._methodId++;
        const p = new Promise((resolve, reject) => {
            child.methods[methodId] = { methodName, resolve, reject };
            cb(resolve, reject);
        })
            .then((result) => {
            delete child.methods[methodId];
            return result;
        })
            .catch((error) => {
            delete child.methods[methodId];
            throw error;
        });
        return p;
    }
    getChildDescriptor(child) {
        return `${child.id} (${Object.keys(child.instances).join(', ')})`;
    }
    checkInstance(instance, errStack) {
        if (!this.strict)
            return;
        const getStack = () => {
            // strip first 2 lines of the stack:
            return `${errStack.stack}`.split('\n').slice(2).join('\n');
        };
        // Wait a little bit, to allow for the events to have been set up asynchronously in user-land:
        setTimeout(() => {
            // Ensure that error events are set up:
            const events = this._proxyEventListeners.get(instance.proxy);
            if (!events || events.arraySize('error') === 0) {
                this.consoleLog(`Warning: No listener for the 'error' event was registered,
Solve this by adding
ThreadedClassManager.onEvent(instance, 'error', (error) => {})
${getStack()}`);
            }
            if (!events || events.arraySize('warning') === 0) {
                this.consoleLog(`Warning: No listener for the 'warning' event was registered,
Solve this by adding
ThreadedClassManager.onEvent(instance, 'warning', (warning) => {})
${getStack()}`);
            }
            if (!instance.config.autoRestart) {
                if (!events || events.arraySize('thread_closed') === 0) {
                    this.consoleLog(`Warning: autoRestart is disabled and no listener for the 'thread_closed' event was registered.
Solve this by either set {autoRestart: true} in threadedClass() options, or set up an event listener to handle a restart:
use ThreadedClassManager.onEvent(instance, 'thread_closed', () => {})
at ${getStack()}`);
                }
            }
            else {
                if (!events || events.arraySize('restarted') === 0) {
                    this.consoleLog(`Warning: No listener for the 'restarted' event was registered.
It is recommended to set up an event listener for this, so you are aware of that an instance has been restarted:
use ThreadedClassManager.onEvent(instance, 'restarted', () => {})
${getStack()}`);
                }
            }
        }, 1);
    }
    onProxyEvent(proxy, event, cb) {
        let events = this._proxyEventListeners.get(proxy);
        if (!events)
            events = new lib_1.ArrayMap();
        events.push(event, cb);
        // Save changes:
        this._proxyEventListeners.set(proxy, events);
        return {
            stop: () => {
                const events = this._proxyEventListeners.get(proxy);
                if (!events)
                    return;
                events.remove(event, cb);
                // Save changes:
                if (events.size > 0) {
                    this._proxyEventListeners.set(proxy, events);
                }
                else {
                    this._proxyEventListeners.delete(proxy);
                }
            }
        };
    }
    _emitProxyEvent(child, event, ...args) {
        for (const instance of Object.values(child.instances)) {
            const events = this._proxyEventListeners.get(instance.proxy);
            if (events) {
                const listeners = events.get(event);
                if (listeners) {
                    for (const listener of listeners) {
                        try {
                            listener(...args);
                        }
                        catch (err) {
                            this.consoleLog(`Error in event listener for "${event}":`, err);
                        }
                    }
                }
            }
        }
    }
    /** Called before using internally */
    _init() {
        if (!this.isInitialized &&
            !(0, lib_1.isBrowser)() // in NodeJS
        ) {
            let registerExitHandlers;
            switch (this.handleExit) {
                case RegisterExitHandlers.YES:
                    registerExitHandlers = true;
                    break;
                case RegisterExitHandlers.AUTO:
                    if (process.listenerCount('exit') === 0 || process.listenerCount('uncaughtException') === 0 || process.listenerCount('unhandledRejection') === 0) {
                        this.consoleLog('Skipping exit handler registration as no exit handler is registered');
                        // If no listeners are registered,
                        // we don't want to change the default Node behaviours upon those signals
                        registerExitHandlers = false;
                    }
                    else {
                        registerExitHandlers = true;
                    }
                    break;
                default: // RegisterExitHandlers.NO
                    registerExitHandlers = false;
            }
            if (registerExitHandlers) {
                // Close the child processes upon exit:
                process.stdin.resume(); // so the program will not close instantly
                // Read about Node signals here:
                // https://nodejs.org/api/process.html#process_signal_events
                const onSignal = (signal, message) => {
                    let msg = `Signal "${signal}" event`;
                    if (message)
                        msg += ', ' + message;
                    if (process.listenerCount(signal) === 1) {
                        // If there is only one listener, that's us
                        // Log the error, it is the right thing to do.
                        console.error(msg);
                    }
                    else {
                        if (this.debug)
                            this.consoleLog(msg);
                    }
                    this.killAllChildren()
                        .catch(this.consoleError);
                    process.exit();
                };
                // Do something when app is closing:
                process.on('exit', (code) => onSignal('exit', `exit code: ${code}`));
                // catches ctrl+c event
                process.on('SIGINT', () => onSignal('SIGINT'));
                // Terminal windows closed
                process.on('SIGHUP', () => onSignal('SIGHUP'));
                process.on('SIGTERM', () => onSignal('SIGTERM'));
                // SIGKILL cannot have a listener attached
                // SIGSTOP cannot have a listener attached
                // catches "kill pid" (for example: nodemon restart)
                process.on('SIGUSR1', () => onSignal('SIGUSR1'));
                process.on('SIGUSR2', () => onSignal('SIGUSR2'));
                // catches uncaught exceptions
                process.on('uncaughtException', (message) => onSignal('uncaughtException', message.toString()));
                process.on('unhandledRejection', (message) => onSignal('unhandledRejection', message ? message.toString() : undefined));
            }
        }
        this.isInitialized = true;
    }
    _pingChild(instance, timeoutTime) {
        return new Promise((resolve, reject) => {
            let msg = {
                cmd: sharedApi_1.Message.To.Instance.CommandType.PING
            };
            const timeout = setTimeout(() => {
                reject(); // timeout
            }, timeoutTime);
            exports.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, (_instance, err) => {
                clearTimeout(timeout);
                if (!err) {
                    resolve();
                }
                else {
                    this.consoleError(err);
                    reject(err);
                }
            });
        });
    }
    _childHasCrashed(child, reason) {
        // Called whenever a fatal error with a child has been discovered
        this.rejectChildMethods(child, reason);
        if (!child.isClosing) {
            let shouldRestart = false;
            const restartInstances = [];
            Object.keys(child.instances).forEach((instanceId) => {
                const instance = child.instances[instanceId];
                if (instance.config.autoRestart) {
                    shouldRestart = true;
                    restartInstances.push(instance);
                }
            });
            if (shouldRestart) {
                this.restartChild(child, restartInstances, true)
                    .then(() => {
                    child.autoRestartFailCount = 0;
                    this._emitProxyEvent(child, 'restarted');
                })
                    .catch((err) => {
                    // The restart failed
                    child.autoRestartFailCount++;
                    // Try to restart it again:
                    if (this.canRetryRestart(child)) {
                        this._emitProxyEvent(child, 'warning', `Error when restarting child, trying again... Original error: ${err}`);
                        // Kill the child, so we can to restart it later:
                        this.killChild(child, 'error when restarting', false)
                            .catch((e) => {
                            this.consoleError(`Could not kill child: "${child.id}"`, e);
                        })
                            .then(() => {
                            var _a;
                            const autoRestartRetryDelay = (_a = child.config.autoRestartRetryDelay) !== null && _a !== void 0 ? _a : sharedApi_1.DEFAULT_AUTO_RESTART_RETRY_DELAY;
                            child.autoRestartRetryTimeout = setTimeout(() => {
                                this._childHasCrashed(child, `restart failed`);
                            }, autoRestartRetryDelay);
                        })
                            .catch((e) => {
                            this.consoleError(`Unknown error: "${child.id}"`, e);
                        });
                    }
                    else {
                        this._emitProxyEvent(child, 'error', err);
                        if (this.debug)
                            this.consoleError('Error when running restartChild()', err);
                        // Clean up the child:
                        this.killChild(child, 'timeout when restarting', true).catch((e) => {
                            this.consoleError(`Could not kill child: "${child.id}"`, e);
                        });
                    }
                });
            }
            else {
                // No instance wants to be restarted, make sure the child is killed then:
                if (child.alive) {
                    this.killChild(child, `child has crashed (${reason})`, false)
                        .catch((err) => {
                        this._emitProxyEvent(child, 'error', err);
                        if (this.debug)
                            this.consoleError('Error when running killChild()', err);
                    });
                }
            }
        }
    }
    clearRestartTimeout(child) {
        if (child.autoRestartRetryTimeout !== undefined) {
            clearTimeout(child.autoRestartRetryTimeout);
            child.autoRestartRetryTimeout = undefined;
        }
    }
    _createFork(config, pathToWorker) {
        if (config.disableMultithreading) {
            return new fakeWorker_1.FakeProcess();
        }
        else {
            if ((0, lib_1.isBrowser)()) {
                return (0, webWorkers_1.forkWebWorker)(pathToWorker);
            }
            else {
                // in NodeJS
                if ((0, lib_1.nodeSupportsWorkerThreads)()) {
                    return (0, workerThreads_1.forkWorkerThread)(pathToWorker);
                }
                else {
                    return (0, childProcess_1.forkChildProcess)(pathToWorker);
                }
            }
        }
    }
    _setupChildProcess(child) {
        child.process.on('close', () => {
            if (child.alive) {
                child.alive = false;
                this._emitProxyEvent(child, 'thread_closed');
                this._childHasCrashed(child, `Child process "${childName(child)}" was closed`);
            }
        });
        child.process.on('error', (err) => {
            this._emitProxyEvent(child, 'error', err);
            if (this.debug)
                this.consoleError('Error from child ' + child.id, err);
        });
        child.process.on('message', (message) => {
            if (message.messageType === 'child') {
                try {
                    this._onMessageFromChild(child, message);
                }
                catch (e) {
                    if (this.debug)
                        this.consoleError(`Error in onMessageCallback in child ${child.id}`, message, e);
                    throw e;
                }
            }
            else if (message.messageType === 'instance') {
                const instance = child.instances[message.instanceId];
                if (instance) {
                    try {
                        instance.onMessageCallback(instance, message);
                    }
                    catch (e) {
                        if (this.debug)
                            this.consoleError(`Error in onMessageCallback in instance ${instance.id}`, message, instance, e);
                        throw e;
                    }
                }
                else {
                    const err = new Error(`Instance "${message.instanceId}" not found. Received message "${message.messageType}" from child "${child.id}", "${childName(child)}"`);
                    this._emitProxyEvent(child, 'error', err);
                    if (this.debug)
                        this.consoleError(err);
                }
            }
            else {
                const err = new Error(`Unknown messageType "${message['messageType']}"!`);
                this._emitProxyEvent(child, 'error', err);
                if (this.debug)
                    this.consoleError(err);
            }
        });
    }
    _onMessageFromChild(child, message) {
        if (message.cmd === sharedApi_1.Message.From.Child.CommandType.LOG) {
            console.log(child.id, ...message.log);
        }
        else if (message.cmd === sharedApi_1.Message.From.Child.CommandType.REPLY) {
            let msg = message;
            let cb = child.childMessageQueue[msg.replyTo + ''];
            if (!cb)
                return;
            if (msg.error) {
                cb(msg.error);
            }
            else {
                cb(null, msg.reply);
            }
            delete child.instanceMessageQueue[msg.replyTo + ''];
        }
        else if (message.cmd === sharedApi_1.Message.From.Child.CommandType.CALLBACK) {
            // Callback function is called by worker
            let msg = message;
            let callback = child.callbacks[msg.callbackId];
            if (callback) {
                try {
                    Promise.resolve(callback(...msg.args))
                        .then((result) => {
                        let encodedResult = (0, sharedApi_1.encodeArguments)({}, child.callbacks, [result], !!child.process.isFakeProcess);
                        this._sendReplyToChild(child, msg.cmdId, undefined, encodedResult[0]);
                    })
                        .catch((err) => {
                        this._replyErrorToChild(child, msg, err);
                    });
                }
                catch (err) {
                    this._replyErrorToChild(child, msg, err);
                }
            }
            else
                throw Error(`callback "${msg.callbackId}" not found in child ${child.id}`);
        }
    }
    _replyErrorToChild(child, messageToReplyTo, error) {
        this._sendReplyToChild(child, messageToReplyTo.cmdId, error);
    }
    _sendReplyToChild(child, replyTo, error, reply, cb) {
        let msg = {
            cmd: sharedApi_1.Message.To.Child.CommandType.REPLY,
            replyTo: replyTo,
            reply: reply,
            error: error ? (error.stack || error).toString() : error
        };
        this.sendMessageToChild(child, msg, cb);
    }
    _findFreeChild(threadUsage) {
        let id = Object.keys(this._children).find((id) => {
            const child = this._children[id];
            if (!child.isNamed &&
                child.usage + threadUsage <= 1) {
                return true;
            }
            return false;
        });
        if (id) {
            const child = this._children[id];
            child.usage += threadUsage;
            return child;
        }
        return null;
    }
    killChild(idOrChild, reason, cleanUp = true) {
        return new Promise((resolve, reject) => {
            var _a;
            let child;
            if (typeof idOrChild === 'string') {
                const id = idOrChild;
                child = this._children[id];
                if (!child) {
                    reject(`killChild: Child ${id} not found`);
                    return;
                }
            }
            else {
                child = idOrChild;
            }
            if (this.debug)
                this.consoleLog(`Killing child ${child.id} due to: ${reason}`);
            if (child) {
                if (cleanUp) {
                    this.clearRestartTimeout(child);
                }
                if (!child.alive) {
                    if (cleanUp) {
                        delete this._children[child.id];
                    }
                    child.isClosing = false;
                    resolve();
                }
                else {
                    let timeout;
                    const killTimeout = (_a = child.config.killTimeout) !== null && _a !== void 0 ? _a : sharedApi_1.DEFAULT_KILL_TIMEOUT;
                    if (killTimeout !== 0) {
                        timeout = setTimeout(() => {
                            if (cleanUp) {
                                delete this._children[child.id];
                            }
                            reject(new api_1.KillTimeoutError(`Timeout: Kill child process "${child.id}"`));
                        }, killTimeout);
                    }
                    child.process.once('close', () => {
                        if (cleanUp) {
                            // Clean up:
                            Object.entries(child.instances).forEach(([instanceId, instance]) => {
                                // const instance = child.instances[instanceId]
                                // delete instance.child
                                delete child.instances[instanceId];
                                const events = this._proxyEventListeners.get(instance.proxy);
                                events === null || events === void 0 ? void 0 : events.clear();
                                this._proxyEventListeners.delete(instance.proxy);
                            });
                            delete this._children[child.id];
                        }
                        if (timeout) {
                            clearTimeout(timeout);
                        }
                        child.isClosing = false;
                        resolve();
                    });
                    if (!child.isClosing) {
                        child.isClosing = true;
                        child.process.kill();
                    }
                }
            }
        });
    }
    rejectChildMethods(child, reason) {
        Object.keys(child.methods).forEach((methodId) => {
            const method = child.methods[methodId];
            method.reject(Error(`Method "${method.methodName}()" aborted due to: ${reason}`));
        });
        child.methods = {};
    }
    /** trace to console.error */
    consoleError(...args) {
        console.error(`ThreadedClass Error (${this.uniqueId})`, ...args);
    }
    /** trace to console.log */
    consoleLog(...args) {
        console.log(`ThreadedClass (${this.uniqueId})`, ...args);
    }
    /** Look up which instance contains a proxy, and return its instanceId */
    findProxyInstanceOfChild(child, proxy) {
        for (const instanceId of Object.keys(child.instances)) {
            let instance = child.instances[instanceId];
            if (instance.proxy === proxy)
                return instanceId;
        }
        return undefined;
    }
}
exports.ThreadedClassManagerClassInternal = ThreadedClassManagerClassInternal;
var ThreadMode;
(function (ThreadMode) {
    /** Web-workers, in browser */
    ThreadMode["WEB_WORKER"] = "web_worker";
    /** Nothing, Web-workers not supported */
    ThreadMode["NOT_SUPPORTED"] = "not_supported";
    /** Worker threads */
    ThreadMode["WORKER_THREADS"] = "worker_threads";
    /** Child process */
    ThreadMode["CHILD_PROCESS"] = "child_process";
})(ThreadMode = exports.ThreadMode || (exports.ThreadMode = {}));
// Singleton:
exports.ThreadedClassManagerInternal = new ThreadedClassManagerClassInternal();
exports.ThreadedClassManager = new ThreadedClassManagerClass(exports.ThreadedClassManagerInternal);

}).call(this,require('_process'))

},{"../api":1,"../shared/lib":12,"../shared/sharedApi":13,"./workerPlatform/childProcess":8,"./workerPlatform/fakeWorker":9,"./workerPlatform/webWorkers":10,"./workerPlatform/workerThreads":11,"_process":22,"tslib":23}],6:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.threadedClass = void 0;
const path = require("path");
const callsites = require("callsites");
const lib_1 = require("../shared/lib");
const sharedApi_1 = require("../shared/sharedApi");
const manager_1 = require("./manager");
/**
 * Returns an asynchronous version of the provided class
 * @param orgModule Path to imported module (this is what is in the require('XX') function, or import {class} from 'XX'} )
 * @param orgExport Name of export in module
 * @param constructorArgs An array of arguments to be fed into the class constructor
 */
function threadedClass(orgModule, orgExport, constructorArgs, configOrg = {}) {
    let exportName = orgExport;
    /** Used to  extrack the original stack */
    const errStack = new Error();
    if (typeof orgModule !== 'string')
        throw new Error('threadedClass parameter orgModule must be a string!');
    if (typeof orgExport !== 'string')
        throw new Error('threadedClass parameter orgExport must be a string!');
    const config = Object.assign(Object.assign({}, configOrg), { instanceName: configOrg.instanceName || orgExport // Default to the export class name
     });
    if ((0, lib_1.isBrowser)()) {
        if (!config.pathToWorker) {
            throw Error('config.pathToWorker is required in browser');
        }
        if (!(0, lib_1.browserSupportsWebWorkers)()) {
            console.log('Web-workers not supported, disabling multi-threading');
            config.disableMultithreading = true;
        }
    }
    let parentCallPath = callsites()[1].getFileName();
    let thisCallPath = callsites()[0].getFileName();
    return new Promise((resolve, reject) => {
        function sendFcn(instance, fcn, args, cb) {
            let msg = {
                cmd: sharedApi_1.Message.To.Instance.CommandType.FUNCTION,
                fcn: fcn,
                args: args
            };
            manager_1.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, cb);
        }
        function sendSet(instance, property, value, cb) {
            let msg = {
                cmd: sharedApi_1.Message.To.Instance.CommandType.SET,
                property: property,
                value: value
            };
            manager_1.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, cb);
        }
        function sendReplyToInstance(instance, replyTo, error, reply, cb) {
            let msg = {
                cmd: sharedApi_1.Message.To.Instance.CommandType.REPLY,
                replyTo: replyTo,
                reply: reply,
                error: error ? (error.stack || error).toString() : error
            };
            manager_1.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, cb);
        }
        function replyError(instance, msg, error) {
            sendReplyToInstance(instance, msg.cmdId, error);
        }
        function sendCallback(instance, callbackId, args, cb) {
            let msg = {
                cmd: sharedApi_1.Message.To.Instance.CommandType.CALLBACK,
                callbackId: callbackId,
                args: args
            };
            manager_1.ThreadedClassManagerInternal.sendMessageToInstance(instance, msg, cb);
        }
        function decodeResultFromWorker(instance, encodedResult) {
            return (0, sharedApi_1.decodeArguments)(() => instance.proxy, [encodedResult], (a) => {
                return (...args) => {
                    return new Promise((resolve, reject) => {
                        // Function result function is called from parent
                        sendCallback(instance, a.value, args, (_instance, err, encodedResult) => {
                            // Function result is returned from worker
                            if (err) {
                                reject(err);
                            }
                            else {
                                let result = decodeResultFromWorker(_instance, encodedResult);
                                resolve(result);
                            }
                        });
                    });
                };
            })[0];
        }
        function onMessageFromInstance(instance, m) {
            if (m.cmd === sharedApi_1.Message.From.Instance.CommandType.REPLY) {
                let msg = m;
                const child = instance.child;
                let cb = child.instanceMessageQueue[msg.replyTo + ''];
                if (!cb)
                    return;
                if (msg.error) {
                    cb(instance, msg.error);
                }
                else {
                    cb(instance, null, msg.reply);
                }
                delete child.instanceMessageQueue[msg.replyTo + ''];
            }
            else if (m.cmd === sharedApi_1.Message.From.Instance.CommandType.CALLBACK) {
                // Callback function is called by worker
                let msg = m;
                let callback = instance.child.callbacks[msg.callbackId];
                if (callback) {
                    try {
                        Promise.resolve(callback(...msg.args))
                            .then((result) => {
                            let encodedResult = (0, sharedApi_1.encodeArguments)(instance, instance.child.callbacks, [result], !!config.disableMultithreading);
                            sendReplyToInstance(instance, msg.cmdId, undefined, encodedResult[0]);
                        })
                            .catch((err) => {
                            replyError(instance, msg, err);
                        });
                    }
                    catch (err) {
                        replyError(instance, msg, err);
                    }
                }
                else
                    throw Error(`callback "${msg.callbackId}" not found in instance ${m.instanceId}`);
            }
        }
        try {
            let pathToModule = '';
            let pathToWorker = '';
            if ((0, lib_1.isBrowser)()) {
                pathToWorker = config.pathToWorker;
                pathToModule = orgModule;
            }
            else {
                if (!parentCallPath)
                    throw new Error('Unable to resolve parent file path');
                if (!thisCallPath)
                    throw new Error('Unable to resolve own file path');
                let absPathToModule = (orgModule.match(/^\./) ?
                    path.resolve(parentCallPath, '../', orgModule) :
                    orgModule);
                pathToModule = require.resolve(absPathToModule);
                pathToWorker = thisCallPath
                    .replace(/parent-process/, 'child-process')
                    .replace(/threadedClass(\.[tj]s)$/, 'threadedclass-worker.js')
                    .replace(/src([\\\/])child-process([\\\/])threadedclass-worker/, 'dist$1child-process$2threadedclass-worker');
            }
            const child = manager_1.ThreadedClassManagerInternal.findNextAvailableChild(config, pathToWorker);
            const proxy = {};
            let instanceInChild = manager_1.ThreadedClassManagerInternal.attachInstanceToChild(config, child, proxy, pathToModule, exportName, constructorArgs, onMessageFromInstance);
            manager_1.ThreadedClassManagerInternal.sendInit(child, instanceInChild, config, (instance, err, props) => {
                // This callback is called from the child process, with a list of supported properties of the instance
                if (err) {
                    reject(err);
                    return false;
                }
                else {
                    props.forEach((p) => {
                        if (!instance.child.alive)
                            throw Error(`Child process of instance ${instance.id} has been closed`);
                        if (proxy.hasOwnProperty(p.key)) {
                            return;
                        }
                        if (p.type === sharedApi_1.InitPropType.FUNCTION) {
                            const callMethod = (...args) => {
                                // An instance method is called by parent
                                const originalError = new Error();
                                if (!instance.child)
                                    return Promise.reject(new Error(`Instance ${instance.id} has been detached from child process`));
                                return manager_1.ThreadedClassManagerInternal.doMethod(instance.child, p.key, (resolve, reject) => {
                                    if (!instance.child)
                                        throw new Error(`Instance ${instance.id} has been detached from child process`);
                                    // Go through arguments and serialize them:
                                    let encodedArgs = (0, sharedApi_1.encodeArguments)(instance, instance.child.callbacks, args, !!config.disableMultithreading);
                                    sendFcn(instance, p.key, encodedArgs, (_instance, err, encodedResult) => {
                                        // Function result is returned from child instance
                                        if (err) {
                                            err = (0, lib_1.combineErrorStacks)(err, 'Original stack (on parent):', originalError.stack || '');
                                            reject(err);
                                        }
                                        else {
                                            let result = decodeResultFromWorker(_instance, encodedResult);
                                            resolve(result);
                                        }
                                    });
                                });
                            };
                            // @ts-ignore
                            proxy[p.key] = callMethod;
                        }
                        else if (p.type === sharedApi_1.InitPropType.VALUE) {
                            let m = {
                                configurable: false,
                                enumerable: p.descriptor.enumerable
                                // writable: // We handle everything through getters & setters instead
                            };
                            if (p.descriptor.get ||
                                p.descriptor.readable) {
                                m.get = function () {
                                    return new Promise((resolve, reject) => {
                                        sendFcn(instance, p.key, [], (_instance, err, encodedResult) => {
                                            if (err) {
                                                reject(err);
                                            }
                                            else {
                                                let result = decodeResultFromWorker(_instance, encodedResult);
                                                resolve(result);
                                            }
                                        });
                                    });
                                };
                            }
                            if (p.descriptor.set ||
                                p.descriptor.writable) {
                                m.set = function (newVal) {
                                    let fixedArgs = (0, sharedApi_1.encodeArguments)(instance, instance.child.callbacks, [newVal], !!config.disableMultithreading);
                                    // in the strictest of worlds, we should block the main thread here,
                                    // until the remote acknowledges the write.
                                    // Instead we're going to pretend that everything is okay. *whistling*
                                    sendSet(instance, p.key, fixedArgs[0], (_instance, err, _result) => {
                                        if (err) {
                                            console.log('Error in setter', err);
                                            proxy.__uncaughtError = err;
                                        }
                                    });
                                };
                            }
                            Object.defineProperty(proxy, p.key, m);
                        }
                    });
                    manager_1.ThreadedClassManagerInternal.startMonitoringChild(instanceInChild);
                    resolve(proxy);
                    manager_1.ThreadedClassManagerInternal.checkInstance(instanceInChild, errStack);
                    return true;
                }
            });
        }
        catch (e) {
            reject(e);
        }
    });
}
exports.threadedClass = threadedClass;

},{"../shared/lib":12,"../shared/sharedApi":13,"./manager":5,"callsites":17,"path":21}],7:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerPlatformBase = void 0;
const eventemitter3_1 = require("eventemitter3");
/** A sub-class of WorkerPlatformBase handles the communication with a child process */
class WorkerPlatformBase extends eventemitter3_1.EventEmitter {
    constructor() {
        super(...arguments);
        this._isFakeProcess = false;
    }
    get isFakeProcess() {
        return this._isFakeProcess;
    }
}
exports.WorkerPlatformBase = WorkerPlatformBase;

},{"eventemitter3":18}],8:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forkChildProcess = exports.ChildProcessWorker = void 0;
const child_process_1 = require("child_process");
const _base_1 = require("./_base");
class ChildProcessWorker extends _base_1.WorkerPlatformBase {
    constructor(path) {
        super();
        this.worker = (0, child_process_1.fork)(path);
        this.worker.on('message', (m) => this.emit('message', m));
        this.worker.on('close', () => this.emit('close'));
        this.worker.on('error', (e) => this.emit('error', e));
    }
    kill() {
        this.worker.kill();
    }
    send(m) {
        this.worker.send(m);
    }
}
exports.ChildProcessWorker = ChildProcessWorker;
function forkChildProcess(pathToWorker) {
    return new ChildProcessWorker(pathToWorker);
}
exports.forkChildProcess = forkChildProcess;

},{"./_base":7,"child_process":15}],9:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FakeProcess = void 0;
const _base_1 = require("./_base");
const fake_worker_1 = require("../../child-process/fake-worker");
class FakeProcess extends _base_1.WorkerPlatformBase {
    constructor() {
        super();
        this._isFakeProcess = true;
        this.worker = new fake_worker_1.FakeWorker((m) => {
            this.emit('message', m);
        });
    }
    kill() {
        // @todo: needs some implementation.
        this.emit('close');
    }
    send(m) {
        this.worker.onMessageFromParent(m);
    }
}
exports.FakeProcess = FakeProcess;

},{"../../child-process/fake-worker":2,"./_base":7}],10:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forkWebWorker = exports.WebWorkerProcess = void 0;
const _base_1 = require("./_base");
/** Functions for emulating child-process in web-workers */
class WebWorkerProcess extends _base_1.WorkerPlatformBase {
    constructor(pathToWorker) {
        super();
        try {
            // @ts-ignore
            this.worker = new window.Worker(pathToWorker);
            this.worker.onmessage = (message) => {
                if (message.type === 'message') {
                    this.emit('message', message.data);
                }
                else
                    console.log('unknown message type', message);
            };
            this.worker.onmessageerror = (error) => {
                this.emit('error', error);
            };
            this.worker.onerror = (error) => {
                this.emit('error', error);
            };
        }
        catch (error) {
            let str = (error.stack || error).toString() + '';
            if (str.match(/cannot be accessed from origin/) &&
                str.match(/file:\/\//)) {
                throw Error('Unable to create Web-Worker. Not allowed to run from local file system.\n' + str);
            }
            else {
                throw error;
            }
        }
        // this.worker.postMessage([first.value,second.value]); // Sending message as an array to the worker
    }
    kill() {
        this.worker.terminate();
        this.emit('close');
    }
    send(message) {
        this.worker.postMessage(message);
    }
}
exports.WebWorkerProcess = WebWorkerProcess;
function forkWebWorker(pathToWorker) {
    return new WebWorkerProcess(pathToWorker);
}
exports.forkWebWorker = forkWebWorker;

},{"./_base":7}],11:[function(require,module,exports){
(function (process,__dirname){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forkWorkerThread = exports.WorkerThread = void 0;
const lib_1 = require("../../shared/lib");
const _base_1 = require("./_base");
const fs_1 = require("fs");
const path = require("path");
const WorkerThreads = (0, lib_1.getWorkerThreads)();
const DEFAULT_ELECTRON_LOADER = path.join(__dirname, '../../js/asar-loader.js');
const isInAsar = Object.prototype.hasOwnProperty.call(process.versions, 'electron') && DEFAULT_ELECTRON_LOADER.match(/.asar(\/|\\)/);
/** Functions for spawning worker-threads in NodeJS */
class WorkerThread extends _base_1.WorkerPlatformBase {
    constructor(pathToWorker) {
        super();
        // @ts-ignore
        // this.worker = new window.Worker(pathToWorker)
        if (!WorkerThreads)
            throw new Error('Unable to create Worker thread! Not supported!');
        // Figure out the loader to use. This is to allow for some environment setup (eg require behaviour modification) before trying to run threadedClass
        let loader = process.env.THREADEDCLASS_WORKERTHREAD_LOADER;
        if (!loader && isInAsar) {
            loader = DEFAULT_ELECTRON_LOADER;
        }
        if (loader) {
            // The WorkerThreads may will not be able to load this file, so we must do it in the parent
            const buf = (0, fs_1.readFileSync)(loader);
            // Start the WorkerThread, passing pathToWorker so that the loader knows what it should execute
            this.worker = new WorkerThreads.Worker(buf.toString(), {
                workerData: pathToWorker,
                eval: true
            });
        }
        else {
            // No loader, so run the worker directly
            this.worker = new WorkerThreads.Worker(pathToWorker, {
                workerData: ''
            });
        }
        this.worker.on('message', (message) => {
            this.emit('message', message);
            // if (message.type === 'message') {
            // } else console.log('unknown message type', message)
        });
        this.worker.on('messageerror', (error) => {
            this.emit('error', error);
        });
        this.worker.on('error', (error) => {
            this.emit('error', error);
        });
        this.worker.on('exit', (_code) => {
            this.emit('close');
        });
        this.worker.on('close', () => {
            this.emit('close');
        });
    }
    kill() {
        const p = this.worker.terminate();
        if (p) {
            p.then(() => {
                this.emit('close');
            }).catch((err) => {
                console.error('Worker Thread terminate failed', err);
            });
        }
        else {
            // If it didnt return a promise, then it as a blocking operation
            this.emit('close');
        }
    }
    send(message) {
        this.worker.postMessage(message);
    }
}
exports.WorkerThread = WorkerThread;
function forkWorkerThread(pathToWorker) {
    return new WorkerThread(pathToWorker);
}
exports.forkWorkerThread = forkWorkerThread;

}).call(this,require('_process'),"/dist/parent-process/workerPlatform")

},{"../../shared/lib":12,"./_base":7,"_process":22,"fs":15,"path":21}],12:[function(require,module,exports){
(function (process){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArrayMap = exports.combineErrorStacks = exports.stripStack = exports.getErrorStack = exports.assertNever = exports.getWorkerThreads = exports.nodeSupportsWorkerThreads = exports.browserSupportsWebWorkers = exports.isBrowser = void 0;
/**
 * Returns true if running in th browser (if not, then we're in NodeJS)
 */
function isBrowser() {
    return !(process && process.hasOwnProperty('stdin'));
}
exports.isBrowser = isBrowser;
function browserSupportsWebWorkers() {
    // @ts-ignore
    return !!(isBrowser() && window.Worker);
}
exports.browserSupportsWebWorkers = browserSupportsWebWorkers;
function nodeSupportsWorkerThreads() {
    const workerThreads = getWorkerThreads();
    return !!workerThreads;
}
exports.nodeSupportsWorkerThreads = nodeSupportsWorkerThreads;
function getWorkerThreads() {
    try {
        const workerThreads = require('worker_threads');
        return workerThreads;
    }
    catch (e) {
        return null;
    }
}
exports.getWorkerThreads = getWorkerThreads;
/**
 * Helper function to simply assert that the value is of the type never.
 * Usage: at the end of if/else or switch, to ensure that there is no fallthrough.
 */
function assertNever(_value) {
    // does nothing
}
exports.assertNever = assertNever;
function getErrorStack(err) {
    if (typeof err === 'object') {
        const stack = err.stack;
        if (stack)
            return stack;
        return `${err}`;
    }
    else {
        return `${err}`;
    }
}
exports.getErrorStack = getErrorStack;
function stripStack(stack, matchLines) {
    if (!stack)
        return stack;
    const stackLines = stack.split('\n');
    let matchIndex = -1;
    for (let i = 0; i < stackLines.length; i++) {
        let matching = false;
        for (const line of matchLines) {
            if (stackLines[i] && stackLines[i].match(line)) {
                if (matchIndex === -1)
                    matchIndex = i;
                matching = true;
                i += 1;
            }
            else {
                matching = false;
                break;
            }
        }
        if (matching) {
            return stackLines.slice(0, matchIndex).join('\n');
        }
    }
    // else, return the original:
    return stack;
}
exports.stripStack = stripStack;
function combineErrorStacks(orgError, ...stacks) {
    if (typeof orgError === 'object') {
        const err = new Error(orgError.message);
        err.stack = combineErrorStacks(`${orgError.stack}`, ...stacks);
        return err;
    }
    else {
        return orgError + '\n' + stacks.join('\n');
    }
}
exports.combineErrorStacks = combineErrorStacks;
/** A specific type of Map which contains an array of values */
class ArrayMap extends Map {
    constructor() {
        super();
    }
    /** Appends new elements to the end of an array, and returns the new length of the array.  */
    push(key, value) {
        const arr = this.get(key);
        if (!arr) {
            this.set(key, [value]);
            return 1;
        }
        else {
            arr.push(value);
            return arr.length;
        }
    }
    /** Removes an element from the array, returns true if the element was found and removed */
    remove(key, value) {
        let removedSomething = false;
        const arr = this.get(key);
        if (arr) {
            const index = arr.indexOf(value);
            if (index !== -1) {
                arr.splice(index, 1);
                removedSomething = true;
            }
            if (arr.length === 0) {
                this.delete(key);
            }
        }
        return removedSomething;
    }
    arraySize(key) {
        var _a, _b;
        return (_b = (_a = this.get(key)) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
    }
    /** The total number of elements in all of the arrays  */
    get totalSize() {
        let total = 0;
        for (const arr of this.values()) {
            total += arr.length;
        }
        return total;
    }
}
exports.ArrayMap = ArrayMap;

}).call(this,require('_process'))

},{"_process":22,"worker_threads":undefined}],13:[function(require,module,exports){
(function (Buffer){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeArguments = exports.encodeArguments = exports.Message = exports.InitPropType = exports.DEFAULT_AUTO_RESTART_RETRY_DELAY = exports.DEFAULT_AUTO_RESTART_RETRY_COUNT = exports.DEFAULT_KILL_TIMEOUT = exports.DEFAULT_RESTART_TIMEOUT = exports.DEFAULT_CHILD_FREEZE_TIME = void 0;
// This file contains definitions for the API between the child and parent process.
exports.DEFAULT_CHILD_FREEZE_TIME = 1000; // how long to wait before considering a child to be unresponsive
exports.DEFAULT_RESTART_TIMEOUT = 1000; // how long to wait for the child to come back after restart
exports.DEFAULT_KILL_TIMEOUT = 1000; // how long to wait for the thread to close when terminating it
exports.DEFAULT_AUTO_RESTART_RETRY_COUNT = 1; // after how many failed restarts to give up
exports.DEFAULT_AUTO_RESTART_RETRY_DELAY = 1000; // how long to wait before retrying a failed restart
var InitPropType;
(function (InitPropType) {
    InitPropType["FUNCTION"] = "function";
    InitPropType["VALUE"] = "value";
})(InitPropType = exports.InitPropType || (exports.InitPropType = {}));
// Messages to/from child instances ------------------------------------------------
/** Definitions of all messages between the child and parent */
var Message;
(function (Message) {
    /** Containes definitions of messages sent from the parent process */
    let To;
    (function (To) {
        /** Defines messages sent from the parent process to the child instance */
        let Instance;
        (function (Instance) {
            let CommandType;
            (function (CommandType) {
                CommandType["INIT"] = "init";
                CommandType["PING"] = "ping";
                CommandType["FUNCTION"] = "fcn";
                CommandType["REPLY"] = "reply";
                CommandType["SET"] = "set";
                CommandType["KILL"] = "kill";
                CommandType["CALLBACK"] = "callback";
            })(CommandType = Instance.CommandType || (Instance.CommandType = {}));
        })(Instance = To.Instance || (To.Instance = {}));
        /** Defines messages sent from the parent process to the child process */
        let Child;
        (function (Child) {
            let CommandType;
            (function (CommandType) {
                CommandType["GET_MEM_USAGE"] = "get_mem_usage";
                CommandType["REPLY"] = "reply";
            })(CommandType = Child.CommandType || (Child.CommandType = {}));
        })(Child = To.Child || (To.Child = {}));
    })(To = Message.To || (Message.To = {}));
    /** Containes definitions of messages sent from the child process */
    let From;
    (function (From) {
        /** Defines messages sent from the child instance to the parent process */
        let Instance;
        (function (Instance) {
            let CommandType;
            (function (CommandType) {
                CommandType["CALLBACK"] = "callback";
                CommandType["REPLY"] = "reply";
            })(CommandType = Instance.CommandType || (Instance.CommandType = {}));
        })(Instance = From.Instance || (From.Instance = {}));
        /** Defines messages sent from the child process to the parent process */
        let Child;
        (function (Child) {
            let CommandType;
            (function (CommandType) {
                CommandType["LOG"] = "log";
                CommandType["REPLY"] = "reply";
                CommandType["CALLBACK"] = "callback";
            })(CommandType = Child.CommandType || (Child.CommandType = {}));
        })(Child = From.Child || (From.Child = {}));
    })(From = Message.From || (Message.From = {}));
})(Message = exports.Message || (exports.Message = {}));
var ArgumentType;
(function (ArgumentType) {
    ArgumentType["STRING"] = "string";
    ArgumentType["NUMBER"] = "number";
    ArgumentType["UNDEFINED"] = "undefined";
    ArgumentType["NULL"] = "null";
    ArgumentType["OBJECT"] = "object";
    ArgumentType["FUNCTION"] = "function";
    ArgumentType["BUFFER"] = "buffer";
    ArgumentType["OTHER"] = "other";
})(ArgumentType || (ArgumentType = {}));
let argumentsCallbackId = 0;
function encodeArguments(instance, callbacks, args, disabledMultithreading) {
    try {
        return args.map((arg, i) => {
            try {
                if (typeof arg === 'object' && arg === instance) {
                    return { type: ArgumentType.OBJECT, value: 'self' };
                }
                if (disabledMultithreading) {
                    // In single-threaded mode, we can send the arguments directly, without any conversion:
                    if (arg instanceof Buffer)
                        return { type: ArgumentType.BUFFER, original: arg, value: null };
                    if (typeof arg === 'object')
                        return { type: ArgumentType.OBJECT, original: arg, value: null };
                }
                if (arg instanceof Buffer)
                    return { type: ArgumentType.BUFFER, value: arg.toString('hex') };
                if (typeof arg === 'string')
                    return { type: ArgumentType.STRING, value: arg };
                if (typeof arg === 'number')
                    return { type: ArgumentType.NUMBER, value: arg };
                if (typeof arg === 'function') {
                    // have we seen this one before?
                    for (const id in callbacks) {
                        if (callbacks[id] === arg) {
                            return { type: ArgumentType.FUNCTION, value: id + '' };
                        }
                    }
                    // new function, so add it to our list
                    const callbackId = argumentsCallbackId++;
                    callbacks[callbackId + ''] = arg;
                    return { type: ArgumentType.FUNCTION, value: callbackId + '' };
                }
                if (arg === undefined)
                    return { type: ArgumentType.UNDEFINED, value: arg };
                if (arg === null)
                    return { type: ArgumentType.NULL, value: arg };
                if (typeof arg === 'object')
                    return { type: ArgumentType.OBJECT, value: arg };
                return { type: ArgumentType.OTHER, value: arg };
            }
            catch (e) {
                if (e.stack)
                    e.stack += '\nIn encodeArguments, argument ' + i;
                throw e;
            }
        });
    }
    catch (e) {
        if (e.stack)
            e.stack += '\nThreadedClass, unsupported attribute';
        throw e;
    }
}
exports.encodeArguments = encodeArguments;
function decodeArguments(instance, args, getCallback) {
    // Go through arguments and de-serialize them
    return args.map((a) => {
        if (a.original !== undefined)
            return a.original;
        if (a.type === ArgumentType.STRING)
            return a.value;
        if (a.type === ArgumentType.NUMBER)
            return a.value;
        if (a.type === ArgumentType.BUFFER)
            return Buffer.from(a.value, 'hex');
        if (a.type === ArgumentType.UNDEFINED)
            return a.value;
        if (a.type === ArgumentType.NULL)
            return a.value;
        if (a.type === ArgumentType.FUNCTION) {
            return getCallback(a);
        }
        if (a.type === ArgumentType.OBJECT) {
            if (a.value === 'self') {
                return instance();
            }
            else {
                return a.value;
            }
        }
        return a.value;
    });
}
exports.decodeArguments = decodeArguments;

}).call(this,require("buffer").Buffer)

},{"buffer":16}],14:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],15:[function(require,module,exports){

},{}],16:[function(require,module,exports){
(function (Buffer){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this,require("buffer").Buffer)

},{"base64-js":14,"buffer":16,"ieee754":19}],17:[function(require,module,exports){
'use strict';

const callsites = () => {
	const _prepareStackTrace = Error.prepareStackTrace;
	Error.prepareStackTrace = (_, stack) => stack;
	const stack = new Error().stack.slice(1);
	Error.prepareStackTrace = _prepareStackTrace;
	return stack;
};

module.exports = callsites;
// TODO: Remove this for the next major release
module.exports.default = callsites;

},{}],18:[function(require,module,exports){
'use strict';

var has = Object.prototype.hasOwnProperty
  , prefix = '~';

/**
 * Constructor to create a storage for our `EE` objects.
 * An `Events` instance is a plain object whose properties are event names.
 *
 * @constructor
 * @private
 */
function Events() {}

//
// We try to not inherit from `Object.prototype`. In some engines creating an
// instance in this way is faster than calling `Object.create(null)` directly.
// If `Object.create(null)` is not supported we prefix the event names with a
// character to make sure that the built-in object properties are not
// overridden or used as an attack vector.
//
if (Object.create) {
  Events.prototype = Object.create(null);

  //
  // This hack is needed because the `__proto__` property is still inherited in
  // some old browsers like Android 4, iPhone 5.1, Opera 11 and Safari 5.
  //
  if (!new Events().__proto__) prefix = false;
}

/**
 * Representation of a single event listener.
 *
 * @param {Function} fn The listener function.
 * @param {*} context The context to invoke the listener with.
 * @param {Boolean} [once=false] Specify if the listener is a one-time listener.
 * @constructor
 * @private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Add a listener for a given event.
 *
 * @param {EventEmitter} emitter Reference to the `EventEmitter` instance.
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} context The context to invoke the listener with.
 * @param {Boolean} once Specify if the listener is a one-time listener.
 * @returns {EventEmitter}
 * @private
 */
function addListener(emitter, event, fn, context, once) {
  if (typeof fn !== 'function') {
    throw new TypeError('The listener must be a function');
  }

  var listener = new EE(fn, context || emitter, once)
    , evt = prefix ? prefix + event : event;

  if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
  else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
  else emitter._events[evt] = [emitter._events[evt], listener];

  return emitter;
}

/**
 * Clear event by name.
 *
 * @param {EventEmitter} emitter Reference to the `EventEmitter` instance.
 * @param {(String|Symbol)} evt The Event name.
 * @private
 */
function clearEvent(emitter, evt) {
  if (--emitter._eventsCount === 0) emitter._events = new Events();
  else delete emitter._events[evt];
}

/**
 * Minimal `EventEmitter` interface that is molded against the Node.js
 * `EventEmitter` interface.
 *
 * @constructor
 * @public
 */
function EventEmitter() {
  this._events = new Events();
  this._eventsCount = 0;
}

/**
 * Return an array listing the events for which the emitter has registered
 * listeners.
 *
 * @returns {Array}
 * @public
 */
EventEmitter.prototype.eventNames = function eventNames() {
  var names = []
    , events
    , name;

  if (this._eventsCount === 0) return names;

  for (name in (events = this._events)) {
    if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
  }

  if (Object.getOwnPropertySymbols) {
    return names.concat(Object.getOwnPropertySymbols(events));
  }

  return names;
};

/**
 * Return the listeners registered for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Array} The registered listeners.
 * @public
 */
EventEmitter.prototype.listeners = function listeners(event) {
  var evt = prefix ? prefix + event : event
    , handlers = this._events[evt];

  if (!handlers) return [];
  if (handlers.fn) return [handlers.fn];

  for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
    ee[i] = handlers[i].fn;
  }

  return ee;
};

/**
 * Return the number of listeners listening to a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Number} The number of listeners.
 * @public
 */
EventEmitter.prototype.listenerCount = function listenerCount(event) {
  var evt = prefix ? prefix + event : event
    , listeners = this._events[evt];

  if (!listeners) return 0;
  if (listeners.fn) return 1;
  return listeners.length;
};

/**
 * Calls each of the listeners registered for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @returns {Boolean} `true` if the event had listeners, else `false`.
 * @public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return false;

  var listeners = this._events[evt]
    , len = arguments.length
    , args
    , i;

  if (listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, undefined, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, undefined, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        case 4: listeners[i].fn.call(listeners[i].context, a1, a2, a3); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Add a listener for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  return addListener(this, event, fn, context, false);
};

/**
 * Add a one-time listener for a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn The listener function.
 * @param {*} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  return addListener(this, event, fn, context, true);
};

/**
 * Remove the listeners of a given event.
 *
 * @param {(String|Symbol)} event The event name.
 * @param {Function} fn Only remove the listeners that match this function.
 * @param {*} context Only remove the listeners that have this context.
 * @param {Boolean} once Only remove one-time listeners.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return this;
  if (!fn) {
    clearEvent(this, evt);
    return this;
  }

  var listeners = this._events[evt];

  if (listeners.fn) {
    if (
      listeners.fn === fn &&
      (!once || listeners.once) &&
      (!context || listeners.context === context)
    ) {
      clearEvent(this, evt);
    }
  } else {
    for (var i = 0, events = [], length = listeners.length; i < length; i++) {
      if (
        listeners[i].fn !== fn ||
        (once && !listeners[i].once) ||
        (context && listeners[i].context !== context)
      ) {
        events.push(listeners[i]);
      }
    }

    //
    // Reset the array, or remove it completely if we have no more listeners.
    //
    if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
    else clearEvent(this, evt);
  }

  return this;
};

/**
 * Remove all listeners, or those of the specified event.
 *
 * @param {(String|Symbol)} [event] The event name.
 * @returns {EventEmitter} `this`.
 * @public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  var evt;

  if (event) {
    evt = prefix ? prefix + event : event;
    if (this._events[evt]) clearEvent(this, evt);
  } else {
    this._events = new Events();
    this._eventsCount = 0;
  }

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// Expose the prefix.
//
EventEmitter.prefixed = prefix;

//
// Allow `EventEmitter` to be imported as module namespace.
//
EventEmitter.EventEmitter = EventEmitter;

//
// Expose the module.
//
if ('undefined' !== typeof module) {
  module.exports = EventEmitter;
}

},{}],19:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],20:[function(require,module,exports){
(function (process){
module.exports = function (pid) {
  if (module.exports.stub !== module.exports) {
      return module.exports.stub.apply(this, arguments);
  }
  try {
    return process.kill(pid,0)
  }
  catch (e) {
    return e.code === 'EPERM'
  }
}
module.exports.stub = module.exports;

}).call(this,require('_process'))

},{"_process":22}],21:[function(require,module,exports){
(function (process){
// .dirname, .basename, and .extname methods are extracted from Node.js v8.11.1,
// backported and transplited with Babel, with backwards-compat fixes

// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function (path) {
  if (typeof path !== 'string') path = path + '';
  if (path.length === 0) return '.';
  var code = path.charCodeAt(0);
  var hasRoot = code === 47 /*/*/;
  var end = -1;
  var matchedSlash = true;
  for (var i = path.length - 1; i >= 1; --i) {
    code = path.charCodeAt(i);
    if (code === 47 /*/*/) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) {
    // return '//';
    // Backwards-compat fix:
    return '/';
  }
  return path.slice(0, end);
};

function basename(path) {
  if (typeof path !== 'string') path = path + '';

  var start = 0;
  var end = -1;
  var matchedSlash = true;
  var i;

  for (i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47 /*/*/) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // path component
      matchedSlash = false;
      end = i + 1;
    }
  }

  if (end === -1) return '';
  return path.slice(start, end);
}

// Uses a mixed approach for backwards-compatibility, as ext behavior changed
// in new Node.js versions, so only basename() above is backported here
exports.basename = function (path, ext) {
  var f = basename(path);
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};

exports.extname = function (path) {
  if (typeof path !== 'string') path = path + '';
  var startDot = -1;
  var startPart = 0;
  var end = -1;
  var matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  var preDotState = 0;
  for (var i = path.length - 1; i >= 0; --i) {
    var code = path.charCodeAt(i);
    if (code === 47 /*/*/) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46 /*.*/) {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1)
          startDot = i;
        else if (preDotState !== 1)
          preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (startDot === -1 || end === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    return '';
  }
  return path.slice(startDot, end);
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))

},{"_process":22}],22:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],23:[function(require,module,exports){
(function (global){
/*! *****************************************************************************
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
***************************************************************************** */

/* global global, define, System, Reflect, Promise */
var __extends;
var __assign;
var __rest;
var __decorate;
var __param;
var __metadata;
var __awaiter;
var __generator;
var __exportStar;
var __values;
var __read;
var __spread;
var __spreadArrays;
var __await;
var __asyncGenerator;
var __asyncDelegator;
var __asyncValues;
var __makeTemplateObject;
var __importStar;
var __importDefault;
var __classPrivateFieldGet;
var __classPrivateFieldSet;
var __createBinding;
(function (factory) {
    var root = typeof global === "object" ? global : typeof self === "object" ? self : typeof this === "object" ? this : {};
    if (typeof define === "function" && define.amd) {
        define("tslib", ["exports"], function (exports) { factory(createExporter(root, createExporter(exports))); });
    }
    else if (typeof module === "object" && typeof module.exports === "object") {
        factory(createExporter(root, createExporter(module.exports)));
    }
    else {
        factory(createExporter(root));
    }
    function createExporter(exports, previous) {
        if (exports !== root) {
            if (typeof Object.create === "function") {
                Object.defineProperty(exports, "__esModule", { value: true });
            }
            else {
                exports.__esModule = true;
            }
        }
        return function (id, v) { return exports[id] = previous ? previous(id, v) : v; };
    }
})
(function (exporter) {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };

    __extends = function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };

    __assign = Object.assign || function (t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
    };

    __rest = function (s, e) {
        var t = {};
        for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
            t[p] = s[p];
        if (s != null && typeof Object.getOwnPropertySymbols === "function")
            for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
                if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                    t[p[i]] = s[p[i]];
            }
        return t;
    };

    __decorate = function (decorators, target, key, desc) {
        var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
        if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
        else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
        return c > 3 && r && Object.defineProperty(target, key, r), r;
    };

    __param = function (paramIndex, decorator) {
        return function (target, key) { decorator(target, key, paramIndex); }
    };

    __metadata = function (metadataKey, metadataValue) {
        if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
    };

    __awaiter = function (thisArg, _arguments, P, generator) {
        function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
        return new (P || (P = Promise))(function (resolve, reject) {
            function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
            function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
            function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
            step((generator = generator.apply(thisArg, _arguments || [])).next());
        });
    };

    __generator = function (thisArg, body) {
        var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
        return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
        function verb(n) { return function (v) { return step([n, v]); }; }
        function step(op) {
            if (f) throw new TypeError("Generator is already executing.");
            while (_) try {
                if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
                if (y = 0, t) op = [op[0] & 2, t.value];
                switch (op[0]) {
                    case 0: case 1: t = op; break;
                    case 4: _.label++; return { value: op[1], done: false };
                    case 5: _.label++; y = op[1]; op = [0]; continue;
                    case 7: op = _.ops.pop(); _.trys.pop(); continue;
                    default:
                        if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                        if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                        if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                        if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                        if (t[2]) _.ops.pop();
                        _.trys.pop(); continue;
                }
                op = body.call(thisArg, _);
            } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
            if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
        }
    };

    __createBinding = function(o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
    };

    __exportStar = function (m, exports) {
        for (var p in m) if (p !== "default" && !exports.hasOwnProperty(p)) exports[p] = m[p];
    };

    __values = function (o) {
        var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
        if (m) return m.call(o);
        if (o && typeof o.length === "number") return {
            next: function () {
                if (o && i >= o.length) o = void 0;
                return { value: o && o[i++], done: !o };
            }
        };
        throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
    };

    __read = function (o, n) {
        var m = typeof Symbol === "function" && o[Symbol.iterator];
        if (!m) return o;
        var i = m.call(o), r, ar = [], e;
        try {
            while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
        }
        catch (error) { e = { error: error }; }
        finally {
            try {
                if (r && !r.done && (m = i["return"])) m.call(i);
            }
            finally { if (e) throw e.error; }
        }
        return ar;
    };

    __spread = function () {
        for (var ar = [], i = 0; i < arguments.length; i++)
            ar = ar.concat(__read(arguments[i]));
        return ar;
    };

    __spreadArrays = function () {
        for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
        for (var r = Array(s), k = 0, i = 0; i < il; i++)
            for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
                r[k] = a[j];
        return r;
    };

    __await = function (v) {
        return this instanceof __await ? (this.v = v, this) : new __await(v);
    };

    __asyncGenerator = function (thisArg, _arguments, generator) {
        if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
        var g = generator.apply(thisArg, _arguments || []), i, q = [];
        return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i;
        function verb(n) { if (g[n]) i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; }
        function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
        function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);  }
        function fulfill(value) { resume("next", value); }
        function reject(value) { resume("throw", value); }
        function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
    };

    __asyncDelegator = function (o) {
        var i, p;
        return i = {}, verb("next"), verb("throw", function (e) { throw e; }), verb("return"), i[Symbol.iterator] = function () { return this; }, i;
        function verb(n, f) { i[n] = o[n] ? function (v) { return (p = !p) ? { value: __await(o[n](v)), done: n === "return" } : f ? f(v) : v; } : f; }
    };

    __asyncValues = function (o) {
        if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
        var m = o[Symbol.asyncIterator], i;
        return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
        function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
        function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
    };

    __makeTemplateObject = function (cooked, raw) {
        if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
        return cooked;
    };

    __importStar = function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
        result["default"] = mod;
        return result;
    };

    __importDefault = function (mod) {
        return (mod && mod.__esModule) ? mod : { "default": mod };
    };

    __classPrivateFieldGet = function (receiver, privateMap) {
        if (!privateMap.has(receiver)) {
            throw new TypeError("attempted to get private field on non-instance");
        }
        return privateMap.get(receiver);
    };

    __classPrivateFieldSet = function (receiver, privateMap, value) {
        if (!privateMap.has(receiver)) {
            throw new TypeError("attempted to set private field on non-instance");
        }
        privateMap.set(receiver, value);
        return value;
    };

    exporter("__extends", __extends);
    exporter("__assign", __assign);
    exporter("__rest", __rest);
    exporter("__decorate", __decorate);
    exporter("__param", __param);
    exporter("__metadata", __metadata);
    exporter("__awaiter", __awaiter);
    exporter("__generator", __generator);
    exporter("__exportStar", __exportStar);
    exporter("__createBinding", __createBinding);
    exporter("__values", __values);
    exporter("__read", __read);
    exporter("__spread", __spread);
    exporter("__spreadArrays", __spreadArrays);
    exporter("__await", __await);
    exporter("__asyncGenerator", __asyncGenerator);
    exporter("__asyncDelegator", __asyncDelegator);
    exporter("__asyncValues", __asyncValues);
    exporter("__makeTemplateObject", __makeTemplateObject);
    exporter("__importStar", __importStar);
    exporter("__importDefault", __importDefault);
    exporter("__classPrivateFieldGet", __classPrivateFieldGet);
    exporter("__classPrivateFieldSet", __classPrivateFieldSet);
});

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}]},{},[4])(4)
});

//# sourceMappingURL=threadedClass.js.map