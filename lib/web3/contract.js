/*
    This file is part of web3.js.

    web3.js is free software: you can redistribute it and/or modify
    it under the terms of the GNU Lesser General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    web3.js is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Lesser General Public License for more details.

    You should have received a copy of the GNU Lesser General Public License
    along with web3.js.  If not, see <http://www.gnu.org/licenses/>.
*/
/**
 * @file contract.js
 * @author Fabian Vogelsteller <fabian@frozeman.de>
 * @date 2016
 */

var utils = require('../utils/utils');
var eventifiedPromise = require('./eventifiedPromise.js');
var coder = require('../solidity/coder');
var formatters = require('./formatters');
var sha3 = require('../utils/sha3');
var Subscription = require('./subscription.js');



/**
 * Should be called to create new contract instance
 *
 * @method Contract
 * @constructor
 * @param {Array} jsonInterface
 * @param {String} address
 * @param {Object} options
 */
var Contract = function(jsonInterface, address, options) {
    var _this = this,
        args = Array.prototype.slice.call(arguments);
    this.options = {};

    if(!(this instanceof Contract))
        throw new Error('Please use the "new" keyword to instantiate a web3.eth.contract() object!');

    if(!jsonInterface || !(jsonInterface instanceof Array))
        throw new Error('You must provide the json interface of the contract when instatiating a contract object.');

    // get the options object
    if(utils.isObject(args[args.length - 1])) {
        options = args[args.length - 1];
        this.options.data = options.data;
        this.options.from = options.from;
        this.options.gasPrice = options.gasPrice;
        this.options.gasLimit = options.gasLimit;

        if(utils.isObject(address)) {
            address = null;
        }
    }


    // set address
    Object.defineProperty(this, 'address', {
        set: function(value){
            if(utils.isAddress(value))
                this._address = value.toLowerCase();
            else
                throw new Error('The provided address is not a valid address.');
        },
        get: function(){
            return this._address;
        },
        enumerable: true
    });

    // add method and event signatures, when the jsonInterface gets set
    Object.defineProperty(this, 'jsonInterface', {
        set: function(value){
            _this._jsonInterface = value.map(function(method) {
                // function
                if (method.type === 'function') {
                    method.signature = '0x'+ sha3(utils.transformToFullName(method)).slice(0, 8);
                    method.outputTypes = method.outputs.map(function (i) {
                        return i.type;
                    });

                    // add method only if not one already exists
                    if(!_this.methods[method.name])
                        _this.methods[method.name] = _this._createTxObject.bind({
                            signatureBased: false,
                            method: method,
                            parent: _this
                        });

                    // definitely add the method based on its signature
                    _this.methods[method.signature] = _this._createTxObject.bind({
                        signatureBased: true,
                        method: method,
                        parent: _this
                    });

                    // also add to the main contract object
                    if(!_this[method.name])
                        _this[method.name] = _this.methods[method.name];
                    _this[method.signature] = _this.methods[method.signature];

                    // event
                } else if (method.type === 'event') {
                    method.signature = '0x'+ sha3(utils.transformToFullName(method));
                }


                return method;
            });
            return _this._jsonInterface;
        },
        get: function(){
            return _this._jsonInterface;
        },
        enumerable: true
    });

    // properties
    this.methods = {};

    this._address = null;
    this._jsonInterface = [];

    // set getter/setter properties
    this.address = address;
    this.jsonInterface = jsonInterface;

};

Contract.prototype._web3 = {}; // web3 is attached here in eth.js

/**
 * Checks that no listener with name "newListener" or "removeListener" is added.
 *
 * @method _checkListener
 * @param {String} type
 * @param {String} event
 * @param {Function} func
 * @return {Object} the contract instance
 */
Contract.prototype._checkListener = function(type, event, func){
    if(event === type) {
        throw new Error('The event "'+ type +'" is a reserved event name, you can\'t use it.');
    }
};


