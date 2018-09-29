const {Bond, TimeBond, TransformBond} = require('oo7');
const XXH = require('xxhashjs');
const {ss58_decode, ss58_encode} = require('ss58');
const {camel, snake} = require('change-case');

require('isomorphic-fetch');

class VecU8 extends Uint8Array { toJSON() { return { _type: 'VecU8', data: Array.from(this) } }}
class AccountId extends Uint8Array { toJSON() { return { _type: 'AccountId', data: Array.from(this) } }}
class Hash extends Uint8Array { toJSON() { return { _type: 'Hash', data: Array.from(this) } }}
class VoteThreshold extends String { toJSON() { return { _type: 'VoteThreshold', data: this + ''} }}
class SlashPreference extends Number {
	toJSON() { return { _type: 'SlashPreference', data: this+0 } }
}
class Moment extends Date {
	constructor(seconds) {
		super(seconds * 1000)
		this.number = seconds
	}
	toJSON() {
		return { _type: 'Moment', data: this.number }
	}
}
class Balance extends Number {
	toJSON() { return { _type: 'Balance', data: this+0 } }
	add(b) { return new Balance(this + b) }
	sub(b) { return new Balance(this - b) }
}
class BlockNumber extends Number { toJSON() { return { _type: 'BlockNumber', data: this+0 } }}
class Tuple extends Array { toJSON() { return { _type: 'Tuple', data: Array.from(this) } }}
class CallProposal extends Object { constructor (isCall) { super(); this.isCall = isCall; } }
class Proposal extends CallProposal {
	constructor (o) { super(false); Object.assign(this, o) }
	toJSON() { return { _type: 'Proposal', data: { module: this.module, name: this.name, params: this.params } } }
}
class Call extends CallProposal {
	constructor (o) { super(true); Object.assign(this, o) }
	toJSON() { return { _type: 'Call', data: { module: this.module, name: this.name, params: this.params } } }
}

function reviver(key, bland) {
	if (typeof bland == 'object' && bland) {
		switch (bland._type) {
			case 'VecU8': return new VecU8(bland.data);
			case 'AccountId': return new AccountId(bland.data);
			case 'Hash': return new Hash(bland.data);
			case 'VoteThreshold': return new VoteThreshold(bland.data);
			case 'SlashPreference': return new SlashPreference(bland.data);
			case 'Moment': return new Moment(bland.data);
			case 'Tuple': return new Tuple(bland.data);
			case 'Proposal': return new Proposal(bland.data);
			case 'Call': return new Call(bland.data);
			case 'Balance': return new Balance(bland.data);
			case 'BlockNumber': return new BlockNumber(bland.data);
		}
	}
	return bland;
}

let transforms = {
	RuntimeMetadata: { outerEvent: 'OuterEventMetadata', modules: 'Vec<RuntimeModuleMetadata>' },
	RuntimeModuleMetadata: { prefix: 'String', module: 'ModuleMetadata', storage: 'Option<StorageMetadata>' },
	StorageFunctionModifier: { _enum: [ 'None', 'Default', 'Required' ] },
	StorageFunctionTypeMap: { key: 'Type', value: 'Type' },
	StorageFunctionType: { _enum: { Plain: 'Type', Map: 'StorageFunctionTypeMap' } },
	StorageFunctionMetadata: { name: 'String', modifier: 'StorageFunctionModifier', type: 'StorageFunctionType', documentation: 'Vec<String>' },
	StorageMetadata: { prefix: 'String', items: 'Vec<StorageFunctionMetadata>' },
	EventMetadata: { name: 'String', arguments: 'Vec<Type>', documentation: 'Vec<String>' },
	OuterEventMetadata: { name: 'String', events: 'Vec<(String, Vec<EventMetadata>)>' },
	ModuleMetadata: { name: 'String', call: 'CallMetadata' },
	CallMetadata: { name: 'String', functions: 'Vec<FunctionMetadata>' },
	FunctionMetadata: { id: 'u16', name: 'String', arguments: 'Vec<FunctionArgumentMetadata>', documentation: 'Vec<String>' },
	FunctionArgumentMetadata: { name: 'String', type: 'Type' }
};

var deslicePrefix = 0;

