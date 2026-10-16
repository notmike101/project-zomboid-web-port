import { parseStaticFbx } from './fbx.js';
import { normalItemIcon, parseClothingDefinition, parseModelDefinitions } from './item-definitions.js';
import { openPack } from './packs.js';

/* Static authority: ItemModelRenderer/WorldItemModelDrawer (artifact1963),
   FileTask_LoadMesh/ImportedStaticMesh (1971/1972), ModelScript/ItemVisual (1970).
   No game execution or original assets are needed by this module's authored tests. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const HANDEDNESS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/**
 * Multiply column-major transforms in the same order as JOML.
 *
 * @param {number[]|Float64Array} a - Left column-major 4×4 transform.
 * @param {number[]|Float64Array} b - Right column-major 4×4 transform.
 * @returns {Float64Array} Product transform.
 */
function multiply(a, b) {
    const out = new Float64Array(16);

    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            for (let k = 0; k < 4; k++) {
                out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
            }
        }
    }

    return out;
}

/**
 * Invert a finite nonsingular affine mesh/attachment transform.
 *
 * @param {number[]|Float64Array} m - Column-major affine 4×4 transform.
 * @returns {number[]} Inverse column-major transform.
 */
function inverse(m) {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    const cof = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
    const det = a * cof[0] + b * cof[3] + c * cof[6];

    if (!Number.isFinite(det) || det === 0) {
        throw new Error('Unsupported singular world mesh transform');
    }

    const out = [...IDENTITY];

    for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
            out[col * 4 + row] = cof[row * 3 + col] / det;
        }

        out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
    }

    return out;
}

/**
 * Build translation * rotateXYZ * uniform scale, as makeAttachmentTransform does.
 *
 * @param {number[]} offset - Translation along the three source axes.
 * @param {number[]} rotate - XYZ rotation angles in degrees.
 * @param {number} [scale] - Uniform attachment scale.
 * @returns {number[]|Float64Array} Composed column-major transform.
 */
function attachment(offset, rotate, scale = 1) {
    let m = [...IDENTITY];

    m[12] = offset[0];
    m[13] = offset[1];
    m[14] = offset[2];

    for (let axis = 0; axis < 3; axis++) {
        const r = [...IDENTITY];
        const a = (axis + 1) % 3;
        const b = (axis + 2) % 3;
        const angle = rotate[axis] * Math.PI / 180;

        r[a * 4 + a] = Math.cos(angle);
        r[b * 4 + b] = Math.cos(angle);
        r[a * 4 + b] = Math.sin(angle);
        r[b * 4 + a] = -Math.sin(angle);
        m = multiply(m, r);
    }

    for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
            m[col * 4 + row] *= scale;
        }
    }

    return m;
}

/**
 * Validate an authored path without permitting traversal, URLs or host filesystem paths.
 *
 * @param {unknown} value - Untrusted authored relative resource path.
 * @returns {string} Validated path with forward slashes.
 */