/**
 * Fires an error in an event emitter and callback and returns the eventemitter
 *
 * @method _fireError
 * @param {Object} error
 * @param {Object} emitter
 * @param {Function} reject
 * @param {Function} callback
 * @return {Object} the emitter
 */
Contract.prototype._fireError = function (error, emitter, reject, callback) {
    setTimeout(function(){
        if(utils.isFunction(callback)) {
            callback(error);
        }
        if(utils.isFunction(reject)) {
            reject(error);
        }
        emitter.emit('error', error);
        emitter.removeAllListeners();
    }, 0);
    return emitter;
};


/**
 * Should be used to encode indexed params and options to one final object
 *
 * @method _encodeEventABI
 * @param {Object} options
 * @return {Object} everything combined together and encoded
 */
Contract.prototype._encodeEventABI = function (event, options) {
    options = options || {};
    var filter = options.filter || {},
        result = {};


    ['fromBlock', 'toBlock'].filter(function (f) {
        return options[f] !== undefined;
    }).forEach(function (f) {
        result[f] = formatters.inputBlockNumberFormatter(options[f]);
    });

    result.topics = [];

    // add event signature
    if (event && !event.anonymous && event.name !== 'ALLEVENTS') {
        result.topics.push(event.signature);
    }

    // add event topics (indexed arguments)
    if (event.name !== 'ALLEVENTS') {
        var indexedTopics = event.inputs.filter(function (i) {
            return i.indexed === true;
        }).map(function (i) {
            var value = filter[i.name];
            if (!value) {
                return null;
            }

            if (utils.isArray(value)) {
                return value.map(function (v) {
                    return '0x' + coder.encodeParam(i.type, v);
                });
            }
            return '0x' + coder.encodeParam(i.type, value);
        });

        result.topics = result.topics.concat(indexedTopics);
    }

    if(!result.topics.length)
        delete result.topics;

    result.address = this.address;

    return result;
};

/**
 * Should be used to decode indexed params and options
 *
 * @method _decodeEventABI
 * @param {Object} data
 * @return {Object} result object with decoded indexed && not indexed params
 */
Contract.prototype._decodeEventABI = function (data) {
    var event = this;
    data.data = data.data || '';
    data.topics = data.topics || [];
    var result = formatters.outputLogFormatter(data);

    // if allEvents get the right event
    if(event.name === 'ALLEVENTS') {
        event = event.jsonInterface.find(function (interface) {
            return (interface.signature === data.topics[0]);
        }) || {anonymous: true};
    }

    // create empty inputs if none are present (e.g. anonymous events on allEvents)
    event.inputs = event.inputs || [];


    var argTopics = event.anonymous ? data.topics : data.topics.slice(1);
    var indexedTypes = event.inputs.filter(function (i) {
        return i.indexed === true;
    }).map(function (i) {
        return i.type;
    });
    var notIndexedTypes = event.inputs.filter(function (i) {
        return i.indexed === false;
    }).map(function (i) {
        return i.type;
    });

    var indexedData = argTopics.map(function (topics) { return topics.slice(2); }).join('');
    console.log('INDEXED', indexedTypes, indexedData);
    var indexedParams = coder.decodeParams(indexedTypes, indexedData);

    console.log('NOY INDEXED', notIndexedTypes, data.data.slice(2));
    var notIndexedParams = coder.decodeParams(notIndexedTypes, data.data.slice(2));


    var count = 0;
    result.returnValues = event.inputs.reduce(function (acc, current) {
        var name = current.name || count++;
        acc[name] = current.indexed ? indexedParams.shift() : notIndexedParams.shift();
        return acc;
    }, {});

    result.event = event.name;

    //delete result.data;
    //delete result.topics;

    return result;
};

/**
 * Encodes an ABI for a method, including signature or the method.
 * Or when constructor encodes only the constructor parameters.
 *
 * @method _encodeMethodABI
 * @param {String} methodSignature
 * @param {Array} args
 * @param {String} the encoded ABI
 */