function deslice(input, type) {
	if (typeof input.data === 'undefined') {
		input = { data: input };
	}
	if (typeof type === 'object') {
		return type.map(t => deslice(input, t));
	}
	while (type.startsWith('T::')) {
		type = type.slice(3);
	}
	let dataHex = bytesToHex(input.data.slice(0, 50));
//	console.log(deslicePrefix + 'des >>>', type, dataHex);
//	deslicePrefix +=  "   ";

	let res;
	let transform = transforms[type];
	if (transform) {
		if (typeof transform == 'string') {
			res = deslice(input, transform);
		} else if (typeof transform == 'object') {
			if (transform instanceof Array) {
				// just a tuple
				res = new Tuple(...deslice(input, transform));
			} else if (!transform._enum) {
				// a struct
				res = {};
				Object.keys(transform).forEach(k => {
					res[k] = deslice(input, transform[k]);
				});
			} else if (transform._enum instanceof Array) {
				// simple enum
				let n = input.data[0];
				input.data = input.data.slice(1);
				res = { option: transform._enum[n] };
			} else if (transform._enum) {
				// enum
				let n = input.data[0];
				input.data = input.data.slice(1);
				let option = Object.keys(transform._enum)[n];
				res = { option, value: deslice(input, transform._enum[option]) };
			}
		}
		res._type = type;
	} else {
		switch (type) {
			case 'Call':
			case 'Proposal': {
				let c = Calls[input.data[0]];
				res = type === 'Call' ? new Call : new Proposal;
				res.module = c.name;
				c = c[type == 'Call' ? 'calls' : 'priv_calls'][input.data[1]];
				input.data = input.data.slice(2);
				res.name = c.name;
				res.params = c.params.map(p => ({ name: p.name, type: p.type, value: deslice(input, p.type) }));
				break;
			}
			case 'AccountId': {
				res = new AccountId(input.data.slice(0, 32));
				input.data = input.data.slice(32);
				break;
			}
			case 'Hash': {
				res = new Hash(input.data.slice(0, 32));
				input.data = input.data.slice(32);
				break;
			}
			case 'Balance': {
				res = leToNumber(input.data.slice(0, 16));
				input.data = input.data.slice(16);
				res = new Balance(res);
				break;
			}
			case 'BlockNumber': {
				res = leToNumber(input.data.slice(0, 8));
				input.data = input.data.slice(8);
				res = new BlockNumber(res);
				break;
			}
			case 'Moment': {
				let n = leToNumber(input.data.slice(0, 8));
				input.data = input.data.slice(8);
				res = new Moment(n);
				break;
			}
			case 'VoteThreshold': {
				const VOTE_THRESHOLD = ['SuperMajorityApprove', 'NotSuperMajorityAgainst', 'SimpleMajority'];
				res = new VoteThreshold(VOTE_THRESHOLD[input.data[0]]);
				input.data = input.data.slice(1);
				break;
			}
			case 'SlashPreference': {
				res = new SlashPreference(deslice(input, 'u32'));
				break;
			}
			case 'Compact<u32>':
			case 'Compact<u16>':
			case 'Compact<u8>': {
				let len;
				if (input.data[0] % 4 == 0) {
					// one byte
					res = input.data[0] >> 2;
					len = 1;
				} else if (input.data[0] % 4 == 1) {
					res = leToNumber(input.data.slice(0, 2)) >> 2;
					len = 2;
				} else if (input.data[0] % 4 == 2) {
					res = leToNumber(inpuzt.data.slice(0, 4)) >> 2;
					len = 4;
				} else {
					let n = (input.data[0] >> 2) + 4;
					res = leToNumber(input.data.slice(1, n + 1));
					len = 5 + n;
				}
				input.data = input.data.slice(len);
				break;
			}
			case 'u16':
				res = leToNumber(input.data.slice(0, 2));
				input.data = input.data.slice(2);
				break;
			case 'u32':
			case 'VoteIndex':
			case 'PropIndex':
			case 'ReferendumIndex': {
				res = leToNumber(input.data.slice(0, 4));
				input.data = input.data.slice(4);
				break;
			}
			case 'bool': {
				res = !!input.data[0];
				input.data = input.data.slice(1);
				break;
			}
			case 'KeyValue': {
				res = deslice(input, '(Vec<u8>, Vec<u8>)');
				break;
			}
			case 'Vec<bool>': {
				let size = deslice(input, 'Compact<u32>');
				res = [...input.data.slice(0, size)].map(a => !!a);
				input.data = input.data.slice(size);
				break;
			}
			case 'Vec<u8>': {
				let size = deslice(input, 'Compact<u32>');
				res = input.data.slice(0, size);
				input.data = input.data.slice(size);
				break;
			}
			case 'String': {
				let size = deslice(input, 'Compact<u32>');
				res = input.data.slice(0, size);
				input.data = input.data.slice(size);
				res = new TextDecoder("utf-8").decode(res);
				break;
			}
			case 'Type': {
				res = deslice(input, 'String');
				res = res.replace('T::', '');
				res = res.match(/^Box<.*>$/) ? res.slice(4, -1) : res;
				break;
			}
			default: {
				let v = type.match(/^Vec<(.*)>$/);
				if (v) {
					let size = deslice(input, 'Compact<u32>');
					res = [...new Array(size)].map(() => deslice(input, v[1]));
					break;
				}
				let o = type.match(/^Option<(.*)>$/);
				if (o) {
					let some = deslice(input, 'bool');
					if (some) {
						res = deslice(input, o[1]);
					} else {
						res = null;
					}
					break;
				}
				let t = type.match(/^\((.*)\)$/);
				if (t) {
					res = new Tuple(...deslice(input, t[1].split(', ')));
					break;
				}
				throw 'Unknown type to deslice: ' + type;
			}
		}
	}
//	deslicePrefix = deslicePrefix.substr(3);
//	console.log(deslicePrefix + 'des <<<', type, res);
	return res;
}

