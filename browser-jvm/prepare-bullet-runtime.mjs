import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(repository, '.tools/bullet3-2c204c49');
const sdk = path.join(repository, '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba');
const compiler = path.join(sdk, 'upstream/emscripten/emcc.py');
const foundationExports = ['scalar_bytes', 'create_mesh', 'add_hull', 'get_aabb', 'child_count', 'point_count', 'get_point', 'clear_mesh', 'live_meshes', 'create_world', 'world_state', 'destroy_world', 'create_mapped_world', 'activate_map', 'world_header', 'deactivate_map', 'map_info', 'map_chunk', 'destroy_mapped_world', 'malloc', 'free'];

const vehicleExports = ['initialize_ragdoll_template', 'ragdoll_template_bone', 'ragdoll_template_shape', 'vehicle_constraint_count', 'vehicle_constraint_feedback', 'add_vehicle_constraint', 'set_vehicle_constraint_erp', 'remove_vehicle_constraint', 'teleport_vehicle', 'apply_torque', 'scroll_map', 'vehicle_count_snapshot', 'get_vehicle_physics_batch', 'vehicle_basis', 'bind_static_mesh', 'has_static_mesh', 'registered_mesh_references', 'observe_vehicle_contacts', 'apply_central_force', 'vehicle_control_history', 'scalar_bytes', 'create_mesh', 'add_hull', 'get_aabb', 'child_count', 'point_count', 'get_point', 'clear_mesh', 'live_meshes', 'world_state', 'create_mapped_world', 'destroy_mapped_world', 'build_geometry', 'clear_geometry', 'geometry_count', 'geometry_body', 'define_vehicle', 'define_vehicle_named', 'vehicle_definition_count', 'select_vehicle_definition', 'add_vehicle', 'vehicle_state', 'vehicle_child', 'vehicle_wheel', 'set_vehicle_active', 'set_vehicle_mass', 'set_vehicle_static', 'set_tire_inflation', 'set_tire_removed', 'set_vehicle_params', 'set_vehicle_velocity_multiplier', 'control_vehicle', 'step_vehicle_freefall', 'get_vehicle_physics', 'replace_chunk_level', 'begin_vehicle_publication', 'finish_vehicle_publication', 'step_mapped_vehicle', 'chunk_level_state', 'vehicle_material', 'set_chunk_levels', 'registered_vehicle_count', 'object_registry_count', 'remove_vehicle', 'world_header', 'activate_map', 'deactivate_map', 'map_info', 'map_chunk', 'malloc', 'free', 'create_world'];

/**
 * Computes a byte-exact source or generated artifact fingerprint.
 *
 * @param {Buffer|string} bytes - Exact input bytes.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verifies every pinned upstream source before and after compilation.
 *
 * @param {Array<Array<string>>} inputs - Relative paths and required hashes.
 * @returns {Promise<void>} Completion of all source checks.
 */
async function verifySources(inputs) {
    const canonicalSource = await realpath(sourceRoot);

    await Promise.all(inputs.map(async ([name, expected]) => {
        const file = await realpath(path.join(sourceRoot, name));

        if (!file.startsWith(`${canonicalSource}${path.sep}`) || digest(await readFile(file)) !== expected) {
            throw new Error(`Pinned Bullet source changed: ${name}`);
        }
    }));
}

/**
 * Creates each output component only after its parent is known to remain owned.
 *
 * @param {Array<string>} parts - Remaining relative directory components.
 * @param {string} parent - Canonical validated parent directory.
 * @param {string} target - Canonical workspace target root.
 * @returns {Promise<void>} Completion of contained directory creation.
 */
async function createOutput(parts, parent, target) {
    if (parts.length === 0) {
        return;
    }

    const directory = path.join(parent, parts[0]);

    try {
        await mkdir(directory);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }

    const canonical = await realpath(directory);

    if (!canonical.startsWith(`${target}${path.sep}`)) {
        throw new Error('Bullet output must not escape through a junction');
    }

    await createOutput(parts.slice(1), canonical, target);
}

/**
 * Validates the existing pinned local tools and compiles the real double-precision core.
 * No source, SDK, dependency, or game asset is downloaded by this helper.
 *
 * @param {string} outputDirectory - Owned directory under the workspace target directory.
 * @param {object} [options] - Explicit component selection; foundation remains the default.
 * @param {string} [options.profile] - Foundation or vehicle component.
 * @returns {Promise<object>} Source and output hashes for the compiled component.
 */