function sourcePath(value) {
    if (typeof value !== 'string' || !value || value.length > 4_096) {
        throw new Error('Invalid original world asset path');
    }

    const path = value.replaceAll('\\', '/');

    if (/[:%?#]/u.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid original world asset path: ${value}`);
    }

    // Match content manifest validation without restricting ordinary filename punctuation or Unicode.
    for (let index = 0; index < path.length; index++) {
        const code = path.codePointAt(index);

        if (code <= 0x1F || code === 0x7F) {
            throw new Error(`Invalid original world asset path: ${value}`);
        }
    }

    return path;
}

/**
 * Read an explicit source vector; never coerce malformed transform metadata to zero.
 *
 * @param {string|undefined} value - Authored whitespace-separated XYZ vector.
 * @param {number[]} fallback - Vector used only when the field is absent.
 * @returns {number[]} Validated finite vector or the supplied fallback.
 */
function vector(value, fallback) {
    if (value === undefined) {
        return fallback;
    }

    const tokens = value.trim().split(/\s+/u);
    const values = tokens.map(Number);

    if (tokens.length !== 3 || tokens.some((v) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/u.test(v)) || values.some((v) => !Number.isFinite(v))) {
        throw new Error('Unsupported world attachment vector');
    }

    return values;
}

/**
 * Validate the exact multiplicative RGB(A) material tint.
 *
 * @param {unknown} [value] - Authored RGB or RGBA tint, defaulting to white.
 * @returns {number[]} Validated RGBA components.
 */
function color(value = [1, 1, 1, 1]) {
    if (!Array.isArray(value) || ![3, 4].includes(value.length) || value.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
        throw new Error('Unsupported original item tint');
    }

    return [value[0], value[1], value[2], value[3] ?? 1];
}

/**
 * Convert decoded source coordinates once to native static-import coordinates.
 *
 * @param {object} mesh - Decoded static FBX mesh with baked transform metadata.
 * @returns {object} Mesh with native coordinates, bounds and import transform.
 */
function nativeMesh(mesh) {
    /* parseStaticFbx already bakes M. Undo it once so native right-multiplied script
       and per-item scale retain A^-1 * M * Sscript * Sitem, including translated M. */
    const m = mesh.metadata.transform;
    const unbake = inverse(m);
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

    for (let at = 0; at < mesh.positions.length; at += 3) {
        const p = mesh.positions.subarray(at, at + 3);
        const xyz = [0, 1, 2].map((axis) => unbake[axis] * p[0] + unbake[4 + axis] * p[1] + unbake[8 + axis] * p[2] + unbake[12 + axis]);

        xyz[2] = -xyz[2];

        if (xyz.some((value) => !Number.isFinite(Math.fround(value)))) {
            throw new Error('Unsupported nonfinite original mesh coordinates');
        }

        mesh.positions.set(xyz, at);

        for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], xyz[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], xyz[axis]);
        }

        const n = mesh.normals.subarray(at, at + 3);
        const normal = [0, 1, 2].map((axis) => m[axis * 4] * n[0] + m[axis * 4 + 1] * n[1] + m[axis * 4 + 2] * n[2]);
        const length = Math.hypot(...normal);

        if (!Number.isFinite(length) || !length) {
            throw new Error('Unsupported original mesh normal transform');
        }

        mesh.normals.set([normal[0] / length, normal[1] / length, -normal[2] / length], at);
    }

    for (let at = 1; at < mesh.uvs.length; at += 2) {
        mesh.uvs[at] = 1 - mesh.uvs[at];
    }

    const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

    // Undo the parser's mirrored-transform winding correction before native reversal.
    for (let at = 0; determinant > 0 && at < mesh.indices.length; at += 3) {
        const first = mesh.indices[at];

        mesh.indices[at] = mesh.indices[at + 2];
        mesh.indices[at + 2] = first;
    }

    return { ...mesh, bounds, nativeTransform: multiply(multiply(HANDEDNESS, m), HANDEDNESS) };
}

/**
 * Read PNG dimensions without manufacturing canvas dimensions or decoding original pixels.
 *
 * @param {Blob} texture - Original icon PNG bytes.
 * @returns {Promise<{width:number,height:number}>} Validated IHDR dimensions.
 */
async function dimensions(texture) {
    const bytes = new Uint8Array(await texture.slice(0, 33).arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length !== 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v) || view.getUint32(8) !== 13
        || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
        throw new Error('Unsupported original world icon PNG header');
    }

    const width = view.getUint32(16);
    const height = view.getUint32(20);

    if (!width || !height || width > 16_384 || height > 16_384) {
        throw new Error('Unsupported original world icon dimensions');
    }

    return { width, height };
}

/**
 * Resolve one actually selected clothing texture, permitting only proven deterministic defaults.
 *
 * @param {object} c - Parsed ClothingItem metadata and authored texture lists.
 * @param {object|undefined} visual - Persisted native texture selection.
 * @param {boolean} choices - Select textureChoices instead of baseTextures.
 * @returns {string} Exact selected authored texture name.
 */
function clothingTexture(c, visual, choices) {
    const textures = choices ? c.textureChoices : c.baseTextures;
    const index = visual?.[choices ? 'textureChoice' : 'baseTexture'];

    if (Number.isInteger(index) && index >= 0 && index < textures.length) {
        return textures[index];
    }

    if (index !== undefined) {
        throw new Error('Unsupported original clothing visual texture selection');
    }

    if (textures.length === 1) {
        return textures[0];
    }

    throw new Error('Original clothing visual texture selection is required');
}

/**
 * Resolve original model-first ground representations from the selected private manifest.
 * NoModel is the only synthesized native status; parser/I/O/material failures are errors,
 * not evidence that the original engine failed or would choose an icon.
 *
 * @param {object} content - Exact manifest.files and getFile slice/text API.
 * @returns {Promise<{resolve: function(object): Promise<object>, visualRules: function(object): Promise<object|null>}>} Shared representation resolver and native visual initialization rules.
 */
