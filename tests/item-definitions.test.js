import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { normalItemIcon, parseItemDefinitions, parseModelDefinitions, parseClothingDefinition } from '../src/item-definitions.js';
import { seedOriginalWearables } from '../src/native-game-resources.js';
import { completeActions } from './queue-test-helpers.js';

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
    assert.equal(records[0].weight, 0.699_999_988_079_071);
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

test('Hidden follows original Boolean.parseBoolean while DisplayCategory preserves its own spelling', () => {
    const [hidden, visible, absent] = parseItemDefinitions(`module Fixture {
        item Hidden { hidden = TRUE, DisplayCategory = "Medical Supplies", }
        item Visible { Hidden = notTrue, }
        item Absent { }
    }`, 'presentation.txt');

    assert.equal(hidden.hidden, true);
    assert.equal(hidden.displayCategory, 'Medical Supplies');
    assert.equal(visible.hidden, false);
    assert.ok(!Object.hasOwn(absent, 'hidden'));
});

test('CanBeEquipped remains independent from a clothing BodyLocation', () => {
    const [definition] = parseItemDefinitions(`module Fixture {
        item Harness { BodyLocation = Torso1, CanBeEquipped = Back, }
    }`, 'equipment.txt');

    assert.equal(definition.bodyLocation, 'Torso1');
    assert.equal(definition.canBeEquipped, 'Back');
});

test('script normal texture uses explicit Icon or the first IconsForTexture without inventing missing metadata', () => {
    const [explicit, indexed, absent] = parseItemDefinitions(`module Fixture {
        item Explicit { IconsForTexture = First;Second, Icon = Chosen, }
        item Indexed { IconsForTexture = " First ; Second ", }
        item Absent { ClothingItem = MissingVisual, }
    }`, 'icons.txt');

    assert.equal(normalItemIcon(explicit), 'Chosen');
    assert.equal(normalItemIcon(indexed), 'First');
    assert.equal(normalItemIcon(absent), null);

    for (const rawFields of [
        [{ name: 'Icon', value: '../Other' }, { name: 'IconsForTexture', value: 'First;Second' }],
        [{ name: 'IconsForTexture', value: '' }],
        [{ name: 'IconsForTexture', value: ';Second' }],
        [{ name: 'IconsForTexture', value: 'other/path;Second' }],
        [{ name: 'IconsForTexture', value: 7 }],
    ]) {
        assert.throws(() => normalItemIcon({ fullType: 'Fixture.BadIcon', rawFields }), /Invalid original.*Icon/u);
    }
});

test('source Tags become detached canonical resource IDs without adding missing gameplay fields', () => {
    const provenance = { path: 'tags.txt', build: 'synthetic' };
    const text = `module Test { item AwkwardHands {
        ItemType = base:clothing, BodyLocation = base:hands,
        Tags = "AwkwardGloves; MOD:Some/Path; Other:Nested:Path",
        UnknownTagMetadata = KeepMe,
    } item BareHands { BodyLocation = base:hands, } }`;
    const [tagged, bare] = parseItemDefinitions(text, provenance);

    assert.deepEqual(tagged.tags, ['base:awkwardgloves', 'mod:some/path', 'other:nested:path']);
    assert.equal(tagged.rawFields.find(({ name }) => name === 'Tags').value, 'AwkwardGloves; MOD:Some/Path; Other:Nested:Path');
    assert.equal(tagged.rawFields.at(-1).value, 'KeepMe');
    assert.equal(tagged.rawFields.find(({ name }) => name === 'Tags').offset, text.indexOf('Tags'));
    assert.ok(!Object.hasOwn(tagged, 'conditionMax'));
    assert.ok(!Object.hasOwn(tagged, 'weight'));
    assert.ok(!Object.hasOwn(bare, 'tags'));
    provenance.path = 'changed';
    tagged.tags[0] = 'changed';
    assert.equal(tagged.provenance.path, 'tags.txt');
    assert.deepEqual(parseItemDefinitions(text, provenance)[0].tags, ['base:awkwardgloves', 'mod:some/path', 'other:nested:path']);

    for (const value of [':AwkwardGloves', 'Base:', ';AwkwardGloves', 'AwkwardGloves;', 'One;;Two']) {
        assert.throws(() => parseItemDefinitions(`module Test { item Bad { Tags = "${value}", } }`, 'bad-tags.txt'), /bad-tags.txt.*Tags/);
    }
});

