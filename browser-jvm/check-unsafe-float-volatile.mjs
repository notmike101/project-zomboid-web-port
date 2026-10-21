import assert from 'node:assert/strict';
import { installUnsafeFloatVolatile } from './unsafe-float-volatile.js';

// This authored function object is never invoked; only installer guards and identity are tested.
const getterSource = 'function agJ(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="d";f=cf(n,a,j,4);return f;}a=Q.a2;c=+Number(j);a=a.a14;return  +a[~~c>>>2];}';
const getter = new Function(`return (${getterSource})`)();
const key = 'Java_jdk_internal_misc_Unsafe_getFloatVolatile';

assert.throws(() => installUnsafeFloatVolatile(null), /Actual initialized runtime/u);
assert.throws(() => installUnsafeFloatVolatile({ Java_jdk_internal_misc_Unsafe_getFloat: Object.prototype.toString }), /Unqualified/u);
assert.throws(() => installUnsafeFloatVolatile({ Java_jdk_internal_misc_Unsafe_getFloat: getter, [key]: getter }), /existing/u);
const runtime = { Java_jdk_internal_misc_Unsafe_getFloat: getter };

installUnsafeFloatVolatile(runtime);
assert.equal(runtime[key], getter);
installUnsafeFloatVolatile(runtime);
assert.equal(runtime[key], getter);
runtime[key] = getter.bind(null);

assert.throws(() => installUnsafeFloatVolatile(runtime), /replaced/u);
console.info(JSON.stringify({ pass: true, installerGuards: 6, nativeGetterInvoked: false, originalCodeExecuted: false }));
