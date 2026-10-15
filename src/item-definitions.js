// Original text is data only. Missing gameplay fields stay missing; no engine defaults.
const MAX_TEXT = 32 * 1_024 * 1_024;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/;

/**
 * Parse bounded module/block/field syntax without executing scripts.
 *
 * @param {string} text - Original script source.
 * @param {object|string} provenance - Caller-supplied source identity.
 * @param {string} wanted - Record kind to extract.
 * @returns {object} Ordered records and source-context error helper.
 */
function scriptRecords(text, provenance, wanted) {
    const source = typeof provenance === 'string' ? provenance : provenance?.path ?? '<source>';
    /**
     * Reject a malformed source token or recognized field.
     *
     * @param {string} message - Diagnostic reason.
     * @param {number} [offset] - Source character offset.
     * @returns {never} Always throws.
     */
    const fail = (message, offset = 0) => {
        throw new TypeError(`${source}:${offset}: ${message}`);
    };

    if (typeof text !== 'string' || text.length > MAX_TEXT) {
        fail('Script text exceeds limit.');
    }

    const tokens = [];
    let at = 0;

    while (at < text.length) {
        const offset = at;
        const c = text[at];

        if (/\s|\uFEFF/.test(c)) {
            at++;
        } else if (text.startsWith('//', at)) {
            at = text.indexOf('\n', at);

            if (at < 0) {
                at = text.length;
            }
        } else if (text.startsWith('/*', at)) {
            const end = text.indexOf('*/', at + 2);

            if (end === -1) {
                fail('Unclosed comment.', at);
            }

            at = end + 2;
        } else if ('{},='.includes(c)) {
            tokens.push({ value: c, offset, punctuation: true });
            at++;
        } else if (c === '"' || c === '\'') {
            const quote = c;
            let value = '';

            at++;
            while (at < text.length && text[at] !== quote) {
                if (text[at] === '\\' && [quote, '\\'].includes(text[at + 1])) {
                    at++;
                }

                value += text[at++];
            }

            if (text[at] !== quote) {
                fail('Unclosed string.', offset);
            }

            at++;
            tokens.push({ value, offset, punctuation: false });
        } else {
            while (at < text.length && !/[\s{},="']/u.test(text[at]) && !text.startsWith('//', at) && !text.startsWith('/*', at)) {
                at++;
            }

            tokens.push({ value: text.slice(offset, at), offset, punctuation: false });
        }

        if (tokens.length > 2_000_000) {
            fail('Script token limit exceeded.', at);
        }
    }

    let pos = 0;
    /**
     * Consume one token, optionally requiring punctuation.
     *
     * @param {string} [value] - Required punctuation.
     * @returns {object} Source token with offset.
     */
    const consume = (value) => {
        const token = tokens[pos++];

        if (!token || (value !== undefined && (!token.punctuation || token.value !== value))) {
            fail(`Expected ${value ?? 'name'}.`, token?.offset ?? text.length);
        }

        return token;
    };

    /**
     * Read property fields and nested metadata blocks in source order.
     *
     * @param {number} depth - Current nesting depth.
     * @returns {object[]} Ordered detached fields.
     */
    const block = (depth) => {
        if (depth > 32) {
            fail('Script nesting limit exceeded.', tokens[pos]?.offset);
        }

        consume('{');
        const fields = [];

        while (tokens[pos] && !(tokens[pos].punctuation && tokens[pos].value === '}')) {
            const start = consume();

            if (start.punctuation) {
                fail('Expected field or block name.', start.offset);
            }

            if (tokens[pos]?.value === '=' && tokens[pos].punctuation) {
                consume('=');
                const values = [];

                while (tokens[pos] && !(tokens[pos].punctuation && tokens[pos].value === ',')) {
                    const token = consume();

                    if (token.punctuation) {
                        fail(`Expected comma after ${start.value}.`, token.offset);
                    }

                    values.push(token.value);
                }

                consume(',');

                if (!values.length) {
                    fail(`Empty field ${start.value}.`, start.offset);
                }

                fields.push({ name: start.value, value: values.join(' '), offset: start.offset });
            } else {
                const names = [];

                while (tokens[pos] && !tokens[pos].punctuation) {
                    names.push(consume().value);
                }

                fields.push({ name: start.value, value: names.join(' '), offset: start.offset, children: block(depth + 1) });
            }
        }

        consume('}');

        return fields;
    };

    const records = [];

    while (pos < tokens.length) {
        const keyword = consume();

        if (keyword.value !== 'module' || keyword.punctuation) {
            fail('Expected module.', keyword.offset);
        }

        const module = consume();

        if (module.punctuation) {
            fail('Expected module name.', module.offset);
        }

        // imports is a comma-separated module list, unlike ordinary property blocks.
        consume('{');
        while (tokens[pos] && !(tokens[pos].value === '}' && tokens[pos].punctuation)) {
            const kind = consume();

            if (kind.value === 'imports' && !kind.punctuation) {
                consume('{');
                while (tokens[pos] && !(tokens[pos].value === '}' && tokens[pos].punctuation)) {
                    const imported = consume();

                    if (imported.punctuation) {
                        fail('Expected imported module.', imported.offset);
                    }

                    if (tokens[pos]?.value === ',') {
                        consume(',');
                    }
                }

                consume('}');
                continue;
            }

            const name = consume();

            if (kind.punctuation || name.punctuation) {
                fail('Expected record kind and name.', kind.offset);
            }

            const rawFields = block(0);

            if (kind.value === wanted) {
                records.push({ fullType: `${module.value}.${name.value}`, rawFields, provenance: structuredClone(provenance) });
            }
        }

        consume('}');
    }

    return { records, fail };
}

/**
 * Normalize source Tags with ResourceLocation's first-colon/default-base rule.
 *
 * @param {string} value - Semicolon-delimited source tag identifiers.
 * @param {() => never} fail - Source-context rejection for an empty namespace or path.
 * @returns {string[]} Detached lowercase resource identifiers in source order.
 */
function canonicalTags(value, fail) {
    return value.split(';').map((tag) => {
        const identifier = tag.trim();
        const colon = identifier.indexOf(':');
        const namespace = colon === -1 ? 'base' : identifier.slice(0, colon);
        const path = colon === -1 ? identifier : identifier.slice(colon + 1);

        if (!namespace || !path) {
            fail();
        }

        return `${namespace.toLowerCase()}:${path.toLowerCase()}`;
    });
}

/**
 * Map only fields explicitly present in source to the consumer contract.
 *
 * @param {string} text - Original script source.
 * @param {object|string} provenance - Source identity.
 * @param {string} kind - Item or model record kind.
 * @param {object} mapping - Recognized field names, keys and value kinds.
 * @returns {object[]} Detached records in original order.
 */
function definitions(text, provenance, kind, mapping) {
    const { records, fail } = scriptRecords(text, provenance, kind);
    const names = new Map(Object.entries(mapping).map(([name, spec]) => [kind === 'item' ? name.toLowerCase() : name, spec]));

    for (const record of records) {
        // Original Item constructor's script actualWeight precedes ordered DoParam.
        let actualWeight = 1;

        for (const field of record.rawFields) {
            const spec = names.get(kind === 'item' ? field.name.trim().toLowerCase() : field.name);

            if (!spec || field.children) {
                continue;
            }

            const [key, type] = spec;
            let value = field.value;

            if (type === 'boolean') {
                if (!['true', 'false'].includes(value)) {
                    fail(`Invalid ${field.name} boolean.`, field.offset);
                }

                value = value === 'true';
            } else if (type === 'tags') {
                value = canonicalTags(value, () => fail(`Invalid ${field.name} resource location.`, field.offset));
            } else if (type) {
                const number = Number(value);

                const signed = ['javaFloat', 'javaInt', 'javaWeight'].includes(type);

                if (!NUMBER.test(value) || !Number.isFinite(number) || (!signed && number < 0)
                    || (type === 'javaInt' && (!/^[+-]?\d+$/u.test(value) || number < -2_147_483_648 || number > 2_147_483_647))
                    || (type === 'integer' && !Number.isSafeInteger(number))
                    || (type === 'positiveInteger' && (!Number.isSafeInteger(number) || number < 1))
                    || (type === 'positive' && number <= 0)) {
                    fail(`Invalid ${field.name} numeric value.`, field.offset);
                }

                value = signed && type !== 'javaInt' ? Math.fround(number) : number;

                if (!Number.isFinite(value)) {
                    fail(`Invalid ${field.name} float value.`, field.offset);
                }

                if (type === 'javaWeight') {
                    value = Math.max(0, value);
                    actualWeight = value;
                }
            }

            if (key === 'capacity') {
                const bound = Math.fround(50 - actualWeight);

                if (Math.fround(value) > bound) {
                    value = Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(bound)));
                }
            }

            record[key] = value;
        }
    }

    return records;
}

