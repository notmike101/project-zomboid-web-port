// ASCII DirectX X only. All geometry remains local; no native files are fetched here.
const MAX_X_BYTES = 16 * 1_024 * 1_024;
const MAX_VERTICES = 100_000;
const MAX_FACES = 200_000;
const MAX_FRAMES = 256;
const MAX_KEYS = 100_000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * One parsed animation clip. Rotation values are normalised xyzw, converted from
 * X's clockwise wxyz convention; translation and scale values retain source units.
 *
 * @typedef {object} XClip
 * @property {string|null} name AnimationSet name.
 * @property {Map<string, {rotation?: {time: number, value: number[]}[], scale?: {time: number, value: number[]}[], translation?: {time: number, value: number[]}[]}>} tracks Bone-name keyed sparse channels, ordered by increasing source ticks.
 * @property {number} durationTicks Last key tick across all channels; zero denotes a constant pose.
 * @property {number|null} ticksPerSecond Declared AnimTicksPerSecond, or null requiring explicit calibration.
 */

/**
 * Parsed text X document. Matrices are source row-major row-vector matrices;
 * their unchanged sixteen-number storage is the transpose used by column vectors.
 *
 * @typedef {object} XDocument
 * @property {{name: string, parent: number, matrix: number[]}[]} frames Parent-first hierarchy; -1 means a root.
 * @property {object[]} meshes Each mesh has positions (xyz), triangle faces, normals (xyz), normalFaces, UV0 pairs, SkinWeights records, skinHeader and optional material.
 * @property {Map<string, object>} materials Named material descriptions and texture filenames.
 * @property {XClip[]} animations AnimationSets in source order, including animation-only documents.
 * @property {number|null} ticksPerSecond Declared tick rate, or null.
 * @property {string[]} textureNames Embedded local texture names; importCharacter requires explicit PNG selection instead of resolving these.
 */

/**
 * Parse bounded `xof 0303txt 0032` text. Supports triangular skinned meshes,
 * Frame matrices, one material per mesh, MeshNormals/UV or float DeclData,
 * and quaternion/scale/translation AnimationKeys. Other object types throw.
 * Limits: 100,000 vertices, 200,000 faces per mesh, 256 frames, 64 hierarchy levels,
 * 100,000 total animation keys and two million tokens. Binary/compressed/64-bit
 * X, polygons, matrix animation keys and non-float DeclData are rejected.
 *
 * @param {string} text - ASCII X source, at most 16 MiB.
 * @returns {XDocument} Parsed frames, meshes, materials, animations and tick metadata.
 */