const numberWithCommas = n => {
	let x = n.toString();
	if (x.indexOf('.') > -1) {
		let [a, b] = x.split('.');
		return numberWithCommas(a) + '.' + b;
	} else {
		return x.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	}
}

function pretty(expr) {
	if (expr === null) {
		return 'null';
	}
	if (expr instanceof VoteThreshold) {
		return 'VoteThreshold.' + expr;
	}
	if (expr instanceof VoteThreshold) {
		return 'SlashPreference{unstake_threshold=' + expr + '}';
	}
	if (expr instanceof Balance) {
		return (
			expr > 1000000000
			? numberWithCommas(Math.round(expr / 1000000)) + ' DOT'
			: expr > 100000000
			? numberWithCommas(Math.round(expr / 100000) / 10) + ' DOT'
			: expr > 10000000
			? numberWithCommas(Math.round(expr / 10000) / 100) + ' DOT'
			: expr > 1000000
			? numberWithCommas(Math.round(expr / 1000) / 1000) + ' DOT'
			: expr > 100000
			? numberWithCommas(Math.round(expr / 100) / 10000) + ' DOT'
			: numberWithCommas(expr) + ' µDOT'
		);
	}
	if (expr instanceof BlockNumber) {
		return numberWithCommas(expr);
	}
	if (expr instanceof Hash) {
		return '0x' + bytesToHex(expr);
	}
	if (expr instanceof Moment) {
		return expr.toLocaleString() + " (" + expr.number + " seconds)";
	}
	if (expr instanceof AccountId) {
		return ss58_encode(expr);
	}
	if (expr instanceof Tuple) {
		return '(' + expr.map(pretty).join(', ') + ')';
	}
	if (expr instanceof VecU8 || expr instanceof Uint8Array) {
		if (expr.length <= 256) {
			return '[' + bytesToHex(expr) + ']';
		} else {
			return `[${bytesToHex(expr.slice(0, 256))}...] (${expr.length} bytes)`;
		}
	}
	if (expr instanceof Array) {
		return '[' + expr.map(pretty).join(', ') + ']';
	}
	if (expr instanceof Call || expr instanceof Proposal) {
		return expr.module + '.' + expr.name + '(' + expr.params.map(p => {
			let v = pretty(p.value);
			if (v.length < 255) {
				return p.name + '=' + v;
			} else {
				return p.name + '= [...]';
			}
		}).join(', ') + ')';
	}
	if (typeof expr === 'object') {
		return '{' + Object.keys(expr).map(k => k + ': ' + pretty(expr[k])).join(', ') + '}';
	}
	return '' + expr;
}

class NodeService {
	constructor() {
		this.subscriptions = {}
		this.onreply = {}
		this.onceOpen = []
		this.index = 1
		this.start()
	}
	start () {
		let uri = 'ws://127.0.0.1:9944';
		let that = this;
		this.ws = new WebSocket(uri)
		this.ws.onopen = function () {
			console.log('Connection open!')
			let onceOpen = that.onceOpen;
			that.onceOpen = []
			window.setTimeout(() => onceOpen.forEach(f => f()), 0)
		}
		this.ws.onmessage = function (msg) {
			let d = JSON.parse(msg.data)
			console.log("Message from node", d)
			if (d.id) {
				that.onreply[d.id](d)
				delete that.onreply[d.id];
			} else if (d.method && d.params && that.subscriptions[d.params.subscription]) {
				that.subscriptions[d.params.subscription].callback(d.params.result, d.method)
			}

			if (that.reconnect) {
				window.clearTimeout(that.reconnect)
			}
			// epect a message every 10 seconds or we reconnect.
			if (false) 
				that.reconnect = window.setTimeout(() => {
				that.ws.close()
				delete that.ws
				that.start()
			}, 10000)
		}
	}
	request (method, params = []) {
		let that = this
		let doSend = () => new Promise((resolve, reject) => {
			console.log('Attempting send', that.ws.readyState)
			let id = '' + this.index++;
			that.ws.send(JSON.stringify({
				"jsonrpc": "2.0",
				"id": id,
				"method": method,
				"params": params
			}))
	
			that.onreply[id] = msg => {
				if (msg.error) {
					reject(msg.error)
				} else {
					resolve(msg.result)
				}
			}
		})

		if (this.ws.readyState == 0) {
			// still connecting
			return new Promise(resolve => {
				that.onceOpen.push(() => {
					console.log("Opened: sending")
					let res = doSend()
					resolve(res)
				})
			})
		} else {
			return doSend()
		}
	}
	subscribe (method, params, callback) {
		if (method.indexOf('_subscribe') == -1 && method.indexOf('_') != -1) {
			method = method.replace(/_\w/, c => '_subscribe' + c[1].toUpperCase())
		}
		let that = this
		return this.request(method, params).then(id => {
			that.subscriptions[id] = { callback, method }
			return id
		})
	}
	unsubscribe (id) {
		let that = this
		if (!this.subscriptions[id]) {
			throw 'Invalid subscription index'
		}
		let method = this.subscriptions[id].method.replace('_subscribe', '_unsubscribe')

		return this.request(method, [id]).then(result => {
			delete that.subscriptions[id]
			return result
		})
	}
	finalise () {
		delete this.ws;
	}
}