export async function prepareBulletRuntime(outputDirectory, { profile = 'foundation' } = {}) {
    if (!['foundation', 'vehicle'].includes(profile)) {
        throw new Error('Unknown Bullet component profile');
    }

    const exports = profile === 'vehicle' ? vehicleExports : foundationExports;
    const output = path.resolve(outputDirectory);
    const targetPath = path.join(repository, 'target');

    await mkdir(targetPath, { recursive: true });

    const target = await realpath(targetPath);

    if (target !== path.join(await realpath(repository), 'target')) {
        throw new Error('Bullet target directory must not escape through a junction');
    }

    if (!output.startsWith(`${path.join(repository, 'target')}${path.sep}`)) {
        throw new Error('Bullet output must be a workspace target subdirectory');
    }

    await createOutput(path.relative(targetPath, output).split(path.sep), target, target);

    if (digest(await readFile(compiler)) !== 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd') {
        throw new Error('Pinned Emscripten 3.1.74 compiler is unavailable or changed');
    }

    const sourceManifest = JSON.parse(await readFile(path.join(import.meta.dirname, 'bullet-sources.json'), 'utf8'));
    const inputs = sourceManifest.files.map(({ file, sha256 }) => [file, sha256]).sort((left, right) => left[0].localeCompare(right[0], 'en'));

    if (digest(JSON.stringify(inputs)) !== '63048c5718d2c086889682f6f40d79f6b599b90bd029a3acfb22fc06a1455273') {
        throw new Error('Pinned Bullet source inventory changed');
    }

    await verifySources(inputs);

    const bridge = path.join(import.meta.dirname, profile === 'vehicle' ? 'bullet-vehicle-engine.cpp' : 'bullet-engine.cpp');
    const bridgeSha = digest(await readFile(bridge));
    const ragdollHeader = profile === 'vehicle' ? path.join(import.meta.dirname, 'bullet-ragdoll-template.h') : null;
    const ragdollTemplateSha = ragdollHeader ? digest(await readFile(ragdollHeader)) : null;
    const cpp = inputs.filter(([name]) => name.endsWith('.cpp')).map(([name]) => path.join(sourceRoot, name));
    let solverOverlay = null;

    if (profile === 'vehicle') {
        const original = path.join(sourceRoot, 'src/BulletDynamics/ConstraintSolver/btSequentialImpulseConstraintSolver.cpp');
        const header = path.join(sourceRoot, 'src/BulletDynamics/ConstraintSolver/btSequentialImpulseConstraintSolver.h');
        const originalBytes = await readFile(original);
        const headerBytes = await readFile(header);
        const patchBytes = await readFile(path.join(import.meta.dirname, 'bullet-vehicle-warmstart.patch'));

        if (digest(originalBytes) !== '5b0a5553fbf0aa3c57fd9af431775613f0a6c7da46a7efe78443d1eb2563daa6'
            || digest(headerBytes) !== '3b0ffd801b3aeb630de963ea7e22893e585314bf3eb5fee49cb28c2c3e618f56') {
            throw new Error('Unqualified original sequential solver source/header');
        }

        // This component has exactly one reviewed function hunk, never a general patch interpreter.
        const lines = patchBytes.toString('utf8').replaceAll('\r\n', '\n').split('\n');
        const hunks = lines.filter((line) => line.startsWith('@@'));

        if (hunks.length !== 1) {
            throw new Error('Vehicle compatibility patch must contain exactly one hunk');
        }

        const body = lines.slice(lines.findIndex((line) => line.startsWith('@@')) + 1).filter((line) => /^[ +-]/u.test(line));
        const before = `${body.filter((line) => !line.startsWith('+')).map((line) => line.slice(1)).join('\n')}\n`;
        const after = `${body.filter((line) => !line.startsWith('-')).map((line) => line.slice(1)).join('\n')}\n`;
        const originalText = originalBytes.toString('utf8');

        if (originalText.split(before).length !== 2) {
            throw new Error('Vehicle solver patch context is absent or ambiguous');
        }

        let overlayBytes = Buffer.from(originalText.replace(before, after));

        if (digest(overlayBytes) !== '60b2b900e7d43187443f636429acb19acaa436e2b4bbc79018f2ca28f103b456') {
            throw new Error('Vehicle solver derivative differs from qualified bytes');
        }

        const forcePatchBytes = await readFile(path.join(import.meta.dirname, 'bullet-vehicle-force-order.patch'));
        const forceLines = forcePatchBytes.toString('utf8').replaceAll('\r\n', '\n').split('\n');

        if (forceLines.filter((line) => line.startsWith('@@')).length !== 1) {
            throw new Error('Force-order compatibility patch must contain exactly one hunk');
        }

        const forceBody = forceLines.slice(forceLines.findIndex((line) => line.startsWith('@@')) + 1).filter((line) => /^[ +-]/u.test(line));
        const forceBefore = `${forceBody.filter((line) => !line.startsWith('+')).map((line) => line.slice(1)).join('\n')}\n`;
        const forceAfter = `${forceBody.filter((line) => !line.startsWith('-')).map((line) => line.slice(1)).join('\n')}\n`;
        const warmstartText = overlayBytes.toString('utf8');

        if (warmstartText.split(forceBefore).length !== 2) {
            throw new Error('Force-order patch context is absent or ambiguous');
        }

        overlayBytes = Buffer.from(warmstartText.replace(forceBefore, forceAfter));

        if (digest(overlayBytes) !== 'e780c1c6c0900625e14d51c6c6de697882b8d64d326133a308d6d5498c8b9b27') {
            throw new Error('Force-order solver derivative differs from reviewed bytes');
        }

        // Preserve the original solver's shallow/deep ERP selection without changing game classes.
        const erpBefore = '\tbtScalar erp = infoGlobal.m_erp2;\n';
        const erpAfter = `${erpBefore}\t// Original DLL 0x1800648eb..0x1800648fb (Bullet 2.82): shallow contacts use ERP.\n\tif (!infoGlobal.m_splitImpulse || cp.getDistance() + infoGlobal.m_linearSlop > infoGlobal.m_splitImpulsePenetrationThreshold)\n\t\terp = infoGlobal.m_erp;\n`;
        const forceText = overlayBytes.toString('utf8');

        if (forceText.split(erpBefore).length !== 2) {
            throw new Error('Original contact ERP context is absent or ambiguous');
        }

        overlayBytes = Buffer.from(forceText.replace(erpBefore, erpAfter));

        if (digest(overlayBytes) !== '2a79dede1585b30244f86201202a53af14255999add3cbc16e0914456ed4012d') {
            throw new Error('Contact ERP derivative differs from reviewed bytes');
        }

        const overlay = path.join(output, 'btSequentialImpulseConstraintSolver.cpp');
        const copiedHeader = path.join(output, 'btSequentialImpulseConstraintSolver.h');
        const index = cpp.indexOf(original);

        if (cpp.length !== 153 || index === -1 || cpp.lastIndexOf(original) !== index) {
            throw new Error('Vehicle component requires exactly one original solver among153 translation units');
        }

        await writeFile(overlay, overlayBytes, { flag: 'wx' });
        await writeFile(copiedHeader, headerBytes, { flag: 'wx' });
        cpp[index] = overlay;
        solverOverlay = {
            originalSha: digest(originalBytes), patchSha: digest(patchBytes), overlaySha: digest(overlayBytes), headerSha: digest(headerBytes),
            original, overlay, copiedHeader, replacements: 3, contactErpNativeAddress: '0x1800648eb..0x1800648fb', forcePatchSha: digest(forcePatchBytes),
        };
    }

    const compilerArguments = ['-3', compiler, '-std=c++17', '-O1', '-DBT_USE_DOUBLE_PRECISION', `-I${path.join(sourceRoot, 'src')}`, bridge, ...cpp,
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
        `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map((name) => `_${name}`))}`, '-o', path.join(output, 'bullet-engine.mjs')];

    await execute('py', compilerArguments,
        { env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 180_000, maxBuffer: 4_194_304 });

    const manifest = {
        profile, exports, solverOverlay, compilerArguments, sourceInventorySha: digest(JSON.stringify(inputs)),
        compilerSha: digest(await readFile(compiler)), compilerConfigSha: digest(await readFile(path.join(sdk, '.emscripten'))),
        candidateCommit: '2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5', candidateVersion: '3.25', installedCoreVersion: 'unknown', versionMatchVerified: false,
        compilerVersion: '3.1.74', scalarBytes: 8, bridgeSha, ragdollTemplateSha, sources: cpp.length,
        compilerVerification: 'emcc.py SHA-256; SDK release provenance is documented separately', upstreamLicense: 'BULLET-LICENSE.txt',
        moduleSha: digest(await readFile(path.join(output, 'bullet-engine.mjs'))), wasmSha: digest(await readFile(path.join(output, 'bullet-engine.wasm'))),
    };

    if (digest(await readFile(bridge)) !== bridgeSha || (ragdollHeader && digest(await readFile(ragdollHeader)) !== ragdollTemplateSha)) {
        throw new Error('Bullet bridge changed during compilation');
    }

    if (solverOverlay && (digest(await readFile(solverOverlay.overlay)) !== solverOverlay.overlaySha
        || digest(await readFile(solverOverlay.copiedHeader)) !== solverOverlay.headerSha
        || digest(await readFile(path.join(import.meta.dirname, 'bullet-vehicle-warmstart.patch'))) !== solverOverlay.patchSha
        || digest(await readFile(path.join(import.meta.dirname, 'bullet-vehicle-force-order.patch'))) !== solverOverlay.forcePatchSha)) {
        throw new Error('Vehicle solver derivative changed during compilation');
    }

    await verifySources(inputs);

    await writeFile(path.join(output, 'BULLET-LICENSE.txt'), await readFile(path.join(sourceRoot, 'LICENSE.txt')));
    await writeFile(path.join(output, 'bullet-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
}