export async function createWorldItemAssets(content) {
    if (!Array.isArray(content?.manifest?.files) || typeof content.getFile !== 'function') {
        throw new TypeError('World assets require an original content manifest');
    }

    const paths = new Map();

    for (const { path } of content.manifest.files) {
        const canonical = sourcePath(path);
        const key = canonical.toLowerCase();

        if (paths.has(key)) {
            throw new Error(`Ambiguous original manifest path: ${path}`);
        }

        paths.set(key, path);
    }

    const models = new Map();
    const clothing = new Map();
    const meshes = new Map();
    const blobs = new Map();
    const representations = new Map();
    let uiPack;

    /**
     * Read one exact manifest source as a Blob, retaining HTTP slice-source support.
     *
     * @param {string} path - Exact manifest resource path.
     * @returns {Promise<Blob>} Cached resource bytes as a Blob.
     */
    function blob(path) {
        if (!blobs.has(path)) {
            blobs.set(path, (async () => {
                const file = content.getFile(path);

                return file instanceof Blob ? file : new Blob([await file.slice(0, file.size).arrayBuffer()], { type: 'image/png' });
            })());
        }

        return blobs.get(path);
    }

    /**
     * Resolve original case-insensitive virtual resource identity to its exact manifest path.
     *
     * @param {string} path - Authored case-insensitive relative resource path.
     * @param {string} kind - Resource kind used in missing-source diagnostics.
     * @returns {string} Exact matching manifest path.
     */
    function exact(path, kind) {
        const result = paths.get(sourcePath(path).toLowerCase());

        if (!result) {
            throw new Error(`Original world ${kind} missing from manifest: ${path}`);
        }

        return result;
    }

    /**
     * Original model script lookup uses the owning module before Base.
     *
     * @param {string|undefined} name - Authored qualified or module-local model name.
     * @param {object} definition - Item definition supplying the owning module.
     * @returns {object|null} Matching model script, or null when absent.
     */
    function model(name, definition) {
        if (!name) {
            return null;
        }

        if (name.includes('.')) {
            return models.get(name) ?? null;
        }

        return models.get(`${definition.fullType.split('.')[0]}.${name}`) ?? models.get(`Base.${name}`) ?? null;
    }

    /* ScriptManager lowercases paths, loads template_ basenames first, then sorts by full path.
       Static loader/reset authority: artifacts2020–2022; manifest insertion order is not load order. */
    const scripts = [...paths.keys()].filter((path) => /^media\/scripts\/.+\.txt$/u.test(path)).sort((a, b) => {
        const aTemplate = a.slice(a.lastIndexOf('/') + 1).startsWith('template_');
        const bTemplate = b.slice(b.lastIndexOf('/') + 1).startsWith('template_');

        return Number(bTemplate) - Number(aTemplate) || (a < b ? -1 : Number(a > b));
    });

    for (const script of scripts) {
        const path = paths.get(script);

        /* Only model-bearing scripts enter the model grammar; recipes and other source
           record languages do not become accidental prerequisites for ground rendering. */
        // eslint-disable-next-line no-await-in-loop
        const text = await content.getFile(path).text();

        if (!/\bmodel\s+[^\s{}]+\s*\{/u.test(text)) {
            continue;
        }

        for (const record of parseModelDefinitions(text, { path })) {
            const previous = models.get(record.fullType);
            const attachments = new Map();

            /* ResetExisting clears ordinary fields, but ModelScript.reset retains postProcess
               and attachments; LoadAttachment updates only supplied fields of the same id. */
            record.postProcess ??= previous?.postProcess;

            for (const field of [...(previous?.rawFields ?? []), ...record.rawFields]) {
                if (field.name.toLowerCase() !== 'attachment') {
                    continue;
                }

                const existing = attachments.get(field.value);

                attachments.set(field.value, { ...field, children: [...(existing?.children ?? []), ...(field.children ?? [])] });
            }

            record.rawFields = [...record.rawFields.filter((field) => field.name.toLowerCase() !== 'attachment'), ...attachments.values()];

            models.set(record.fullType, record);
        }
    }

    /**
     * Load clothing lazily; unrelated unsupported XML never blocks ordinary model items.
     *
     * @param {object} definition - Item definition with optional ClothingItem name.
     * @returns {Promise<object>|null} Cached clothing metadata, or null without ClothingItem.
     */
    function worn(definition) {
        if (!definition.clothingItem) {
            return null;
        }

        const path = exact(`media/clothing/clothingItems/${sourcePath(definition.clothingItem)}.xml`, 'clothing definition');

        if (!clothing.has(path)) {
            clothing.set(path, content.getFile(path).text().then((text) => parseClothingDefinition(text, { path })));
        }

        return clothing.get(path);
    }

    /**
     * Source-only input for the native first-use ItemVisual initializer.
     *
     * @param {object} definition - Exact native item's original script definition.
     * @returns {Promise<object|null>} Authored choice counts and constructor-default flags, not a random selection.
     */
    async function visualRules(definition) {
        const c = await worn(definition);

        if (c?.rawFields.some((field) => /^(?:m_)?decalgroup$/iu.test(field.name) && field.value)) {
            throw new Error('Unsupported original clothing decal selection');
        }

        return c
            ? {
                    baseTextureCount: c.baseTextures.length,
                    textureChoiceCount: c.textureChoices.length,
                    allowRandomTint: c.allowRandomTint ?? false,
                    allowRandomHue: c.allowRandomHue ?? false,
                    provenance: c.provenance,
                }
            : null;
    }

    /**
     * Packed basename precedes the canonical loose path, matching getSharedTextureInternal.
     *
     * @param {string} name - Packed sprite basename.
     * @param {string} loose - Canonical loose PNG fallback path.
     * @returns {Promise<object|null>} Texture bytes and native trim geometry, or null when absent.
     */
    async function iconTexture(name, loose) {
        const packPath = paths.get('media/texturepacks/ui2.pack');

        if (packPath) {
            uiPack ??= openPack(content.getFile(packPath));
            const pack = await uiPack;
            const matches = pack.lookupAll(name);

            if (matches.length > 1) {
                throw new Error(`Ambiguous original world icon: ${name}`);
            }

            if (matches.length) {
                const s = matches[0];

                if (!s.w || !s.h) {
                    throw new Error(`Original world icon has no drawable pixels: ${name}`);
                }

                return {
                    texture: await pack.pageBlob(s.pageIndex), path: packPath, sprite: name, width: s.w, height: s.h,
                    widthOrig: s.totalW, heightOrig: s.totalH, offsetX: s.xoff, offsetY: s.yoff,
                    crop: { x: s.x, y: s.y, width: s.w, height: s.h },
                };
            }
        }

        const path = paths.get(sourcePath(loose).toLowerCase());

        if (!path) {
            return null;
        }

        const texture = await blob(path);
        const size = await dimensions(texture);

        return { texture, path, ...size, widthOrig: size.width, heightOrig: size.height, offsetX: 0, offsetY: 0 };
    }

    /**
     * Native NoModel sprite: source normal/world texture, ScaleWorldIcon and trim offsets.
     *
     * @param {object} item - Item definition and optional persisted native visual.
     * @returns {Promise<object>} Cached sprite representation with source provenance.
     */
    async function sprite(item) {
        const d = item.definition;

        if (item.visual?.cooked || item.visual?.burnt || item.visual?.rotten) {
            throw new Error('Unsupported original food sprite visual state');
        }

        const name = normalItemIcon(d);

        if (name === null) {
            throw new Error(`Original world icon metadata missing: ${d.fullType}`);
        }

        let texture;

        if (d.useWorldItem) {
            texture = await iconTexture(`WItem_${name}`, `media/inventory/world/WItem_${name}.png`);
        }

        texture ??= await iconTexture(`Item_${name}`, `media/textures/Item_${name}.png`);

        if (!texture) {
            throw new Error(`Original world icon missing: ${d.fullType}`);
        }

        // Item constructor default, artifact1973:14570.
        const scale = d.scaleWorldIcon ?? 1;

        if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error('Invalid original ScaleWorldIcon');
        }

        const tint = color(item.visual?.customColor ? item.visual.color : item.visual?.tint ?? item.visual?.color);
        const key = JSON.stringify(['sprite', texture.path, texture.sprite, scale]);
        const representationKey = JSON.stringify([key, d.fullType, tint]);

        if (!representations.has(representationKey)) {
            representations.set(representationKey, Promise.resolve(Object.freeze({
                kind: 'sprite', key, texture: texture.texture, ...(texture.crop ? { crop: texture.crop } : {}), tint,
                quad: { left: (texture.offsetX - texture.widthOrig / 2) * scale, top: (texture.offsetY - texture.heightOrig * 3 / 4) * scale, width: texture.width * scale, height: texture.height * scale },
                source: { status: 'NoModel', definition: d.provenance, texture: texture.path, sprite: texture.sprite, authority: 'IsoWorldInventoryObject.updateSprite/render' },
            })));
        }

        return representations.get(representationKey);
    }

    /**
     * Build only admitted basicEffect static geometry; unsupported visual states never fall back.
     *
     * @param {object} item - Item definition and optional persisted native visual.
     * @returns {Promise<object>} Hidden, sprite or static model representation.
     */
    async function resolve(item) {
        const d = item?.definition;

        if (!d || typeof d.fullType !== 'string') {
            throw new TypeError('World item requires its exact original definition');
        }

        if (d.worldRender === false) {
            return Object.freeze({ kind: 'hidden', key: `hidden:${d.fullType}`, source: { definition: d.provenance, authority: 'Item.WorldRender' } });
        }

        const visual = item.visual ?? undefined;

        if (visual !== undefined && (typeof visual !== 'object' || Array.isArray(visual))) {
            throw new Error('Unsupported original item visual');
        }

        for (const name of ['fluidLevel', 'bloodLevel', 'hue', 'decal', 'weaponParts']) {
            const value = visual?.[name];

            if (value !== undefined && value !== 0 && value !== false && value !== null && !(Array.isArray(value) && value.length === 0)) {
                throw new Error(`Unsupported original world visual ${name}`);
            }
        }

        if (d.rawFields?.some((f) => /^(fluidcontainer|worldstaticmodelsbyindex|staticmodelsbyindex)$/iu.test(f.name)
            || (f.name.toLowerCase() === 'component' && f.value.toLowerCase() === 'fluidcontainer'))) {
            throw new Error(`Unsupported original world visual selection: ${d.fullType}`);
        }

        if (d.rawFields?.some((f) => /^color(?:red|green|blue)$/iu.test(f.name)) && !visual?.color) {
            throw new Error('Unsupported original item color without native color state');
        }

        const type = d.type?.toLowerCase().replace(/^base:/u, '');
        let selected = null;
        let selection = 'world-static';
        let c;

        if (d.worldStaticModel) {
            selected = model(d.worldStaticModel, d);

            if (!selected) {
                throw new Error(`Original world model script missing from manifest: ${d.worldStaticModel}`);
            }

            if (type === 'food') {
                for (const [state, suffix] of [['cooked', 'Cooked'], ['burnt', 'Burnt'], ['rotten', 'Rotten']]) {
                    if (!visual?.[state]) {
                        continue;
                    }

                    const variant = model(`${d.worldStaticModel}${suffix}`, d);

                    // Registry incompleteness cannot prove original optional-variant absence.
                    if (!variant) {
                        throw new Error(`Original food variant source is required: ${d.worldStaticModel}${suffix}`);
                    }

                    selected = variant;
                }
            }

            if (type === 'clothing' || d.clothingItem) {
                c = await worn(d);
            }
        } else if (type === 'clothing') {
            // itemHasModel explicitly requires real ItemVisual for head clothing.
            if (!visual) {
                return sprite(item);
            }

            c = await worn(d);

            if (!c || c.attachBone?.toLowerCase() !== 'bip01_head' || (d.cosmetic && !['eyes', 'base:eyes'].includes(d.bodyLocation?.toLowerCase())) || !c.maleModel?.trim()) {
                return sprite(item);
            }

            selected = { mesh: c.maleModel, shader: c.shader, isStatic: c.isStatic, rawFields: [], provenance: c.provenance };
            selection = 'head-clothing';
        } else if (type === 'weapon') {
            selected = model(d.staticModel, d);

            if (d.staticModel && !selected) {
                throw new Error(`Original weapon model script missing from manifest: ${d.staticModel}`);
            }

            selection = 'weapon-static';
        }

        if (!selected) {
            return sprite(item);
        }

        if (selected.isStatic === false) {
            throw new Error('Unsupported nonstatic original world model');
        }

        if (selected.shader && selected.shader !== 'basicEffect') {
            throw new Error(`Unsupported original world model shader: ${selected.shader}`);
        }

        if (selected.postProcess) {
            throw new Error(`Unsupported original world model postProcess: ${selected.postProcess}`);
        }

        if (selected.invertX) {
            throw new Error('Unsupported original world model invertX');
        }

        let meshName = sourcePath(selected.mesh);

        if (/\.(?!fbx$)[^/]+$/iu.test(meshName)) {
            throw new Error(`Unsupported original world mesh format: ${meshName}`);
        }

        meshName = meshName.replace(/\.fbx$/iu, '');
        const meshPath = exact(`${meshName.toLowerCase().startsWith('media/') ? meshName : `media/models_X/${meshName}`}.fbx`, 'mesh');
        let textureName = selected.texture || (c ? null : selected.mesh);
        let tint = color(visual?.color);

        if (type === 'clothing' && !c) {
            throw new Error('Original world clothing model requires its ClothingItem metadata');
        }

        if (c) {
            if (c.rawFields.some((field) => /^(?:m_)?decalgroup$/iu.test(field.name) && field.value)) {
                throw new Error('Unsupported original clothing decal selection');
            }

            if (c.allowRandomTint && !visual?.tint) {
                throw new Error('Original clothing visual tint is required');
            }

            tint = c.allowRandomTint ? color(visual.tint) : color(visual?.customColor ? visual.color : undefined);

            if (!textureName) {
                textureName = clothingTexture(c, visual, selection === 'head-clothing' || c.textureChoices.length > 0);
            }

            if (selection === 'head-clothing' && c.allowRandomHue && visual.hue === undefined) {
                throw new Error('Original clothing visual hue is required');
            }
        }

        const t = sourcePath(textureName);
        const texturePath = exact(t.toLowerCase().startsWith('media/') ? t : `media/textures/${t}.png`, 'texture');

        if (paths.has(texturePath.replace(/\.png$/iu, 'TINT.png').toLowerCase())) {
            throw new Error('Unsupported original world tint-mask material');
        }

        const cullFace = selected.cullFace?.toLowerCase() ?? 'none';

        if (!['none', 'back', 'front'].includes(cullFace)) {
            throw new Error(`Unsupported original world model cullFace: ${selected.cullFace}`);
        }

        const scale = (selected.scale ?? 1) * (selected.undoCoreScale ? Math.fround(0.666_666_7) : 1);
        const world = selected.rawFields.filter((f) => f.name.toLowerCase() === 'attachment' && f.value === 'world');

        const fields = new Map((world[0]?.children ?? []).map((f) => [f.name.toLowerCase(), f.value]));

        if (fields.get('bone')) {
            throw new Error('Unsupported bone-bound world attachment');
        }

        const attachmentScale = fields.has('scale') ? Number(fields.get('scale')) : 1;

        if (!Number.isFinite(attachmentScale)) {
            throw new TypeError('Invalid original world attachment scale');
        }

        const key = JSON.stringify(['model', meshPath, texturePath, cullFace]);
        const representationKey = JSON.stringify([key, d.fullType, selected.fullType, selection, scale, [...fields], tint]);

        if (!representations.has(representationKey)) {
            representations.set(representationKey, (async () => {
                if (!meshes.has(meshPath)) {
                    meshes.set(meshPath, (async () => nativeMesh(await parseStaticFbx(await content.getFile(meshPath).slice(0, content.getFile(meshPath).size).arrayBuffer())))());
                }

                const mesh = await meshes.get(meshPath);
                let transform = [...IDENTITY];

                if (selection === 'weapon-static') {
                    transform = attachment([0, 0, 0], [0, 180, 90]);
                }

                if (world.length) {
                    transform = multiply(transform, inverse(attachment(vector(fields.get('offset'), [0, 0, 0]), vector(fields.get('rotate'), [0, 0, 0]), Math.max(0.01, attachmentScale))));
                }

                if (selection === 'head-clothing') {
                    transform = inverse(attachment([mesh.bounds.min[0], 0, 0], [90, 0, -90]));
                }

                transform = multiply(transform, mesh.nativeTransform);
                transform = multiply(transform, attachment([0, 0, 0], [0, 0, 0], scale));

                if (transform.some((value) => !Number.isFinite(Math.fround(value)))) {
                    throw new Error('Unsupported nonfinite original world model transform');
                }

                return Object.freeze({
                    kind: 'model', key, positions: mesh.positions, normals: mesh.normals, uvs: mesh.uvs, indices: mesh.indices,
                    bounds: mesh.bounds, transform: new Float32Array(transform), texture: await blob(texturePath), cullFace, tint,
                    source: {
                        selection, status: 'Ready', definition: d.provenance, model: selected.provenance, mesh: meshPath, texture: texturePath,
                        clothing: c?.provenance, visualSelection: c && !visual ? 'deterministic-source' : 'native-snapshot',
                        authority: 'ItemModelRenderer.renderMain/init;FileTask_LoadMesh.loadFBX;ImportedStaticMesh.processAiScene', metadata: mesh.metadata,
                    },
                });
            })());
        }

        return representations.get(representationKey);
    }

    return { resolve, visualRules };
}