let service = new NodeService;

class SubscriptionBond extends Bond {
	constructor (name, params = [], xform = null, cache = { id: null, stringify: JSON.stringify, parse: JSON.parse }, mayBeNull) {
		super(mayBeNull, cache);
		this.name = name;
		this.params = params;
		this.xform = xform;
	}
	initialise () {
		let that = this;
		let callback = result => {
			if (that.xform) {
				result = that.xform(result);
			}
			that.trigger(result);
		};
		// promise instead of id because if a dependency triggers finalise() before id's promise is resolved the unsubscribing would call with undefined
		this.subscription = service.subscribe(this.name, this.params, callback);
	}
	finalise () {
		this.subscription.then(id => {
			service.unsubscribe(id);
		});
	}
	map (f, outResolveDepth = 0, cache = undefined) {
			return new TransformBond(f, [this], [], outResolveDepth, 1, cache);
	}
	sub (name, outResolveDepth = 0, cache = undefined) {
			return new TransformBond((r, n) => r[n], [this, name], [], outResolveDepth, 1, cache);
	}
	static all(list, cache = undefined) {
			return new TransformBond((...args) => args, list, [], 0, 1, cache);
	}
}

function storageValueKey(stringLocation) {
	let loc = stringToBytes(stringLocation);
	return '0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8);
}
function storageMapKey(prefixString, arg) {
	let loc = new VecU8([...stringToBytes(prefixString), ...arg]);
	return '0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8);
}

class StorageBond extends SubscriptionBond {
	constructor (prefix, type, args = []) {
		super('state_storage', [[ storageMapKey(prefix, args) ]], r => deslice(hexToBytes(r.changes[0][1]), type))
	}
}
/*
function balanceOf(pubkey) {
	let loc = new Uint8Array([...stringToBytes('sta:bal:'), ...hexToBytes(pubkey)]);
	return req('state_getStorage', ['0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8)])
		.then(r => r ? leHexToNumber(r.substr(2)) : 0);
}

function indexOf(pubkey) {
	let loc = new Uint8Array([...stringToBytes('sys:non'), ...hexToBytes(pubkey)]);
	return req('state_getStorage', ['0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8)])
		.then(r => r ? leHexToNumber(r.substr(2)) : 0);
}
*/
function stringToSeed(s) {
	var data = new VecU8(32);
	data.fill(32);
	for (var i = 0; i < s.length; i++){
		data[i] = s.charCodeAt(i);
	}
	return data;
}
function stringToBytes(s) {
	var data = new VecU8(s.length);
	for (var i = 0; i < s.length; i++){
		data[i] = s.charCodeAt(i);
	}
	return data;
}
function hexToBytes(str) {
	if (!str) {
		return new VecU8();
	}
	var a = [];
	for (var i = str.startsWith('0x') ? 2 : 0, len = str.length; i < len; i += 2) {
		a.push(parseInt(str.substr(i, 2), 16));
	}

	return new VecU8(a);
}
function bytesToHex(uint8arr) {
	if (!uint8arr) {
		return '';
	}
	var hexStr = '';
	for (var i = 0; i < uint8arr.length; i++) {
		var hex = (uint8arr[i] & 0xff).toString(16);
		hex = (hex.length === 1) ? '0' + hex : hex;
		hexStr += hex;
	}

	return hexStr.toLowerCase();
}
function toLEHex(val, bytes) {
	let be = ('00'.repeat(bytes) + val.toString(16)).slice(-bytes * 2);
	var le = '';
	for (var i = 0; i < be.length; i += 2) {
		le = be.substr(i, 2) + le;
	}
	return le;
}
function leHexToNumber(le) {
	var be = '';
	for (var i = le.startsWith('0x') ? 2 : 0; i < le.length; i += 2) {
		be = le.substr(i, 2) + be;
	}
	return Number.parseInt(be, 16);
}

