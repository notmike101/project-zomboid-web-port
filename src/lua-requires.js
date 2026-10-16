/** @file Lexical literal require edges without executing or parsing game Lua. */

const ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, '\'': 39 };
const IDENTIFIER_START = /[A-Za-z_]/u;
const IDENTIFIER_PART = /[\dA-Za-z_]/u;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Identify Lua's ASCII whitespace, including all newline forms.
 *
 * @param {number} code - Character or byte code.
 * @returns {boolean} Whether it is whitespace.
 */
function isSpace(code) {
    return code === 32 || (code >= 9 && code <= 13);
}

/**
 * Read a hexadecimal digit without accepting partial numeric escapes.
 *
 * @param {number} code - Character or byte code.
 * @returns {number} Digit value, or -1.
 */
function hexDigit(code) {
    if (code >= 48 && code <= 57) {
        return code - 48;
    }

    if (code >= 65 && code <= 70) {
        return code - 55;
    }

    if (code >= 97 && code <= 102) {
        return code - 87;
    }

    return -1;
}

/**
 * Read an opening long-bracket delimiter.
 *
 * @param {string} source - Lua source.
 * @param {number} start - Opening bracket position.
 * @returns {number} Content position, or -1 if not a delimiter.
 */
function longStart(source, start) {
    if (source[start] !== '[') {
        return -1;
    }

    let index = start + 1;

    while (source[index] === '=') {
        index++;
    }

    return source[index] === '[' ? index + 1 : -1;
}

/**
 * Scan matching long brackets in one forward pass, not nested delimiter searches.
 *
 * @param {string} source - Lua source.
 * @param {number} start - Opening bracket position.
 * @param {number} content - First content position.
 * @returns {number} Closing delimiter position, or -1.
 */
function longEnd(source, start, content) {
    const equals = content - start - 2;
    let index = content;

    while (index < source.length) {
        if (source[index] !== ']') {
            index++;
            continue;
        }

        const closing = index++;

        while (source[index] === '=') {
            index++;
        }

        if (source[index] === ']' && index - closing - 1 === equals) {
            return closing;
        }
    }

    return -1;
}

/**
 * Skip whitespace and comments without exposing their contents as tokens.
 *
 * @param {string} source - Lua source.
 * @param {number} start - First possible trivia position.
 * @returns {number} First significant position.
 */
function skipTrivia(source, start) {
    let index = start;

    while (index < source.length) {
        if (isSpace(source.charCodeAt(index))) {
            index++;
        } else if (source[index] === '-' && source[index + 1] === '-') {
            const opening = index + 2;
            const content = longStart(source, opening);

            if (content >= 0) {
                const closing = longEnd(source, opening, content);

                if (closing < 0) {
                    return source.length;
                }

                index = closing + content - opening;
            } else {
                index += 2;

                while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
                    index++;
                }
            }
        } else {
            break;
        }
    }

    return index;
}

/**
 * Decode short literals as Lua bytes, then UTF-8 as used by the VM string bridge.
 * Invalid escapes or non-UTF-8 bytes have no invented static module value.
 *
 * @param {string} raw - Literal body without quote delimiters.
 * @returns {string|undefined} Decoded value when representable.
 */
