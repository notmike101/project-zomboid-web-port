/** Independently authored Lua lexical fixtures; no installation or Workshop bytes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalLuaRequires } from '../src/lua-requires.js';

test('captures literal bare require calls in stable unique order', () => {
    const source = `
        require'foo'
        require("bar")
        require[[long.module]]
        require('foo')
        require [=[bar]=]
        return require "last"
    `;

    assert.deepEqual(literalLuaRequires(source), ['foo', 'bar', 'long.module', 'last']);
});

test('comment and string data never create static require edges', () => {
    const source = String.raw`
        -- require "Unused"
        --[=[ require('comment') ]]
            require "still.comment" ]==] ]=]
        local a = "require 'double.data'"
        local b = 'require "single.data"'
        local c = "escaped\" require 'escaped.data'"
        local d = [==[ require "long.data" ]=] ]==]
        require "real"
    `;

    assert.deepEqual(literalLuaRequires(source), ['real']);
});

test('allows whitespace and matching long or line comments around call syntax', () => {
    const source = `
        require -- line comment
        --[==[ misleading ]=] require "hidden" ]==]
        ( -- before argument
          [=[actual.module]=] -- after argument
        )
        require --[[gap]] 'another'
    `;

    assert.deepEqual(literalLuaRequires(source), ['actual.module', 'another']);
});

test('member calls, identifier substrings and dynamic arguments are not static edges', () => {
    const source = `
        object.require("member")
        object : -- gap
            require 'method'
        object. --[[gap]] require[[member.long]]
        prerequire("prefix")
        requireSuffix("suffix")
        require(name)
        require('prefix' .. suffix)
        require(('wrapped'))
        require('choice' or other)
        require(require('inner'))
        local joined = 'prefix' .. require 'concat.operand'
    `;

    assert.deepEqual(literalLuaRequires(source), ['inner', 'concat.operand']);
});

test('decodes Lua quotes, backslashes, ordinary and numeric byte escapes', () => {
    const source = String.raw`
        require 'quote\'part'
        require "double\"part"
        require 'back\\slash'
        require '\a\b\f\n\r\t\v'
        require '\102oo\046module'
        require '\x62ar\x2Emodule'
        require '\0651'
        require '\195\169'
        require '\xC3\xA9'
    `;

    assert.deepEqual(literalLuaRequires(source), ['quote\'part', 'double"part', 'back\\slash', '\u0007\b\f\n\r\t\v', 'foo.module', 'bar.module', 'A1', 'é']);
});

test('decodes Unicode escapes, escaped newlines and z whitespace elision', () => {
    const source = String.raw`require '\u{1F600}.\u{6D}odule'; require 'a\z   
        b'`;

    assert.deepEqual(literalLuaRequires(source), ['😀.module', 'ab']);
    assert.deepEqual(literalLuaRequires('require \'a\\\r\nb\'; require \'c\\\n\rd\'; require \'e\\\rf\''), ['a\nb', 'c\nd', 'e\nf']);
});

test('long strings drop the initial newline and normalize Lua newline pairs without escapes', () => {
    const source = 'require [=[\r\nfirst\r\nsecond\n\rthird\rfourth\\n]=]';

    assert.deepEqual(literalLuaRequires(source), ['first\nsecond\nthird\nfourth\\n']);
});

test('malformed literals do not invent module names or expose their string bodies', () => {
    assert.deepEqual(literalLuaRequires(String.raw`require '\q require "hidden"'; require '\256'; require '\xGG'; require '\u{}'; require '\u{110000}'; require '\xFF'; require "real"`), ['real']);
    assert.deepEqual(literalLuaRequires('require "unterminated require \'hidden\''), []);
    assert.deepEqual(literalLuaRequires('--[==[ unterminated ]] require "hidden"'), []);
    assert.deepEqual(literalLuaRequires('local data = [=[ unterminated require "hidden"'), []);
    assert.deepEqual(literalLuaRequires('require \'raw\nnewline\'; require \'real\''), ['real']);
});

test('lexical extraction does not pretend to resolve shadowed names or dead branches', () => {
    const source = `local require = customLoader; require 'shadowed'; if false then require 'dead.branch' end`;

    assert.deepEqual(literalLuaRequires(source), ['shadowed', 'dead.branch']);
});

test('long delimiter scans handle repeated mismatches and empty literal module names', () => {
    const source = `--[====[${']===]'.repeat(1_000)} require "hidden" ]====] require [==[${']=[x'.repeat(1_000)}]==] require ''`;

    assert.deepEqual(literalLuaRequires(source), [']=[x'.repeat(1_000), '']);
});