function toLE(val, bytes) {
	let r = new VecU8(bytes);
	for (var o = 0; val > 0; ++o) {
		r[o] = val % 256;
		val /= 256;
	}
	return r;
}

function leToNumber(le) {
	let r = 0;
	let a = 1;
	le.forEach(x => { r += x * a; a *= 256; });
	return r;
}

String.prototype.chunks = function(size) {
	var r = [];
	var count = this.length / size;
	for (var i = 0; i < count; ++i) {
		r.push(this.substr(i * size, size));
	}
	return r;
}

String.prototype.mapChunks = function(sizes, f) {
	var r = [];
	var count = this.length / sizes.reduce((a, b) => a + b, 0);
	var offset = 0;
	for (var i = 0; i < count; ++i) {
		r.push(f(sizes.map(s => {
			let r = this.substr(offset, s);
			offset += s;
			return r;
		})));
	}
	return r;
}

Uint8Array.prototype.mapChunks = function(sizes, f) {
	var r = [];
	var count = this.length / sizes.reduce((a, b) => a + b, 0);
	var offset = 0;
	for (var i = 0; i < count; ++i) {
		r.push(f(sizes.map(s => {
			offset += s;
			return this.slice(offset - s, offset);
		})));
	}
	return r;
}

function tally(x) {
	var r = [0, 0];
	x.forEach(v => r[v ? 1 : 0]++);
	return {aye: r[1], nay: r[0]};
}

function tallyAmounts(x) {
	console.log('tallyAmounts', x)
	var r = [0, 0];
	x.forEach(([v, b]) => r[v ? 1 : 0] += b);
	return {aye: r[1], nay: r[0]};
}

function encoded(key, type) {
	if (typeof key == 'object' && key instanceof Uint8Array) {
		return key
	}
	if (typeof key == 'string' && key.startsWith('0x')) {
		return hexToBytes(key)
	}

	// other type-specific transforms
	if (type == 'AccountId' && typeof key == 'string') {
		return ss58_decode(key);
	}
}