Contract.prototype._encodeMethodABI = function _encodeMethodABI(methodSignature, args) {
    var _this = this._parent ? this._parent : this;

    // use this when this function is used as part of a myMethod.encode() call
    if(this._parent) {
        methodSignature = this._method.signature;
        args = this.arguments;
    }

    var signature = false,
        paramsABI = _this.jsonInterface.filter(function (json) {
        return ((methodSignature === 'constructor' && json.type === methodSignature) ||
            ((json.signature === methodSignature || json.signature === '0x'+ methodSignature || json.name === methodSignature) && json.type === 'function')) &&
            json.inputs.length === args.length;
    }).map(function (json) {
        if(json.type === 'function') {
            signature = json.signature;
        }
        return json.inputs.map(function (input) {
            return input.type;
        });
    }).map(function (types) {
        return coder.encodeParams(types, args);
    })[0] || '';

    var returnValue = (signature) ? signature + paramsABI : paramsABI;

    if(!returnValue)
        throw new Error('Couldn\'t find a matching contract method, or the number of parameters is wrong.')
    else
        return returnValue;
};

/**
 * Decode method return values
 *
 * @method _decodeMethodReturn
 * @param {Array} outputTypes
 * @param {String} returnValues
 * @param {Array} decoded output return values
 */
Contract.prototype._decodeMethodReturn = function (outputTypes, returnValues) {
    if (!returnValues) {
        return;
    }

    returnValues = returnValues.length >= 2 ? returnValues.slice(2) : returnValues;
    var result = coder.decodeParams(outputTypes, returnValues);
    result = result.length === 1 ? result[0] : result;
    if(result === '0x')
        result = null;
    return result;
};

/**
 * Should be called to check if a contract gets properly deployed on the blockchain.
 *
 * @method _checkForContractAddress
 * @param {String} transactionHash
 * @param {Function} callback
 * @returns {Undefined}
 */
Contract.prototype._checkForContractAddress = function(transactionHash, callback){
    var _this = this,
        count = 0,
        callbackFired = false;

    // wait for receipt
    var sub = this._web3.eth.subscribe('newBlocks', {}, function(e){
        if (!e && !callbackFired) {
            count++;

            // stop watching after 50 blocks (timeout)
            if (count > 50) {

                sub.unsubscribe();
                callbackFired = true;

                if (callback)
                    callback(new Error('Contract deployment timed out. Transaction couldn\'t be found after 50 blocks'));


            } else {

                _this._web3.eth.getTransactionReceipt(transactionHash, function(e, receipt){
                    if(receipt && !callbackFired) {

                        _this._web3.eth.getCode(receipt.contractAddress, function(e, code){

                            if(callbackFired || !code)
                                return;

                            sub.unsubscribe();
                            callbackFired = true;

                            if(code.length > 2) {
                                callback(null, receipt.contractAddress);
                            } else {
                                callback(new Error('The contract code couldn\'t be stored, please check your gas limit.'));
                            }
                        });
                    }
                });
            }
        }
    });
};

/**
 * Deploys a contract and fire events based on its state: transactionHash, mined
 *
 * All event listeners will be removed, once the last possible event is fired ("error", or "mined")
 *
 * @method deploy
 * @param {Object} options
 * @param {Function} callback
 * @return {Object} EventEmitter possible events are "error", "transactionHash" and "mined"
 */
