"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.House = void 0;
const events_1 = require("events");
function fib(num) {
    let result = 0;
    if (num < 2) {
        result = num;
    }
    else {
        result = fib(num - 1) + fib(num - 2);
    }
    return result;
}
class House extends events_1.EventEmitter {
    constructor(windows, rooms) {
        super();
        this.windows = [];
        this._rooms = [];
        this._lamps = 0;
        this._readonly = 42;
        this._writeonly = 0;
        this.windows = windows;
        this._rooms = rooms;
    }
    returnValue(value) {
        return value;
    }
    getWindows(_a) {
        if (_a) {
            return [_a, ...this.windows];
        }
        return this.windows;
    }
    setWindows(windows) {
        return this.windows = windows;
    }
    getRooms() {
        return this._rooms;
    }
    get getterRooms() {
        return this._rooms;
    }
    set lamps(l) {
        this._lamps = l;
    }
    get lamps() {
        return this._lamps;
    }
    get readonly() {
        return this._readonly;
    }
    set writeonly(value) {
        this._writeonly = this._writeonly;
        this._writeonly = value;
    }
    slowFib(num) {
        return fib(num);
    }
    doEmit(str) {
        this.emit(str);
    }
    callCallback(d, cb) {
        return new Promise((resolve, reject) => {
            cb(d + ',child')
                .then((result) => {
                resolve(result + ',child2');
            })
                .catch((err) => {
                reject(err);
            });
        });
    }
}
exports.House = House;