test('original wearable seeding applies script constructor defaults only at registration and preserves existing owners', async () => {
    const subject = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const group = subject.equipmentOperation('groupGet', 'Human', true);

    for (const name of ['Shoes', 'Hands']) {
        subject.equipmentOperation('locationAdd', group, subject.equipmentOperation('lookup', name));
    }

    const source = `module Base {
        item Shoes_ArmyBoots { BodyLocation = base:shoes, ConditionMax = 30, Weight = 2, RemoveOnBroken = false, }
        item Shoes_FlipFlop { BodyLocation = base:shoes, ConditionMax = 1, Weight = .2, }
    } module Test {
        item LightHands { ItemType = base:clothing, BodyLocation = base:hands, Weight = .1, Tags = AwkwardGloves;ShowPoison, }
        item HeavyHands { ItemType = base:clothing, BodyLocation = base:hands, Weight = 1, Tags = IgnoreZombieDensity;AwkwardGloves;ShowPoison;NoDetect, }
        item DefaultHands { BodyLocation = base:hands, }
        item SourceHands { BodyLocation = base:hands, ConditionMax = 4, ConditionLowerChanceOneIn = 3, Weight = .5, RunSpeedModifier = .8, RemoveOnBroken = false, }
        item Unrelated { BodyLocation = base:head, }
        item AuthoredBag { Type = Container, Weight = 2, Capacity = 60, WeightReduction = 130, MaxItemSize = 5, OnlyAcceptCategory = Clothing, }
    }`;
    const content = {
        manifest: { sourceBuild: { version: '42.0.0' }, files: [{ path: 'media/scripts/generated/items/clothing.txt' }] },
        /**
         * Supply the synthetic source file consumed by wearable seeding.
         *
         * @returns {object} Source metadata and text reader.
         */
        getFile: () => ({
            size: source.length,
            lastModified: 123,
            /**
             * Read synthetic source without external content.
             *
             * @returns {Promise<string>} Fixture script text.
             */
            text: () => Promise.resolve(source),
        }),
    };
    const existing = subject.registerItemDefinition({
        fullType: 'Base.Shoes_ArmyBoots', bodyLocation: 'base:shoes', conditionMax: 7,
        conditionLowerChanceOneIn: 4, removeOnBroken: false, stackLimit: 1, weight: 3,
        provenance: { path: 'saved-owner' },
    }, { owner: 'saved-mod' });

    await seedOriginalWearables(subject, content);
    const definitions = subject.itemDefinitions();

    assert.deepEqual(definitions.map(({ fullType }) => fullType), [
        'Base.Shoes_ArmyBoots', 'Base.Shoes_FlipFlop', 'Test.LightHands', 'Test.HeavyHands',
        'Test.DefaultHands', 'Test.SourceHands', 'Test.AuthoredBag',
    ]);
    assert.deepEqual(definitions[0], existing);
    const bag = definitions.find(({ fullType }) => fullType === 'Test.AuthoredBag');

    assert.deepEqual([bag.capacity, bag.weightReduction, bag.maxItemSize, bag.onlyAcceptCategory], [48, 100, 5, 'clothing']);
    assert.equal(bag.sourceCategory, 'Container');
    const bagId = subject.command({ type: 'spawnItem', fullType: bag.fullType, x: 5, y: 5 }).id;

    assert.equal(subject.getContainer(subject.getItem(bagId).internalContainerId).capacity, 48);

    for (const [fullType, weight, tags, knownPoison] of [
        ['Test.LightHands', 0.1, ['base:awkwardgloves', 'base:showpoison'], true],
        ['Test.HeavyHands', 1, ['base:ignorezombiedensity', 'base:awkwardgloves', 'base:showpoison', 'base:nodetect'], false],
        ['Test.DefaultHands', 1, [], false],
    ]) {
        const definition = definitions.find((entry) => entry.fullType === fullType);

        assert.equal(definition.owner, 'ProjectZomboid');
        assert.equal(definition.conditionMax, 10);
        assert.equal(definition.conditionLowerChanceOneIn, 10);
        assert.equal(definition.removeOnBroken, true);
        assert.equal(definition.runSpeedModifier, 1);
        assert.equal(definition.stackLimit, 1);
        assert.ok(Math.abs(definition.weight - weight) < 1e-6);
        assert.deepEqual(definition.tags, tags);
        assert.equal(definition.provenance.path, 'media/scripts/generated/items/clothing.txt');
        const id = subject.command({ type: 'spawnItem', fullType, x: 5, y: 5 }).id;

        assert.equal(subject.items().find((item) => item.id === id).condition, 10);
        assert.equal(subject.sourceActions.playerIsKnownPoison(id), knownPoison,
            'manifest-authored Tags must reach native poison detection intact through wearable provisioning');
        subject.command({ type: 'pickup', id });
        completeActions(subject);
        subject.command({ type: 'wear', id });
        assert.equal(subject.isWearingAwkwardGloves(), tags.includes('base:awkwardgloves'));
    }

    const explicit = definitions.find(({ fullType }) => fullType === 'Test.SourceHands');

    assert.equal(explicit.conditionMax, 4);
    assert.equal(explicit.conditionLowerChanceOneIn, 3);
    assert.equal(explicit.weight, 0.5);
    assert.equal(explicit.runSpeedModifier, Math.fround(0.8));
    assert.equal(explicit.removeOnBroken, false);
    assert.ok(!Object.hasOwn(parseItemDefinitions(source, 'synthetic')[2], 'conditionMax'));
    await seedOriginalWearables(subject, content);
    assert.deepEqual(subject.itemDefinitions(), definitions);
});