Contract.prototype.deploy = function(options, callback){
    /*jshint maxcomplexity: 9 */
    var _this = this,
        defer = eventifiedPromise();

    options = options || {};

    options.arguments = options.arguments || [];
    options.data = options.data || this.options.data;
    options.from = options.from || this.options.from;
    options.gasPrice = options.gasPrice || this.options.gasPrice;
    options.gasLimit = options.gasLimit || this.options.gasLimit;

    // return error, if no "from" is specified
    if(!utils.isAddress(options.from)) {
        return this._fireError(new Error('No "from" address specified in either the default options, or the given options.'), defer.promise, defer.reject, callback);
    }

    // return error, if no "data" is specified
    if(!options.data) {
        return this._fireError(new Error('No "data" specified in either the default options, or the given options.'), defer.promise, defer.reject, callback);
    }

    // add constructor parameters
    var bytes = this._encodeParams('constructor', options.arguments);
    options.data += bytes;


    // send the actual deploy transaction
    this._web3.eth.sendTransaction({
        from: options.from,
        gasPice: options.gasPrice,
        gasLimit: options.gasLimit,
        data: options.data
    }, function (err, hash) {

        // call callback if available
        if(utils.isFunction(callback)) {
            callback(err, hash);
        }

        if (err) {
            defer.reject(err);
            defer.promise.emit('error', err);
            // remove all listeners on the end, as no event will ever fire again
            defer.promise.removeAllListeners();

        } else {
            defer.promise.emit('transactionHash', hash);

            // wait for the contract to be mined and return the address
            _this._checkForContractAddress(hash, function(err, address){
                if(err) {
                    defer.reject(err);
                    defer.promise.emit('error', err);
                } else {
                    defer.resolve(address);
                    defer.promise.emit('mined', address);
                }

                // remove all listeners on the end, as no event will ever fire again
                defer.promise.removeAllListeners();
            });
        }
    });

    return defer.promise;
};


/**
 * Encodes any contract function, including the constructor into a data ABI HEX string.
 *
 * @method encodeABI
 * @param {Object} options
 */
Contract.prototype.encodeABI = function encodeABI(options){
    var bytes = '';
    options = options || {};

    options.arguments = options.arguments || [];
    options.data = options.data || this.options.data || '';

    if(!options.method)
        throw new Error('You must provide a method, or the string "constructor".');

    if(options.method === 'constructor') {
        bytes = options.data || bytes;
        bytes = '0x'+ bytes.replace(/^0x/,'');
    }

    // remove 0x
    options.method = options.method.replace(/^0x/,'');

    // add the parameters (and signature, if method not constructor)
    bytes += this._encodeMethodABI(options.method, options.arguments);

    return bytes;
};


/**
 * Adds event listeners and creates a subscription, if none exists.
 *
 * @method on
 * @param {String} event
 * @param {Object} options
 * @param {Function} func
 * @return {Object} the event subscription
 */
Contract.prototype.on = function(event, options, func){
    var args = Array.prototype.slice.call(arguments),
        event = (event.toLowerCase() === 'allevents') ? {
            name: 'ALLEVENTS',
            jsonInterface: this.jsonInterface
        } : this.jsonInterface.find(function(json){
            return (json.type === 'event' && json.name === event);
        });

    if(!event) {
        throw new Error('Event "'+ event.name +'" doesn\'t exist in this contract.');
    }

    if(!utils.isAddress(this.address)) {
        throw new Error('This contract object doesn\'t have address set yet, please set an address first.');
    }

    if (utils.isFunction(args[args.length - 1])) {
        func = args[args.length - 1];
    }

    this._checkListener('newListener', event.name, func);
    this._checkListener('removeListener', event.name, func);

    options = (utils.isObject(args[args.length - 1])) ? args[args.length - 1] : options;
    var subscriptionParams = this._encodeEventABI(event ,options);

    console.log(subscriptionParams);

    // create new subscription
    var subscription = new Subscription({
        subscription: {
            params: 1,
            inputFormatter: [formatters.inputLogFormatter],
            outputFormatter: this._decodeEventABI.bind(event)
        },
        subscribeMethod: 'eth_subscribe',
        unsubscribeMethod: 'eth_unsubscribe',
        requestManager: this._web3._requestManager
    });
    subscription.subscribe('logs', subscriptionParams, func);

    return subscription;
};

/**
 * Get past events from contracts
 *
 * @method pastEvents
 * @param {Object} options
 */
Contract.prototype.pastEvents = function(event, options, callback){
    var args = Array.prototype.slice.call(arguments);

    // get the callback
    if(utils.isFunction(args[args.length - 1])) {
        callback = args[args.length - 1];

        if(utils.isFunction(options)) {
            options = null;
        }
    }

    // TODO
};