function decodeShort(raw) {
    if (!raw.includes('\\')) {
        return /[\r\n]/u.test(raw) ? undefined : raw;
    }

    const bytes = ENCODER.encode(raw);
    let written = 0;

    for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];

        if (byte === 10 || byte === 13) {
            return undefined;
        }

        if (byte !== 92) {
            bytes[written++] = byte;
            continue;
        }

        const escape = bytes[++index];
        const ordinary = ESCAPES[String.fromCharCode(escape)];

        if (ordinary !== undefined) {
            bytes[written++] = ordinary;
        } else if (escape === 10 || escape === 13) {
            if ((bytes[index + 1] === 10 || bytes[index + 1] === 13) && bytes[index + 1] !== escape) {
                index++;
            }

            bytes[written++] = 10;
        } else if (escape === 122) {
            while (isSpace(bytes[index + 1])) {
                index++;
            }
        } else if (escape >= 48 && escape <= 57) {
            let value = escape - 48;
            let digits = 1;

            while (digits < 3 && bytes[index + 1] >= 48 && bytes[index + 1] <= 57) {
                value = value * 10 + bytes[++index] - 48;
                digits++;
            }

            if (value > 255) {
                return undefined;
            }

            bytes[written++] = value;
        } else if (escape === 120) {
            const high = hexDigit(bytes[++index]);
            const low = hexDigit(bytes[++index]);

            if (high < 0 || low < 0) {
                return undefined;
            }

            bytes[written++] = high * 16 + low;
        } else if (escape === 117 && bytes[++index] === 123) {
            let value = 0;
            let digits = 0;

            while (hexDigit(bytes[index + 1]) >= 0) {
                value = value * 16 + hexDigit(bytes[++index]);
                digits++;

                if (value > 0x10_FF_FF) {
                    return undefined;
                }
            }

            if (!digits || bytes[++index] !== 125 || (value >= 0xD8_00 && value <= 0xDF_FF)) {
                return undefined;
            }

            const encoded = ENCODER.encode(String.fromCodePoint(value));

            bytes.set(encoded, written);
            written += encoded.length;
        } else {
            return undefined;
        }
    }

    try {
        return DECODER.decode(bytes.subarray(0, written));
    } catch {
        return undefined;
    }
}

/**
 * Consume a string token, decoding only potential require arguments.
 *
 * @param {string} source - Lua source.
 * @param {number} start - String delimiter position.
 * @param {boolean} decode - Whether the caller needs the literal value.
 * @returns {{end: number, value: string|undefined}|undefined} String token, if present.
 */
function readLiteral(source, start, decode) {
    const quote = source[start];

    if (quote === '"' || quote === '\'') {
        let index = start + 1;

        while (index < source.length) {
            if (source[index] === quote) {
                return { end: index + 1, value: decode ? decodeShort(source.slice(start + 1, index)) : undefined };
            }

            index += source[index] === '\\' ? 2 : 1;
        }

        return { end: source.length, value: undefined };
    }

    const content = longStart(source, start);

    if (content < 0) {
        return undefined;
    }

    const closing = longEnd(source, start, content);

    if (closing < 0) {
        return { end: source.length, value: undefined };
    }

    let value;

    if (decode) {
        value = source.slice(content, closing).replaceAll(/\r\n|\n\r|\r/gu, '\n');

        if (value.startsWith('\n')) {
            value = value.slice(1);
        }
    }

    return { end: closing + content - start, value };
}

/**
 * Extract stable unique literal module names from bare require calls.
 *
 * This lexical closure excludes member calls and dynamic arguments. It does not
 * resolve local shadowing, aliases, or reachability; it never executes source.
 *
 * @param {string} source - Original Lua source.
 * @returns {string[]} Literal module names in first-occurrence order.
 */
function literalLuaRequires(source) {
    const modules = new Set();
    let index = 0;
    let previous = '';
    let awaiting = '';
    let argument;

    while (index < source.length) {
        index = skipTrivia(source, index);

        if (index >= source.length) {
            break;
        }

        const literal = readLiteral(source, index, awaiting === 'call' || awaiting === 'argument');

        if (literal) {
            if (awaiting === 'call' && literal.value !== undefined) {
                modules.add(literal.value);
                awaiting = '';
            } else if (awaiting === 'argument') {
                argument = literal.value;
                awaiting = 'close';
            } else {
                awaiting = '';
            }

            index = literal.end;
            previous = 'string';
            continue;
        }

        const start = index;
        const character = source[index++];
        let token = character;

        if (IDENTIFIER_START.test(character)) {
            while (index < source.length && IDENTIFIER_PART.test(source[index])) {
                index++;
            }

            token = source.slice(start, index);
        } else if (character === '.' && source[index] === '.') {
            index++;

            if (source[index] === '.') {
                index++;
            }

            token = source.slice(start, index);
        }

        if (token === 'require' && previous !== '.' && previous !== ':') {
            awaiting = 'call';
        } else if (token === '(' && awaiting === 'call') {
            awaiting = 'argument';
        } else {
            if (token === ')' && awaiting === 'close' && argument !== undefined) {
                modules.add(argument);
            }

            awaiting = '';
        }

        previous = token;
    }

    return [...modules];
}

export { literalLuaRequires };
