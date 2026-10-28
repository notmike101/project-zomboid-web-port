import assert from 'node:assert/strict';
import { installUnsafeFloatVolatile } from './unsafe-float-volatile.js';

// This authored function object is never invoked; only installer guards and identity are tested.
const getterSource = 'function agJ(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="d";f=cf(n,a,j,4);return f;}a=Q.a2;c=+Number(j);a=a.a14;return  +a[~~c>>>2];}';
const getter = new Function(`return (${getterSource})`)();
const booleanSource = 'function agN(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="n";f=cf(n,a,j,1);return f;}a=Q.a2;c=+Number(j);a=a.a10;return (a[~~c]|0);}';
const booleanGetter = new Function(`return (${booleanSource})`)();
const key = 'Java_jdk_internal_misc_Unsafe_getFloatVolatile';
const booleanKey = 'Java_jdk_internal_misc_Unsafe_getBooleanVolatile';

assert.throws(() => installUnsafeFloatVolatile(null), /Actual initialized runtime/u);
assert.throws(() => installUnsafeFloatVolatile({ Java_jdk_internal_misc_Unsafe_getFloat: Object.prototype.toString }), /Unqualified/u);
assert.throws(() => installUnsafeFloatVolatile({ Java_jdk_internal_misc_Unsafe_getFloat: getter, [key]: getter }), /existing/u);
const runtime = { Java_jdk_internal_misc_Unsafe_getFloat: getter, Java_jdk_internal_misc_Unsafe_getBoolean: booleanGetter };

installUnsafeFloatVolatile(runtime);
assert.equal(runtime[key], getter);
assert.equal(runtime[booleanKey], booleanGetter);
installUnsafeFloatVolatile(runtime);
assert.equal(runtime[key], getter);
runtime[key] = getter.bind(null);

assert.throws(() => installUnsafeFloatVolatile(runtime), /replaced/u);
const badBoolean = { Java_jdk_internal_misc_Unsafe_getFloat: getter, Java_jdk_internal_misc_Unsafe_getBoolean: Object.prototype.toString };

assert.throws(() => installUnsafeFloatVolatile(badBoolean), /Unqualified/u);
assert.equal(key in badBoolean, false);
assert.throws(() => installUnsafeFloatVolatile({ ...badBoolean, [booleanKey]: booleanGetter }), /existing/u);
const replacedBoolean = { Java_jdk_internal_misc_Unsafe_getFloat: getter, Java_jdk_internal_misc_Unsafe_getBoolean: booleanGetter };

installUnsafeFloatVolatile(replacedBoolean);
replacedBoolean[booleanKey] = booleanGetter.bind(null);
assert.throws(() => installUnsafeFloatVolatile(replacedBoolean), /replaced/u);
console.info(JSON.stringify({ pass: true, nativeGetterInvoked: false, originalCodeExecuted: false }));