/**
 * Ordered item records, detached provenance and unknown raw fields; no defaults.
 *
 * @param {string} text - Original item script.
 * @param {object|string} provenance - Source identity.
 * @returns {object[]} Ordered item definitions, absent fields omitted.
 */
function parseItemDefinitions(text, provenance) {
    return definitions(text, provenance, 'item', {
        ItemType: ['type'], Type: ['type'], DisplayName: ['displayName'], BodyLocation: ['bodyLocation'],
        CanBeEquipped: ['canBeEquipped'],
        ConditionMax: ['conditionMax', 'integer'], ConditionLowerChanceOneIn: ['conditionLowerChanceOneIn', 'positiveInteger'],
        RemoveOnBroken: ['removeOnBroken', 'boolean'], Weight: ['weight', 'javaWeight'], RunSpeedModifier: ['runSpeedModifier', 'number'],
        WorldStaticModel: ['worldStaticModel'], ClothingItem: ['clothingItem'], Tags: ['tags', 'tags'],
        Capacity: ['capacity', 'javaInt'], WeightReduction: ['weightReduction', 'javaInt'], MaxItemSize: ['maxItemSize', 'javaFloat'],
        DisplayCategory: ['displayCategory'],
        OnlyAcceptCategory: ['onlyAcceptCategory'], AcceptItemFunction: ['acceptItemFunction'],
        AmmoType: ['ammoType'],
    });
}