function parseX(text) {
    if (typeof text !== 'string' || text.length > MAX_X_BYTES) {
        throw new RangeError('X text exceeds the 16 MiB limit.');
    }

    if (!/^xof 0303txt 0032\s/.test(text)) {
        throw new TypeError('Only ASCII DirectX X xof 0303txt 0032 is supported; binary/compressed X is unsupported.');
    }

    const body = text.slice(16);
    const tokens = [];
    const lexer = /\s+|\/{2}[^\n]*|#[^\n]*|\/\*[\S\s]*?\*\/|"(?:[^"\\]|\\.)*"|<[^>]*>|\.{3}|[A-Z_a-z][\w.-]*|[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?|[,;[\]{}]/gy;
    let at = 0;

    while (at < body.length) {
        lexer.lastIndex = at;
        const match = lexer.exec(body);

        if (!match) {
            throw new TypeError(`Invalid X token at character ${at + 16}.`);
        }

        at = lexer.lastIndex;

        if (!/^\s|^\/|^#/.test(match[0])) {
            tokens.push(match[0]);
        }

        if (tokens.length > 2_000_000) {
            throw new RangeError('X token limit exceeded.');
        }
    }

    let pos = 0;
    let totalKeys = 0;
    const result = { frames: [], meshes: [], materials: new Map(), animations: [], ticksPerSecond: null, textureNames: [] };
    const names = new Set();
    /**
     * Reject malformed input with the current token position.
     *
     * @param {string} message - Diagnostic reason.
     * @returns {void}
     */
    const fail = (message) => {
        throw new TypeError(`${message} (X token ${pos}).`);
    };

    /**
     * Consume numeric field and array separators.
     *
     * @returns {void}
     */
    const separators = () => {
        while (tokens[pos] === ';' || tokens[pos] === ',') {
            pos++;
        }
    };

    /**
     * Read the next significant token, rejecting premature EOF.
     *
     * @returns {string} Current token.
     */
    const take = () => {
        separators();

        if (pos >= tokens.length) {
            fail('Truncated X data');
        }

        return tokens[pos++];
    };

    /**
     * Consume a required token.
     *
     * @param {string} value - Expected spelling.
     * @returns {void}
     */
    const expect = (value) => {
        if (take() !== value) {
            fail(`Expected ${value}`);
        }
    };

    /**
     * Read a finite bounded numeric token.
     *
     * @returns {number} Numeric value.
     */
    const number = () => {
        const token = take();

        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/.test(token)) {
            fail('Expected finite number');
        }

        const n = Number(token);

        if (!Number.isFinite(n) || Math.abs(n) > 1e38) {
            fail('Non-finite or excessive number');
        }

        return n;
    };

    /**
     * Read an integer count or index with allocation-safe bounds.
     *
     * @param {number} max - Inclusive upper bound.
     * @param {string} label - Count/index name for diagnostics.
     * @param {number} [min] - Inclusive lower bound.
     * @returns {number} Validated integer.
     */
    const count = (max, label, min = 0) => {
        const n = number();

        if (!Number.isSafeInteger(n) || n < min || n > max) {
            throw new RangeError(`Invalid ${label} count/index: ${n}.`);
        }

        return n;
    };

    /**
     * Read an exact number of finite scalars.
     *
     * @param {number} n - Scalar count.
     * @returns {number[]} Parsed scalars.
     */
    const numbers = (n) => Array.from({ length: n }, number);
    /**
     * Open a named or anonymous data object.
     *
     * @returns {string|null} Optional object name.
     */
    const open = () => {
        const token = take();

        if (token === '{') {
            return null;
        }

        expect('{');

        return token;
    };

    /**
     * Detect the closing brace without consuming it.
     *
     * @returns {boolean} Whether the object ends next.
     */
    const closed = () => {
        separators();

        return tokens[pos] === '}';
    };

    /**
     * Read a quoted filename or bone name.
     *
     * @returns {string} Unquoted value.
     */
    const string = () => {
        const token = take();

        if (!token.startsWith('"')) {
            fail('Expected quoted name');
        }

        return token.slice(1, -1).replaceAll(/\\(["\\])/g, '$1');
    };

    /**
     * Read a braced named-object reference.
     *
     * @returns {string} Referenced object name.
     */
    const reference = () => {
        expect('{');
        const name = take();

        expect('}');

        return name;
    };

    /**
     * Read an affine row-major X matrix, stored as column-vector transpose.
     *
     * @returns {number[]} Sixteen matrix components.
     */
    const matrix = () => {
        const m = numbers(16);

        if (Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) > 1e-5 || Math.abs(m[15] - 1) > 1e-5) {
            fail('Only affine frame/offset matrices are supported');
        }

        return m;
    };

    /**
     * Read triangular faces and validate every vertex index.
     *
     * @param {number} vertexCount - Number of addressable vertices or normals.
     * @returns {number[][]} Triangle index triples.
     */
    function faces(vertexCount) {
        const n = count(MAX_FACES, 'face', 1);

        return Array.from({ length: n }, () => {
            if (count(4, 'face vertex') !== 3) {
                fail('Only triangular X faces are supported');
            }

            return Array.from({ length: 3 }, () => count(vertexCount - 1, 'vertex index'));
        });
    }

    /**
     * Read material lighting fields and optional local texture reference.
     *
     * @returns {object} Material description.
     */
    function material() {
        const name = open();
        const colour = numbers(4);

        number();
        numbers(3);
        numbers(3);
        let texture = null;

        while (!closed()) {
            if (take() !== 'TextureFilename' || texture !== null) {
                fail('Unsupported material object');
            }

            open();
            texture = string();
            expect('}');
        }

        expect('}');
        const mat = { name, colour, texture };

        if (name) {
            if (result.materials.has(name)) {
                fail('Duplicate material');
            }

            result.materials.set(name, mat);
        }

        if (texture) {
            result.textureNames.push(texture);
        }

        return mat;
    }

    /**
     * Parse one mesh and its skinning, normal and texture-coordinate data.
     *
     * @param {number} frame - Owning frame index, or -1 for a root mesh.
     * @returns {void}
     */
    function mesh(frame) {
        const name = open();
        const n = count(MAX_VERTICES, 'vertex', 1);
        const m = { name, frame, positions: numbers(n * 3), faces: faces(n), normals: null, normalFaces: null, uv: null, weights: [], material: null, skinHeader: null };

        while (!closed()) {
            const type = take();

            switch (type) {
                case 'MeshNormals': {
                    open();
                    const k = count(MAX_VERTICES, 'normal', 1);

                    if (m.normals) {
                        fail('Duplicate normals');
                    }

                    m.normals = numbers(k * 3);
                    m.normalFaces = faces(k);
                    expect('}');

                    if (m.normalFaces.length !== m.faces.length) {
                        fail('Normal face count differs from mesh');
                    }

                    break;
                }
                case 'MeshTextureCoords': {
                    open();

                    if (count(MAX_VERTICES, 'UV') !== n || m.uv) {
                        fail('UV count differs or duplicate UV');
                    }

                    m.uv = numbers(n * 2);
                    expect('}');

                    break;
                }
                case 'MeshMaterialList': {
                    open();

                    if (count(256, 'material', 1) !== 1) {
                        fail('Only one material per mesh is supported');
                    }

                    if (count(MAX_FACES, 'material face') !== m.faces.length) {
                        fail('Material face count differs');
                    }

                    for (let i = 0; i < m.faces.length; i++) {
                        if (number() !== 0) {
                            fail('Invalid material index');
                        }
                    }

                    separators();

                    if (tokens[pos] === '{') {
                        m.material = reference();
                    } else {
                        expect('Material');
                        m.material = material();
                    }

                    expect('}');

                    break;
                }
                case 'XSkinMeshHeader': {
                    open();
                    const maxWeights = count(4, 'weights per vertex', 1);
                    const maxFaceWeights = count(12, 'weights per face', 1);
                    const bones = count(MAX_FRAMES, 'skin bones', 1);

                    if (m.skinHeader) {
                        fail('Duplicate skin header');
                    }

                    m.skinHeader = { maxWeights, maxFaceWeights, bones };
                    expect('}');

                    break;
                }
                case 'SkinWeights': {
                    if (m.weights.length >= MAX_FRAMES) {
                        throw new RangeError('Skin bone limit exceeded.');
                    }

                    open();
                    const bone = string();
                    // A declared palette bone may influence no vertices; its two arrays are empty.
                    const k = count(n, 'skin vertex');
                    const indices = Array.from({ length: k }, () => count(n - 1, 'skin vertex index'));

                    if (new Set(indices).size !== indices.length) {
                        fail('Duplicate skin vertex index');
                    }

                    const weights = numbers(k);

                    if (weights.some((w) => w < 0 || w > 1)) {
                        fail('Skin weight outside [0,1]');
                    }

                    m.weights.push({ bone, indices, weights, offset: matrix() });
                    expect('}');

                    break;
                }
                case 'DeclData': {
                    open();
                    const k = count(16, 'vertex declaration', 1);
                    const elements = Array.from({ length: k }, () => numbers(4));
                    let stride = 0;

                    for (const [t, method, usage, index] of elements) {
                        if (![1, 2].includes(t) || method !== 0 || ![3, 5, 6].includes(usage) || index !== 0 || (usage === 5 ? t !== 1 : t !== 2)) {
                            fail('Unsupported DeclData element (only float normal/tangent/UV0)');
                        }

                        stride += t + 1;
                    }

                    if (new Set(elements.map((e) => e[2])).size !== k) {
                        fail('Duplicate DeclData semantic');
                    }

                    if (count(MAX_VERTICES * 8, 'DeclData DWORD') !== n * stride) {
                        fail('DeclData length differs from vertex stride');
                    }

                    const bits = new Uint32Array(n * stride);

                    for (let i = 0; i < bits.length; i++) {
                        bits[i] = count(0xFF_FF_FF_FF, 'DeclData DWORD');
                    }

                    const floats = new Float32Array(bits.buffer);

                    if (floats.some((v) => !Number.isFinite(v))) {
                        fail('Non-finite DeclData float');
                    }

                    let offset = 0;

                    for (const [t, , usage] of elements) {
                        if (usage === 6) {
                            offset += t + 1;
                            continue;
                        }

                        const field = usage === 3 ? 'normals' : 'uv';

                        if (m[field]) {
                            fail(`Duplicate ${field}`);
                        }

                        m[field] = Array.from({ length: n * (t + 1) }, (_, i) => floats[Math.floor(i / (t + 1)) * stride + offset + i % (t + 1)]);
                        offset += t + 1;
                    }

                    if (m.normals) {
                        m.normalFaces = m.faces;
                    }

                    expect('}');

                    break;
                }

                default: fail(`Unsupported mesh object ${type}`);
            }
        }

        expect('}');
        result.meshes.push(m);
    }

    /**
     * Parse a parent-first frame subtree under fixed depth and bone limits.
     *
     * @param {number} parent - Parent frame index, or -1 for a root frame.
     * @param {number} depth - Current hierarchy nesting depth.
     * @returns {void}
     */
    function frame(parent, depth) {
        if (depth > 64 || result.frames.length >= MAX_FRAMES) {
            throw new RangeError('Frame hierarchy limit exceeded.');
        }

        const name = open();

        if (!name || names.has(name)) {
            fail('Missing or duplicate frame name');
        }

        names.add(name);
        const index = result.frames.length;
        const f = { name, parent, matrix: IDENTITY.slice() };

        result.frames.push(f);
        let transformed = false;

        while (!closed()) {
            const type = take();

            switch (type) {
                case 'FrameTransformMatrix': {
                    if (transformed) {
                        fail('Duplicate frame transform');
                    }

                    open();
                    f.matrix = matrix();
                    expect('}');
                    transformed = true;
                    break;
                }
                case 'Frame': {
                    frame(index, depth + 1);
                    break;
                }
                case 'Mesh': {
                    mesh(index);
                    break;
                }

                default: fail(`Unsupported frame object ${type}`);
            }
        }

        expect('}');
    }

    /**
     * Parse named bone tracks, sorted timed TRS keys and clip duration.
     *
     * @returns {void}
     */
    function animationSet() {
        const name = open();
        const clip = { name, tracks: new Map(), durationTicks: 0, ticksPerSecond: null };

        while (!closed()) {
            expect('Animation');
            open();
            const bone = reference();

            if (clip.tracks.has(bone)) {
                fail('Duplicate animation track');
            }

            const track = {};

            while (!closed()) {
                expect('AnimationKey');
                open();
                const type = count(4, 'animation key type');

                if (type > 2) {
                    fail('Matrix AnimationKeys are unsupported; use quaternion/scale/translation');
                }

                const field = ['rotation', 'scale', 'translation'][type];

                if (track[field]) {
                    fail('Duplicate animation key channel');
                }

                const k = count(MAX_KEYS, 'animation key', 1);

                totalKeys += k;

                if (totalKeys > MAX_KEYS) {
                    throw new RangeError('Total animation key limit exceeded.');
                }

                const keys = [];
                let previous = -1;

                for (let i = 0; i < k; i++) {
                    const time = count(0xFF_FF_FF_FF, 'animation tick');

                    if (time <= previous) {
                        fail('Animation key times must strictly increase');
                    }

                    previous = time;

                    if (count(16, 'animation component') !== (type === 0 ? 4 : 3)) {
                        fail('Animation component count differs from type');
                    }

                    let value = numbers(type === 0 ? 4 : 3);

                    const length = type === 0 ? Math.hypot(...value) : 1;

                    if (length < 1e-8) {
                        fail('Zero quaternion');
                    }

                    if (type === 0) {
                        // X stores wxyz with clockwise rotation; transpose to column-vector xyzw.
                        value = [-value[1] / length, -value[2] / length, -value[3] / length, value[0] / length];
                    }

                    if (type === 1 && value.some((v) => v <= 0)) {
                        fail('Non-positive animated scale is unsupported');
                    }

                    keys.push({ time, value });
                    clip.durationTicks = Math.max(clip.durationTicks, time);
                }

                track[field] = keys;
                expect('}');
            }

            expect('}');
            clip.tracks.set(bone, track);
        }

        expect('}');

        if (!clip.tracks.size) {
            fail('Empty AnimationSet');
        }

        result.animations.push(clip);
    }

    while (pos < tokens.length) {
        separators();

        if (pos === tokens.length) {
            break;
        }

        const type = take();

        switch (type) {
            case 'template': {
                take();
                expect('{');
                let depth = 1;

                while (depth) {
                    const token = take();

                    if (token === '{') {
                        depth++;
                    }

                    if (token === '}') {
                        depth--;
                    }

                    if (depth > 64) {
                        fail('Template nesting limit');
                    }
                }

                break;
            }
            case 'Frame': {
                frame(-1, 0);
                break;
            }
            case 'Mesh': {
                mesh(-1);
                break;
            }
            case 'Material': {
                material();
                break;
            }
            case 'AnimationSet': {
                animationSet();
                break;
            }
            case 'AnimTicksPerSecond': {
                if (result.ticksPerSecond !== null) {
                    fail('Duplicate tick metadata');
                }

                open();
                result.ticksPerSecond = count(1_000_000, 'ticksPerSecond', 1);
                expect('}');
                break;
            }

            default: fail(`Unsupported X object ${type}`);
        }
    }

    for (const m of result.meshes) {
        if (typeof m.material === 'string') {
            m.material = result.materials.get(m.material);

            if (!m.material) {
                fail('Missing referenced material');
            }
        }

        if (!m.normals || !m.uv) {
            fail('Mesh requires normals and UV0');
        }
    }

    for (const clip of result.animations) {
        clip.ticksPerSecond = result.ticksPerSecond;
    }

    return result;
}

/**
 * Multiply two column-major matrices into a distinct reusable output.
 *
 * @param {number[]|Float32Array} a - Left matrix.
 * @param {number[]|Float32Array} b - Right matrix.
 * @param {Float32Array} out - Sixteen-component output buffer.
 * @returns {void}
 */
function multiply(a, b, out) {
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
}

/**
 * Compose a column-vector affine TRS matrix.
 *
 * @param {number[]|Float32Array} t - Translation vector.
 * @param {number[]|Float32Array} q - Normalised xyzw quaternion.
 * @param {number[]|Float32Array} s - Positive scale vector.
 * @param {Float32Array} m - Sixteen-component output buffer.
 * @returns {void}
 */
function compose(t, q, s, m) {
    const [x, y, z, w] = q;

    m.set([(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, ...t, 1]);
}

/**
 * Extract bind TRS, rejecting singular, reflected or sheared matrices.
 *
 * @param {number[]} m - Affine column-major bind matrix.
 * @returns {{translation: number[], rotation: number[], scale: number[]}} Bind components.
 */
function decompose(m) {
    const s = [Math.hypot(...m.slice(0, 3)), Math.hypot(...m.slice(4, 7)), Math.hypot(...m.slice(8, 11))];

    if (s.some((v) => v < 1e-8)) {
        throw new TypeError('Singular bind matrix is unsupported.');
    }

    const r = [m[0] / s[0], m[4] / s[1], m[8] / s[2], m[1] / s[0], m[5] / s[1], m[9] / s[2], m[2] / s[0], m[6] / s[1], m[10] / s[2]];
    const q = [0, 0, 0, 0];
    const trace = r[0] + r[4] + r[8];

    if (trace > 0) {
        const k = Math.sqrt(trace + 1) * 2;

        q[3] = k / 4;
        q[0] = (r[7] - r[5]) / k;
        q[1] = (r[2] - r[6]) / k;
        q[2] = (r[3] - r[1]) / k;
    } else {
        let i = 2;

        if (r[0] > r[4] && r[0] > r[8]) {
            i = 0;
        } else if (r[4] > r[8]) {
            i = 1;
        }

        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        const f = Math.sqrt(1 + r[i * 3 + i] - r[j * 3 + j] - r[k * 3 + k]) * 2;

        q[i] = f / 4;
        q[j] = (r[j * 3 + i] + r[i * 3 + j]) / f;
        q[k] = (r[k * 3 + i] + r[i * 3 + k]) / f;
        q[3] = (r[k * 3 + j] - r[j * 3 + k]) / f;
    }

    const reconstructed = new Float32Array(16);

    compose(m.slice(12, 15), q, s, reconstructed);

    if (m.some((v, i) => Math.abs(v - reconstructed[i]) > 1e-4 * Math.max(1, Math.abs(v)))) {
        throw new TypeError('Sheared/reflected bind matrices are unsupported.');
    }

    return { translation: m.slice(12, 15), rotation: q, scale: s };
}

/**
 * Build one GPU-ready mesh with 64-byte float vertices: position3, normal3,
 * UV2, weights4, boneIndices4. Normal seams duplicate vertices as necessary.
 *
 * @param {XDocument} model - parseX result; exactly one skinned mesh is supported.
 * @returns {object} Static vertices/indices, bounds and reusable palette workspace.
 */
function createSkin(model) {
    if (model.meshes.length !== 1) {
        throw new TypeError('Exactly one skinned mesh is supported.');
    }

    const mesh = model.meshes[0];

    if (!mesh.skinHeader || !mesh.weights.length || mesh.skinHeader.bones !== mesh.weights.length) {
        throw new TypeError('Skin header and bone weights disagree.');
    }

    const frames = model.frames.map((f) => ({ ...f, bind: decompose(f.matrix) }));
    const byName = new Map(frames.map((f, i) => [f.name, i]));
    const bones = mesh.weights.map((w) => {
        if (!byName.has(w.bone)) {
            throw new TypeError(`Missing bone frame ${w.bone}.`);
        }

        return { ...w, frame: byName.get(w.bone) };
    });

    if (new Set(bones.map((b) => b.bone)).size !== bones.length) {
        throw new TypeError('Duplicate skin bone.');
    }

    const influences = Array.from({ length: mesh.positions.length / 3 }, () => []);

    for (const [index, b] of bones.entries()) {
        for (const [i, vertex] of b.indices.entries()) {
            if (b.weights[i] > 0) {
                influences[vertex].push([index, b.weights[i]]);
            }
        }
    }

    for (const weights of influences) {
        const sum = weights.reduce((n, w) => n + w[1], 0);

        if (!sum || weights.length > mesh.skinHeader.maxWeights || weights.length > 4 || Math.abs(sum - 1) > 0.05) {
            throw new TypeError('Each vertex requires one to four normalised skin weights.');
        }

        for (const w of weights) {
            w[1] /= sum;
        }
    }

    const vertices = [];
    const indices = [];
    const unique = new Map();

    for (const [f, face] of mesh.faces.entries()) {
        for (const [corner, v] of face.entries()) {
            const normal = mesh.normalFaces[f][corner];
            const key = `${v}/${normal}`;

            if (!unique.has(key)) {
                const weights = influences[v];

                unique.set(key, vertices.length / 16);
                vertices.push(...mesh.positions.slice(v * 3, v * 3 + 3), ...mesh.normals.slice(normal * 3, normal * 3 + 3), ...mesh.uv.slice(v * 2, v * 2 + 2),
                    ...Array.from({ length: 4 }, (_, i) => weights[i]?.[1] ?? 0), ...Array.from({ length: 4 }, (_, i) => weights[i]?.[0] ?? 0));
            }

            indices.push(unique.get(key));
        }
    }

    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

    for (let i = 0; i < mesh.positions.length; i++) {
        const axis = i % 3;

        bounds.min[axis] = Math.min(bounds.min[axis], mesh.positions[i]);
        bounds.max[axis] = Math.max(bounds.max[axis], mesh.positions[i]);
    }

    return {
        frames, byName, bones, vertices: new Float32Array(vertices), indices: new Uint32Array(indices), bounds,
        globals: frames.map(() => new Float32Array(16)), local: new Float32Array(16), palette: new Float32Array(bones.length * 16),
        translation: new Float32Array(3), rotation: new Float32Array(4), scale: new Float32Array(3),
    };
}

/**
 * Sample sparse vector keys or shortest-arc quaternion slerp into reusable storage.
 *
 * @param {{time: number, value: number[]}[]|undefined} keys - Increasing tick keys.
 * @param {number} time - Sample time in source ticks.
 * @param {number[]} fallback - Bind component when the channel is absent.
 * @param {Float32Array} out - Three- or four-component result buffer.
 * @param {boolean} [quaternion] - Use normalised shortest-arc slerp.
 * @returns {void}
 */
function interpolate(keys, time, fallback, out, quaternion = false) {
    if (!keys) {
        out.set(fallback);

        return;
    }

    let lo = 0;
    let hi = keys.length - 1;

    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;

        if (keys[mid].time <= time) {
            lo = mid;
        } else {
            hi = mid;
        }
    }

    const a = keys[lo];
    const b = keys[hi];
    const t = a === b ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
    let sign = 1;
    let alpha = 1 - t;
    let beta = t;

    if (quaternion) {
        let dot = a.value.reduce((v, n, i) => v + n * b.value[i], 0);

        if (dot < 0) {
            sign = -1;
            dot = -dot;
        }

        if (dot < 0.999_5) {
            const angle = Math.acos(Math.min(1, dot));

            alpha = Math.sin((1 - t) * angle) / Math.sin(angle);
            beta = Math.sin(t * angle) / Math.sin(angle);
        }
    }

    for (let i = 0; i < out.length; i++) {
        out[i] = alpha * a.value[i] + beta * sign * b.value[i];
    }

    if (quaternion) {
        const length = Math.hypot(...out);

        for (let i = 0; i < 4; i++) {
            out[i] /= length;
        }
    }
}

/**
 * Evaluate hierarchy × SkinWeights offsets into reusable column-major GPU palette.
 * X quaternion convention is converted during parsing. bind pose when clip is null.
 *
 * @param {object} skin - createSkin result; returned palette is overwritten next call.
 * @param {XClip|null} clip - parseX AnimationSet, compatible named skeleton.
 * @param {number} seconds - Nonnegative animation time in seconds, looping at last key.
 * @param {number} [ticksPerSecond] - Explicit calibration only if X omits metadata.
 * @returns {Float32Array} One 4×4 matrix per SkinWeights bone in original order.
 */
function sampleSkin(skin, clip, seconds, ticksPerSecond) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError('Animation time must be finite and nonnegative.');
    }

    const rate = clip?.ticksPerSecond ?? ticksPerSecond;

    if (clip && (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000)) {
        throw new RangeError('Animation lacks AnimTicksPerSecond; supply explicit ticksPerSecond calibration.');
    }

    const time = clip?.durationTicks ? (seconds * rate) % clip.durationTicks : 0;

    for (let i = 0; i < skin.frames.length; i++) {
        const frame = skin.frames[i];
        const track = clip?.tracks.get(frame.name);

        if (track) {
            interpolate(track.translation, time, frame.bind.translation, skin.translation);
            interpolate(track.rotation, time, frame.bind.rotation, skin.rotation, true);
            interpolate(track.scale, time, frame.bind.scale, skin.scale);
            compose(skin.translation, skin.rotation, skin.scale, skin.local);
        } else {
            skin.local.set(frame.matrix);
        }

        if (frame.parent < 0) {
            skin.globals[i].set(skin.local);
        } else {
            multiply(skin.globals[frame.parent], skin.local, skin.globals[i]);
        }
    }

    for (const [i, bone] of skin.bones.entries()) {
        multiply(skin.globals[bone.frame], bone.offset, skin.palette.subarray(i * 16, i * 16 + 16));
    }

    return skin.palette;
}

export { MAX_X_BYTES, parseX, createSkin, sampleSkin };