test('original wearable seeding still refuses missing required footwear before registration', async () => {
    const subject = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const content = {
        manifest: { sourceBuild: { version: '42.0.0' }, files: [{ path: 'media/scripts/generated/items/clothing.txt' }] },
        /**
         * Supply a fixture intentionally missing the required footwear.
         *
         * @returns {object} Synthetic source text reader.
         */
        getFile: () => ({
            /**
             * Read the synthetic hands-only script.
             *
             * @returns {Promise<string>} Fixture script text.
             */
            text: () => Promise.resolve('module Test { item Hands { BodyLocation = base:hands, } }'),
        }),
    };

    await assert.rejects(seedOriginalWearables(subject, content), /Original footwear definition missing/);
    assert.deepEqual(subject.itemDefinitions(), []);
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

test('world presentation fields preserve authored values without adding renderer defaults', () => {
    const [item] = parseItemDefinitions('module A { item Ground { WorldScale = .75, WorldRender = false, StaticModel = Blade, ScaleWorldIcon = .4, Cosmetic = true, WorldTexture = WItem_Authored, } }', 'world.txt');

    assert.equal(item.worldScale, 0.75);
    assert.equal(item.worldRender, false);
    assert.equal(item.staticModel, 'Blade');
    assert.equal(item.scaleWorldIcon, 0.4);
    assert.equal(item.cosmetic, true);
    assert.equal(item.worldTexture, 'WItem_Authored');
    const [model] = parseModelDefinitions('module A { model Ground { mesh = Mesh, shader = basicEffect, static = true, cullFace = Back, invertX = false, undoCoreScale = true, } }', 'world-model.txt');

    assert.equal(model.shader, 'basicEffect');
    assert.equal(model.isStatic, true);
    assert.equal(model.cullFace, 'Back');
    assert.equal(model.invertX, false);
    assert.equal(model.undoCoreScale, true);
    const clothing = parseClothingDefinition('<clothingItem><m_AttachBone>Bip01_Head</m_AttachBone><m_Static>true</m_Static><m_AllowRandomTint>false</m_AllowRandomTint><m_AllowRandomHue>true</m_AllowRandomHue><m_Shader>basicEffect</m_Shader><m_BaseTextures>base</m_BaseTextures><textureChoices>choice</textureChoices></clothingItem>', 'head.xml');

    assert.equal(clothing.attachBone, 'Bip01_Head');
    assert.equal(clothing.isStatic, true);
    assert.equal(clothing.allowRandomTint, false);
    assert.equal(clothing.allowRandomHue, true);
    assert.equal(clothing.shader, 'basicEffect');
    assert.deepEqual(clothing.baseTextures, ['base']);
    assert.deepEqual(clothing.textureChoices, ['choice']);
});
