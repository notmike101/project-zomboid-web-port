// Public constants verified against the provisioned org.lwjglx.input.Keyboard class with javap -constants.
const keyboard = Object.freeze({
    NONE: 0, ESCAPE: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
    MINUS: 12, EQUALS: 13, BACK: 14, TAB: 15,
    Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25,
    LBRACKET: 26, RBRACKET: 27, RETURN: 28, LCONTROL: 29,
    A: 30, S: 31, D: 32, F: 33, G: 34, H: 35, J: 36, K: 37, L: 38,
    SEMICOLON: 39, APOSTROPHE: 40, GRAVE: 41, LSHIFT: 42, BACKSLASH: 43,
    Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
    COMMA: 51, PERIOD: 52, SLASH: 53, RSHIFT: 54, MULTIPLY: 55, LMENU: 56, SPACE: 57, CAPITAL: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
    NUMLOCK: 69, SCROLL: 70, NUMPAD7: 71, NUMPAD8: 72, NUMPAD9: 73, SUBTRACT: 74,
    NUMPAD4: 75, NUMPAD5: 76, NUMPAD6: 77, ADD: 78, NUMPAD1: 79, NUMPAD2: 80, NUMPAD3: 81,
    NUMPAD0: 82, DECIMAL: 83, F11: 87, F12: 88, F13: 100, F14: 101, F15: 102, F16: 103, F17: 104, F18: 105,
    KANA: 112, F19: 113, CONVERT: 121, NOCONVERT: 123, YEN: 125, NUMPADEQUALS: 141,
    CIRCUMFLEX: 144, AT: 145, COLON: 146, UNDERLINE: 147, KANJI: 148, STOP: 149, AX: 150, UNLABELED: 151,
    NUMPADENTER: 156, RCONTROL: 157, SECTION: 167, NUMPADCOMMA: 179, DIVIDE: 181, SYSRQ: 183, RMENU: 184,
    FUNCTION: 196, PAUSE: 197, HOME: 199, UP: 200, PRIOR: 201, LEFT: 203, RIGHT: 205, END: 207, DOWN: 208,
    NEXT: 209, INSERT: 210, DELETE: 211, CLEAR: 218, LMETA: 219, LWIN: 219, RMETA: 220, RWIN: 220,
    APPS: 221, POWER: 222, SLEEP: 223,
});
const keyNames = new Map();

for (const [name, code] of Object.entries(keyboard)) {
    if (!keyNames.has(code)) {
        keyNames.set(code, name);
    }
}

const domNames = Object.freeze({
    Escape: 'ESCAPE', Minus: 'MINUS', Equal: 'EQUALS', Backspace: 'BACK', Tab: 'TAB',
    BracketLeft: 'LBRACKET', BracketRight: 'RBRACKET', Enter: 'RETURN', ControlLeft: 'LCONTROL',
    Semicolon: 'SEMICOLON', Quote: 'APOSTROPHE', Backquote: 'GRAVE', ShiftLeft: 'LSHIFT', Backslash: 'BACKSLASH',
    Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH', ShiftRight: 'RSHIFT', NumpadMultiply: 'MULTIPLY',
    AltLeft: 'LMENU', Space: 'SPACE', CapsLock: 'CAPITAL', NumLock: 'NUMLOCK', ScrollLock: 'SCROLL',
    NumpadSubtract: 'SUBTRACT', NumpadAdd: 'ADD', NumpadDecimal: 'DECIMAL', KanaMode: 'KANA', Convert: 'CONVERT',
    NonConvert: 'NOCONVERT', IntlYen: 'YEN', NumpadEqual: 'NUMPADEQUALS', NumpadEnter: 'NUMPADENTER',
    ControlRight: 'RCONTROL', NumpadComma: 'NUMPADCOMMA', NumpadDivide: 'DIVIDE', PrintScreen: 'SYSRQ',
    AltRight: 'RMENU', Fn: 'FUNCTION', Pause: 'PAUSE', Home: 'HOME', ArrowUp: 'UP', PageUp: 'PRIOR',
    ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', End: 'END', ArrowDown: 'DOWN', PageDown: 'NEXT', Insert: 'INSERT',
    Delete: 'DELETE', NumpadClear: 'CLEAR', MetaLeft: 'LMETA', MetaRight: 'RMETA', ContextMenu: 'APPS',
    Power: 'POWER', Sleep: 'SLEEP',
});

/**
 * Resolve one exact source Keyboard constant without inventing an unknown zero key.
 *
 * @param {string} name - Native KEY_ constant name.
 * @returns {number|null} Verified enum value or absence.
 */
export function keyboardKey(name) {
    return typeof name === 'string' && name.startsWith('KEY_') && Object.hasOwn(keyboard, name.slice(4)) ? keyboard[name.slice(4)] : null;
}

/**
 * Resolve the source Keyboard key label.
 *
 * @param {number} code - Native enum value.
 * @returns {string|null} Native label or absence.
 */
export function keyName(code) {
    return keyNames.get(code) ?? null;
}

/**
 * Translate physical browser codes, never legacy DOM keyCode values.
 *
 * @param {string} code - KeyboardEvent.code.
 * @returns {number|null} Native nonzero key or unsupported absence.
 */
export function sourceKeyCode(code) {
    const name = /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-9]))$/u.test(code)
        ? code.replace(/^Key|^Digit/u, '').replace(/^Numpad/u, 'NUMPAD')
        : domNames[code];

    return Object.hasOwn(keyboard, name) ? keyboard[name] : null;
}

/**
 * Validate retained source keyboard records and migrate the exact historical empty configuration.
 * Mouse bindings need the original UI-check backend and are deliberately refused here.
 *
 * @param {unknown} value - Retained inputBindings, or undefined for a new session.
 * @returns {object} Detached immutable configured records keyed by original binding name.
 */
export function normalizeInputBindings(value) {
    const legacy = value === undefined || (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && Object.hasOwn(value, 'Interact') && value.Interact === null);
    const input = value === undefined ? { Interact: null } : value;

    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 256) {
        throw new TypeError('Source keyboard bindings must be a keyed record.');
    }

    const bindings = Object.create(null);

    for (const [name, record] of Object.entries(input)) {
        if (name.length === 0 || name.length > 128) {
            throw new TypeError('Source keyboard binding name is invalid.');
        }

        if (record === null) {
            bindings[name] = null;
            continue;
        }

        if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 5
            || !['keyValue', 'altKey', 'shift', 'ctrl', 'alt'].every((field) => Object.hasOwn(record, field))
            || !keyNames.has(record.keyValue) || !keyNames.has(record.altKey)
            || !['shift', 'ctrl', 'alt'].every((field) => typeof record[field] === 'boolean')) {
            throw new TypeError(`Unsupported or malformed source keyboard binding: ${name}`);
        }

        bindings[name] = Object.freeze({
            keyValue: record.keyValue, altKey: record.altKey, shift: record.shift, ctrl: record.ctrl, alt: record.alt,
        });
    }

    if (legacy) {
        // Installed keyBinding.lua binds Toggle Inventory to Keyboard.KEY_I; Interact remains intentionally unbound.
        bindings['Toggle Inventory'] = Object.freeze({ keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: false });
    }

    return Object.freeze(bindings);
}