/**
 * Ordered model records; nested attachments remain available as rawFields children.
 *
 * @param {string} text - Original model script.
 * @param {object|string} provenance - Source identity.
 * @returns {object[]} Ordered model definitions, absent fields omitted.
 */
function parseModelDefinitions(text, provenance) {
    return definitions(text, provenance, 'model', { mesh: ['mesh'], texture: ['texture'], scale: ['scale', 'positive'] });
}

/**
 * Accept only XML character code points, with tab, LF and CR exceptions.
 *
 * @param {number} code - Raw or numeric-entity Unicode code point.
 * @returns {boolean} Whether the code point is permitted in clothing XML.
 */
function isXmlCodePoint(code) {
    return Number.isInteger(code) && (code === 9 || code === 10 || code === 13
        || (code >= 0x20 && code <= 0xD7_FF)
        || (code >= 0xE0_00 && code <= 0xFF_FD)
        || (code >= 0x1_00_00 && code <= 0x10_FF_FF));
}

/**
 * Parse the observed flat clothingItem XML safely in browsers and Node, without entities/DTD.
 *
 * @param {string} text - Original clothing XML.
 * @param {object|string} provenance - Source identity.
 * @returns {object} Source male/female models, ordered textures, rawFields and provenance.
 */
function parseClothingDefinition(text, provenance) {
    const source = typeof provenance === 'string' ? provenance : provenance?.path ?? '<source>';
    /**
     * Reject malformed or unsupported XML without resolving external resources.
     *
     * @returns {never} Always throws.
     */
    const fail = () => {
        throw new TypeError(`${source}: malformed or unsupported clothing XML.`);
    };

    if (typeof text !== 'string' || text.length > 1_024 * 1_024 || /<!doctype|<!entity/i.test(text)) {
        fail();
    }

    for (const character of text) {
        if (!isXmlCodePoint(character.codePointAt(0))) {
            fail();
        }
    }

    /**
     * Decode only predefined XML and valid numeric character entities.
     *
     * @param {string} value - Source element text.
     * @returns {string} Decoded element text.
     */
    const entity = (value) => value.replaceAll(/&([^;]*);|&/g, (match, name) => {
        const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

        if (Object.hasOwn(predefined, name)) {
            return predefined[name];
        }

        if (!/^#(?:\d+|x[\dA-Fa-f]+)$/.test(name ?? '')) {
            fail();
        }

        const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));

        if (!isXmlCodePoint(code)) {
            fail();
        }

        return String.fromCodePoint(code);
    });
    // Mask headers/comments instead of deleting them, so field offsets remain source offsets.
    const body = text.replace(/^\uFEFF/, ' ').replace(/^\s*<\?xml\s[^?]*\?>/, (value) => ' '.repeat(value.length)).replaceAll(/<!--([\S\s]*?)-->/g, (value, comment) => {
        if (comment.includes('--')) {
            fail();
        }

        return ' '.repeat(value.length);
    });
    const root = /^\s*(<clothingItem\s*>)([\S\s]*)<\/clothingItem\s*>\s*$/.exec(body);

    if (!root) {
        fail();
    }

    const innerOffset = body.indexOf(root[1]) + root[1].length;
    const rawFields = [];
    const lexer = /\s+|<([A-Z_a-z][\w.-]*)\s*\/>|<([A-Z_a-z][\w.-]*)\s*>([^<]*)<\/\2\s*>/gy;
    let at = 0;

    while (at < root[2].length) {
        lexer.lastIndex = at;
        const match = lexer.exec(root[2]);

        if (!match) {
            fail();
        }

        at = lexer.lastIndex;

        if (match[1] || match[2]) {
            rawFields.push({ name: match[1] ?? match[2], value: entity(match[3] ?? '').trim(), offset: innerOffset + match.index });
        }
    }

    const result = { textures: [], rawFields, provenance: structuredClone(provenance) };

    for (const field of rawFields) {
        if (field.name === 'm_MaleModel' || field.name === 'm_FemaleModel') {
            const key = field.name === 'm_MaleModel' ? 'maleModel' : 'femaleModel';

            if (Object.hasOwn(result, key)) {
                fail();
            }

            result[key] = field.value;
        }

        if (['textureChoices', 'm_BaseTextures'].includes(field.name) && field.value) {
            result.textures.push(field.value);
        }
    }

    return result;
}

/**
 * Resolve the original script's normal texture before per-item visual selection.
 * Item.onLoad keeps an explicit Icon or initializes from IconsForTexture[0].
 *
 * @param {object} definition - Detached original raw script metadata.
 * @returns {string|null} Proven normal icon name, or absent metadata.
 */
function normalItemIcon(definition) {
    const icon = definition.rawFields?.findLast((field) => field.name.toLowerCase() === 'icon');
    const choices = definition.rawFields?.findLast((field) => field.name.toLowerCase() === 'iconsfortexture');
    let value = icon?.value;

    if (!icon && choices) {
        if (typeof choices.value !== 'string') {
            throw new TypeError(`Invalid original IconsForTexture field for ${definition.fullType}`);
        }

        value = choices.value.split(';', 1)[0].trim();
    }

    if (!icon && !choices) {
        return null;
    }

    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/u.test(value) || value.includes('..')) {
        throw new Error(`Invalid original Icon field for ${definition.fullType}`);
    }

    return value;
}

export { normalItemIcon, parseClothingDefinition, parseItemDefinitions, parseModelDefinitions };