/**
 * returns the an object with call, send, estimate funcitons
 *
 * @method _createTxObject
 * @param {String} type
 * @param {Array} args
 * @returns {Object} an object with functions to call the methods
 */
Contract.prototype._createTxObject =  function _createTxObject(){
    var _this = this,
        txObject = {};

    txObject.call = this.parent._executeMethod.bind(txObject, 'call');
    txObject.send = this.parent._executeMethod.bind(txObject, 'send');
    txObject.estimate = this.parent._executeMethod.bind(txObject, 'estimate');
    txObject.encodeABI = this.parent._encodeMethodABI.bind(txObject);
    txObject.arguments = arguments;
    txObject._method = this.method;
    txObject._parent = this.parent;

    return txObject;
};

/**
 * Executes a call, transact or estimateGas on a contract function
 *
 * @method _executeMethod
 * @param {Object} options
 */
Contract.prototype._executeMethod = function _executeMethod(type, options){
    var _this = this,
        args = Array.prototype.slice.call(arguments),
        defer = eventifiedPromise(),
        options = options || {},
        callback = null;

    // get the callback
    if(utils.isFunction(args[args.length - 1])) {
        callback = args.pop();
    }

    options.data = this.encodeABI();
    // TODO remove once we switched everywhere to gasLimit
    options.gas = options.gasLimit;
    delete options.gasLimit;

    // add contract address
    if(!utils.isAddress(this._parent.address)) {
        throw new Error('This contract object doesn\'t have address set yet, please set an address first.');
    }

    if(utils.isAddress(options.from))
        options.from = options.from.toLowerCase();

    options.to = this._parent.address.toLowerCase();

    // return error, if no "data" is specified
    if(!options.data) {
        return this._parent._fireError(new Error('Couldn\'t find a matching contract method, or the number of parameters is wrong.'), defer.promise, defer.reject, callback);
    }

    // create the callback method
    var methodReturnCallback = function(err, returnValue) {
        returnValue = (type === 'estimate' || type === 'send') ? returnValue : _this._parent._decodeMethodReturn(_this._method.outputTypes, returnValue);


        if (err) {
            return this._parent._fireError(err, defer.promise, defer.reject, callback);
        } else {

            if(callback) {
                callback(null, returnValue);
            }

            // send immediate returnValue
            defer.promise.emit('data', returnValue);

            if(type === 'send') {

                // fire "mined" event and resolve after
                _parent._web3.eth.subscribe('newBlocks', function (err, block, sub) {
                    if(!err) {

                        _parent._web3.eth.getTransactionReceipt(returnValue, function (err, receipt) {
                           if(!err) {
                               if(receipt) {
                                   sub.unsubscribe();

                                   if(!receipt.outOfGas) {
                                       defer.promise.emit('mined', receipt);
                                       defer.resolve(receipt);
                                       defer.promise.removeAllListeners();

                                   } else {
                                       return this._parent._fireError(new Error('Transaction ran out of gas.'), defer.promise, defer.reject);
                                   }
                               }
                           } else {
                               sub.unsubscribe();
                               return this._parent._fireError(err, defer.promise, defer.reject);
                           }
                        });


                    } else {
                        sub.unsubscribe();
                        return this._parent._fireError(err, defer.promise, defer.reject);
                    }
                });

            } else {
                // remove all listeners on the end, as no event will ever fire again
                defer.resolve(returnValue);
                defer.promise.removeAllListeners();
            }
        }
    };

    switch (type) {
        case 'estimate':

            this._parent._web3.eth.estimateGas(options, methodReturnCallback);

            break;
        case 'call':

            this._parent._web3.eth.call(options, methodReturnCallback);

            break;
        case 'send':

            this._parent._web3.eth.sendTransaction(options, methodReturnCallback);

            break;
    }

    return defer.promise;
};


module.exports = Contract;