class Polkadot {
	initialiseFromMetadata(m) {
		this.runtime = {}
		m.modules.forEach(m => {
			let o = {}
			if (m.storage) {
				let prefix = m.storage.prefix
				m.storage.items.forEach(item => {
					switch (item.type.option) {
						case 'Plain': {
							o[item.name] = new StorageBond(`${prefix} ${item.name}`, item.type.value)
							break
						}
						case 'Map': {
							let keyType = item.type.value.key
							let valueType = item.type.value.value
							o[item.name] = keyBond => new TransformBond(
								key => new StorageBond(`${prefix} ${item.name}`, valueType, encoded(key, keyType)),
								[keyBond]
							).subscriptable()
							break
						}
					}
					o[snake(item.name)] = o[item.name]
					o[camel(item.name)] = o[item.name]
				})
				this.runtime[m.prefix] = o
			}
		})
	}
	constructor () {
		this.authorityCount = new SubscriptionBond('state_storage', [['0x' + bytesToHex(stringToBytes(':auth:len'))]], r => deslice(hexToBytes(r.changes[0][1]), 'u32'))
		this.head = new SubscriptionBond('chain_newHead').subscriptable()
		this.height = this.head.map(h => new BlockNumber(h.number))
		this.metadata = service.request('state_getMetadata').then(blob => deslice(new Uint8Array(blob), 'RuntimeMetadata'))
		let that = this;
		this.metadata.then(m => that.initialiseFromMetadata(m))

		this.header = hashBond => new TransformBond(hash => service.request('chain_getHeader', [hash]), [hashBond]).subscriptable();
/*
		this.storage = locBond => new TransformBond(loc => req('state_getStorage', ['0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8)]), [locBond], [head]);
		this.code = new TransformBond(() => req('state_getStorage', ['0x' + bytesToHex(stringToBytes(":code"))]).then(hexToBytes), [], [head]);
		this.codeHash = new TransformBond(() => req('state_getStorageHash', ['0x' + bytesToHex(stringToBytes(":code"))]).then(hexToBytes), [], [head]);
		this.codeSize = new TransformBond(() => req('state_getStorageSize', ['0x' + bytesToHex(stringToBytes(":code"))]), [], [head]);
		function storageMap(prefix, formatResult = r => r, formatArg = x => x, postApply = x => x) {
			let prefixBytes = stringToBytes(prefix);
			return argBond => postApply((new TransformBond(
				arg => {
					let loc = new VecU8([...prefixBytes, ...formatArg(arg)]);
					let k = '0x' + toLEHex(XXH.h64(loc.buffer, 0), 8) + toLEHex(XXH.h64(loc.buffer, 1), 8);
					return req('state_getStorage', [k])
						.then(r => formatResult(r && hexToBytes(r), arg));
				},
				[argBond],
				[head]
			)).subscriptable());
		}
		function storageValue(stringLocation, formatResult = r => r, formatLocation = storageValueKey) {
			return (new TransformBond(
				arg => {
					return req('state_getStorage', [formatLocation(stringLocation)]).then(r => formatResult(r && hexToBytes(r), arg))
				},
				[],
				[head]
			)).subscriptable();
		}

		this.sys = {
			name: new TransformBond(() => req('system_name'), [], []),
			version: new TransformBond(() => req('system_version'), [], []),
			chain: new TransformBond(() => req('system_chain'), [], [])
		};

		this.system = {
			index: storageMap('sys:non', r => r ? leToNumber(r) : 0)
		};

		this.consensus = {
			authorityCount: new TransformBond(() => req('state_getStorage', ['0x' + bytesToHex(stringToBytes(":auth:len"))]).then(leHexToNumber), [], [head])
		};

		this.consensus.authorities = this.consensus.authorityCount.map(
			n => [...Array(n)].map((_, i) => storageValue(
				'0x' + bytesToHex(stringToBytes(":auth:")) + bytesToHex(toLE(i, 4)), 
				r => r ? deslice(r, 'T::AccountId') : null,
				x => x
			)), 2);

		this.timestamp = {
			blockPeriod: storageValue('tim:block_period', r => deslice(r, 'T::Moment')),
			now: storageValue('tim:val', r => deslice(r, 'T::Moment'))
		}

		this.session = {
			validators: storageValue('ses:val', r => deslice(r, 'Vec<T::AccountId>')),
			length: storageValue('ses:len', r => deslice(r, 'T::BlockNumber')),
			currentIndex: storageValue('ses:ind', r => deslice(r, 'T::BlockNumber')),
			currentStart: storageValue('ses:current_start', r => deslice(r, 'T::Moment')),
			brokenPercentLate: storageValue('ses:broken_percent_late', r => deslice(r, 'u32')),
			lastLengthChange: storageValue('ses:llc', r => r ? deslice(r, 'T::BlockNumber') : 0)
		};
		this.session.blocksRemaining = Bond					// 1..60
			.all([this.height, this.session.lastLengthChange, this.session.length])
			.map(([h, c, l]) => {
				c = (c || 0);
				return l - (h - c + l) % l;
			});
		this.session.lateness = Bond
			.all([
				this.timestamp.blockPeriod,
				this.timestamp.now,
				this.session.blocksRemaining,
				this.session.length,
				this.session.currentStart,
			]).map(([p, n, r, l, s]) => (n.number + p.number * r - s.number) / (p.number * l));
		this.session.percentLate = this.session.lateness.map(l => Math.round(l * 100 - 100));

		this.staking = {
			freeBalance: storageMap('sta:bal:', r => r ? deslice(r, 'T::Balance') : new Balance(0)),
			reservedBalance: storageMap('sta:lbo:', r => r ? deslice(r, 'T::Balance') : new Balance(0)),
			currentEra: storageValue('sta:era', r => deslice(r, 'T::BlockNumber')),
			sessionsPerEra: storageValue('sta:spe', r => deslice(r, 'T::BlockNumber')),
			intentions: storageValue('sta:wil:', r => r ? deslice(r, 'Vec<AccountId>') : []),
			lastEraLengthChange: storageValue('sta:lec', r => r ? deslice(r, 'T::BlockNumber') : new BlockNumber(0)),
			validatorCount: storageValue('sta:vac', r => r ? deslice(r, 'u32') : 0),
			nominatorsFor: storageMap('sta:nominators_for', r => r ? deslice(r, 'Vec<T::AccountId>') : []),
			currentNominatorsFor: storageMap('sta:current_nominators_for', r => r ? deslice(r, 'Vec<T::AccountId>') : []),
			earlyEraSlash: storageValue('sta:early_era_slash', r => r ? deslice(r, 'T::Balance') : new Balance(0)),
			sessionReward: storageValue('sta:session_reward', r => r ? deslice(r, 'T::Balance') : new Balance(0)),
			offlineSlashGrace: storageValue('sta:offline_slash_grace', r => r ? deslice(r, 'u32') : 0),
			slashPreferenceOf: storageMap('sta:slash_preference_of', r => r ? deslice(r, 'SlashPreference') : new SlashPreference)
		};
		this.staking.thisSessionReward = Bond
			.all([this.staking.sessionReward, this.session.lateness])
			.map(([r, l]) => Math.round(r / l));
		this.staking.currentNominatedBalance = who => this.staking.currentNominatorsFor(who)
			.map(ns => ns.map(n => this.staking.votingBalance(n)), 2)
			.map(bs => new Balance(bs.reduce((a, b) => a + b, 0)))
		this.staking.nominatedBalance = who => this.staking.nominatorsFor(who)
			.map(ns => ns.map(n => this.staking.votingBalance(n)), 2)
			.map(bs => new Balance(bs.reduce((a, b) => a + b, 0)))
		this.staking.balance = who => Bond
			.all([this.staking.freeBalance(who), this.staking.reservedBalance(who)])
			.map(([f, r]) => new Balance(f + r));
		this.staking.votingBalance = this.staking.balance;
		this.staking.stakingBalance = who => Bond
			.all([this.staking.votingBalance(who), this.staking.nominatedBalance(who)])
			.map(([f, r]) => new Balance(f + r));
		this.staking.currentStakingBalance = who => Bond
			.all([this.staking.votingBalance(who), this.staking.currentNominatedBalance(who)])
			.map(([f, r]) => new Balance(f + r));
			
		this.staking.eraLength = Bond
			.all([
				this.staking.sessionsPerEra,
				this.session.length
			]).map(([a, b]) => a * b);
		
		this.staking.validators = this.session.validators
			.map(v => v.map(who => ({
				who,
				ownBalance: this.staking.votingBalance(who),
				otherBalance: this.staking.currentNominatedBalance(who),
				nominators: this.staking.currentNominatorsFor(who)
			})), 2)
			.map(v => v
				.map(i => Object.assign({balance: i.ownBalance.add(i.otherBalance)}, i))
				.sort((a, b) => b.balance - a.balance)
			);

		this.staking.nextThreeUp = this.staking.intentions.map(
			l => ([this.session.validators, l.map(who => ({
				who, ownBalance: this.staking.votingBalance(who), otherBalance: this.staking.nominatedBalance(who)
			}) ) ]), 3
		).map(([c, l]) => l
			.map(i => Object.assign({balance: i.ownBalance.add(i.otherBalance)}, i))
			.sort((a, b) => b.balance - a.balance)
			.filter(i => !c.some(x => x+'' == i.who+''))
			.slice(0, 3)
		);

		this.staking.nextValidators = Bond
			.all([
				this.staking.intentions.map(v => v.map(who => ({
					who,
					ownBalance: this.staking.votingBalance(who),
					otherBalance: this.staking.nominatedBalance(who),
					nominators: this.staking.nominatorsFor(who)
				})), 2),
				this.staking.validatorCount
			]).map(([as, vc]) => as
				.map(i => Object.assign({balance: i.ownBalance.add(i.otherBalance)}, i))
				.sort((a, b) => b.balance - a.balance)
				.slice(0, vc)
			);
		this.staking.eraSessionsRemaining = Bond
			.all([
				this.staking.sessionsPerEra,
				this.session.currentIndex,
				this.staking.lastEraLengthChange
			]).map(([spe, si, lec]) => (spe - 1 - (si - lec) % spe));
		this.staking.eraBlocksRemaining = Bond
			.all([
				this.session.length,
				this.staking.eraSessionsRemaining,
				this.session.blocksRemaining
			]).map(([sl, sr, br]) => br + sl * sr);
		
		// TODO: if era ends early, we need to reset era length change...
*//*		this.staking.currentSession = Bond
			.all([this.session.currentIndex, this.session.length])
			.map(([r, i, l]) =>
				r + 
			);
*//*			

		{
			let referendumCount = storageValue('dem:rco', r => r ? leToNumber(r) : 0);
			let nextTally = storageValue('dem:nxt', r => r ? leToNumber(r) : 0);
			let referendumVoters = storageMap('dem:vtr:', r => r ? deslice(r, 'Vec<AccountId>') : [], i => toLE(i, 4));
			let referendumVoteOf = storageMap('dem:vot:', r => r && !!r[0], i => new VecU8([...toLE(i[0], 4), ...i[1]]));
			let referendumInfoOf = storageMap('dem:pro:', (r, index) => {
				if (r == null) return null;
				let [ends, proposal, voteThreshold] = deslice(r, ['BlockNumber', 'Proposal', 'VoteThreshold']);
				return { index, ends, proposal, voteThreshold };
			}, i => toLE(i, 4), x => x.map(x =>
				Object.assign({votes: referendumVoters(x.index)
					.map(r => r || [])
					.mapEach(v => Bond.all([
						referendumVoteOf([x.index, v]),
						this.staking.balance(v)
					]))
					.map(tallyAmounts)
				}, x), 1));
			let depositOf = storageMap('dem:dep:', r => {
				if (r) {
					let i = deslice(r, '(T::Balance, Vec<T::AccountId>)');
					return { bond: i[0], sponsors: i[1] };
				} else {
					return null;
				}
			}, i => toLE(i, 4));

			this.democracy = {
				proposed: storageValue('dem:pub', r => r ? deslice(r, 'Vec<(PropIndex, Proposal, AccountId)>') : []).map(is => is.map(i => {
					let d = depositOf(i[0]);
					return { index: i[0], proposal: i[1], proposer: i[2], sponsors: d.map(v => v ? v.sponsors : null), bond: d.map(v => v ? v.bond : null) };
				}), 2),
				active: Bond.all([nextTally, referendumCount]).map(([f, t]) => [...Array(t - f)].map((_, i) => referendumInfoOf(f + i)), 1),
				launchPeriod: storageValue('dem:lau', r => deslice(r, 'T::BlockNumber')),
				minimumDeposit: storageValue('dem:min', r => deslice(r, 'T::Balance')),
				votingPeriod: storageValue('dem:per', r => deslice(r, 'T::BlockNumber')),
				depositOf
			};
		}

		{
			let candidates = storageValue('cou:vrs', r => r ? deslice(r, 'Vec<T::AccountId>') : []);
			let registerInfoOf = storageMap('cou:reg', r => { let i = deslice(r, '(VoteIndex, u32)'); return { since: i[0], slot: i[1] }; });
			this.council = {
				candidacyBond: storageValue('cou:cbo', r => deslice(r, 'T::Balance')),
				votingBond: storageValue('cou:vbo', r => deslice(r, 'T::Balance')),
				presentSlashPerVoter: storageValue('cou:pss', r => deslice(r, 'T::Balance')),
				carryCount: storageValue('cou:cco', r => deslice(r, 'u32')),
				presentationDuration: storageValue('cou:pdu', r => deslice(r, 'T::BlockNumber')),
				inactiveGracePeriod: storageValue('cou:vgp', r => deslice(r, 'VoteIndex')),
				votingPeriod: storageValue('cou:per', r => deslice(r, 'T::BlockNumber')),
				termDuration: storageValue('cou:trm', r => deslice(r, 'T::BlockNumber')),
				desiredSeats: storageValue('cou:sts', r => deslice(r, 'u32')),
				voteCount: storageValue('cou:vco', r => r ? deslice(r, 'VoteIndex') : 0),
				active: storageValue('cou:act', r => r ? deslice(r, 'Vec<(T::AccountId, T::BlockNumber)>').map(i => ({ id: i[0], expires: i[1] })) : []),

				voters: storageValue('cou:vrs', r => r ? deslice(r, 'Vec<T::AccountId>') : []),
				candidates: candidates.mapEach((id, slot) => id.some(x => x) ? { slot, id, since: registerInfoOf(id).since } : null).map(l => l.filter(c => c)),
				candidateInfoOf: registerInfoOf
			};
		}

		{
			let proposalVoters = storageMap('cov:voters:', r => r && deslice(r, 'Vec<AccountId>'));
			let proposalVoteOf = storageMap('cov:vote:', r => r && !!r[0], i => new VecU8([...i[0], ...i[1]]));
			this.councilVoting = {
				cooloffPeriod: storageValue('cov:cooloff', r => deslice(r, 'BlockNumber')),
				votingPeriod: storageValue('cov:period', r => deslice(r, 'BlockNumber')),
				proposals: storageValue('cov:prs', r => deslice(r, 'Vec<(BlockNumber, Hash)>').map(i => ({
					ends: i[0],
					hash: i[1],
					proposal: storageMap('cov:pro', r => r && deslice(r, 'Proposal'))(i[1]),
					votes: proposalVoters(i[1]).map(r => r || []).mapEach(v => proposalVoteOf([i[1], v])).map(tally)
				}))).map(x=>x, 2)
			};
		}

		if (typeof window !== 'undefined') {
			window.polkadot = this;
			window.storageMap = storageMap;
			window.storageValue = storageValue;
		}*/
	}
}

if (typeof window !== 'undefined') {
	window.ss58_encode = ss58_encode;
	window.ss58_decode = ss58_decode;
	window.bytesToHex = bytesToHex;
	window.stringToBytes = stringToBytes;
	window.hexToBytes = hexToBytes;
	window.toLE = toLE;
	window.leToNumber = leToNumber;
	window.storageMapKey = storageMapKey;
	window.storageValueKey = storageValueKey;
	window.pretty = pretty;
	window.deslice = deslice;
	window.service = service;
	window.SubscriptionBond = SubscriptionBond;
	window.StorageBond = StorageBond;
}

module.exports = { ss58_decode, ss58_encode, pretty, stringToSeed, stringToBytes,
	hexToBytes, bytesToHex, toLEHex, leHexToNumber, toLE,
	leToNumber, Polkadot, reviver, AccountId, Hash, VoteThreshold, Moment, Balance,
	BlockNumber, Tuple, Proposal, Call
}