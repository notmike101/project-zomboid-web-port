import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemDefinitions, parseModelDefinitions, parseClothingDefinition } from '../src/item-definitions.js';

test('script structure preserves source order, provenance and unknown quoted fields without defaults', () => {
    const provenance = { path: 'authored.txt', build: 'synthetic' };
    const text = `/* { misleading } */ module Example { imports { Other, } item Shoe {
        ItemType = base:clothing, DisplayName = "Shoe, {blue}", BodyLocation = base:shoes,
        ConditionMax = 12, ConditionLowerChanceOneIn = 3, RemoveOnBroken = false,
        Weight = 0.7, RunSpeedModifier = .8, WorldStaticModel = Ground, ClothingItem = Worn,
        Odd = "a // b", // } comment
    } item Empty { Icon = Missing, constructor = sourceMetadata, } } module Other { item Shoe { ConditionMax = 2, } }`;
    const records = parseItemDefinitions(text, provenance);

    assert.deepEqual(records.map((v) => v.fullType), ['Example.Shoe', 'Example.Empty', 'Other.Shoe']);
    assert.equal(records[0].type, 'base:clothing');
    assert.equal(records[0].displayName, 'Shoe, {blue}');
    assert.equal(records[0].bodyLocation, 'base:shoes');
    assert.equal(records[0].conditionMax, 12);
    assert.equal(records[0].conditionLowerChanceOneIn, 3);
    assert.equal(records[0].removeOnBroken, false);
    assert.equal(records[0].weight, 0.7);
    assert.equal(records[0].runSpeedModifier, 0.8);
    assert.equal(records[0].worldStaticModel, 'Ground');
    assert.equal(records[0].clothingItem, 'Worn');
    assert.equal(records[0].rawFields.at(-1).value, 'a // b');
    assert.ok(!Object.hasOwn(records[1], 'conditionMax'));
    assert.equal(records[1].rawFields.at(-1).value, 'sourceMetadata');
    assert.equal(records[0].rawFields[0].offset, text.indexOf('ItemType'));
    provenance.path = 'changed';
    assert.equal(records[0].provenance.path, 'authored.txt');
    records[0].provenance.path = 'detached';
    assert.equal(records[1].provenance.path, 'authored.txt');
});

test('malformed script structure and recognized numeric or boolean values reject with source context', () => {
    for (const value of ['NaN', '1oops', '-1', '1.2']) {
        assert.throws(() => parseItemDefinitions(`module A { item B { ConditionMax = ${value}, } }`, 'bad.txt'), /bad.txt.*ConditionMax/);
    }

    assert.throws(() => parseItemDefinitions('module A { item B { RemoveOnBroken = yes, } }', 'bad.txt'), /bad.txt.*RemoveOnBroken/);

    for (const text of ['module A { item B {', 'module A { item B { Odd = "unclosed, } }', '/* unclosed', 'module A { item B { Odd = x } }']) {
        assert.throws(() => parseItemDefinitions(text, 'bad.txt'), /bad.txt/);
    }
});

test('model fields remain source-defined and preserve nested attachment metadata', () => {
    const records = parseModelDefinitions('module A { model Ground { mesh = WorldItems/Authored, scale = .33, attachment world { offset = 0 1 0, } } model Bare { texture = Authored, } }', 'models.txt');

    assert.equal(records[0].fullType, 'A.Ground');
    assert.equal(records[0].mesh, 'WorldItems/Authored');
    assert.equal(records[0].scale, 0.33);
    assert.equal(records[0].rawFields.at(-1).children[0].value, '0 1 0');
    assert.ok(!Object.hasOwn(records[1], 'scale'));
    assert.throws(() => parseModelDefinitions('module A { model B { scale = Infinity, } }', 'models.txt'), /scale/);
});

test('bounded clothing XML preserves model and texture names, and empty models remain unsupported', () => {
    const clothing = parseClothingDefinition('<?xml version="1.0"?><clothingItem><m_MaleModel>media\\models_X\\M.X</m_MaleModel><m_FemaleModel>F.X</m_FemaleModel><textureChoices>a&amp;b</textureChoices><textureChoices>c</textureChoices><m_GUID>authored</m_GUID></clothingItem>', 'worn.xml');

    assert.equal(clothing.maleModel, 'media\\models_X\\M.X');
    assert.equal(clothing.femaleModel, 'F.X');
    assert.deepEqual(clothing.textures, ['a&b', 'c']);
    assert.equal(clothing.rawFields.at(-1).name, 'm_GUID');
    const offsetSource = '<?xml version="1.0"?>\n<!-- authored -->\n<clothingItem><m_MaleModel/></clothingItem>';

    assert.equal(parseClothingDefinition(offsetSource, 'offset.xml').rawFields[0].offset, offsetSource.indexOf('<m_MaleModel'));
    const unsupported = parseClothingDefinition('<clothingItem><m_MaleModel/><m_FemaleModel></m_FemaleModel><m_BaseTextures>base</m_BaseTextures></clothingItem>', 'empty.xml');

    assert.equal(unsupported.maleModel, '');
    assert.equal(unsupported.femaleModel, '');
    assert.deepEqual(unsupported.textures, ['base']);

    for (const text of ['<!DOCTYPE clothingItem [<!ENTITY x SYSTEM "file:///secret">]><clothingItem/>', '<clothingItem><m_MaleModel>x</m_FemaleModel></clothingItem>', '<clothingItem><textureChoices>&unknown;</textureChoices></clothingItem>', '<clothingItem><textureChoices>&#1;</textureChoices></clothingItem>', '<clothingItem><m_MaleModel>x</m_MaleModel>', '<other/>']) {
        assert.throws(() => parseClothingDefinition(text, 'bad.xml'), /bad.xml/);
    }
});
