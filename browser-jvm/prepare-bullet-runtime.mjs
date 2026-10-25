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

const vehicleExports = ['ragdoll_contact_points', 'ragdoll_contact_count', 'ragdoll_bone_count', 'read_ragdoll', 'update_ragdoll_previous_pose', 'apply_ragdoll_force', 'detach_ragdoll_constraint', 'ragdoll_action_state', 'set_ragdoll_local_rotation', 'ragdoll_capsule_support', 'configure_ragdoll_anchors', 'update_ragdoll_root', 'update_ragdoll_pose', 'add_ragdoll', 'remove_ragdoll', 'set_ragdoll_active', 'ragdoll_simulation_state', 'ragdoll_body_state', 'initialize_ragdoll_template', 'ragdoll_template_bone', 'ragdoll_template_shape', 'vehicle_constraint_count', 'vehicle_constraint_feedback', 'add_vehicle_constraint', 'set_vehicle_constraint_erp', 'remove_vehicle_constraint', 'teleport_vehicle', 'apply_torque', 'scroll_map', 'vehicle_count_snapshot', 'get_vehicle_physics_batch', 'vehicle_basis', 'bind_static_mesh', 'has_static_mesh', 'registered_mesh_references', 'observe_vehicle_contacts', 'apply_central_force', 'vehicle_control_history', 'scalar_bytes', 'create_mesh', 'add_hull', 'get_aabb', 'child_count', 'point_count', 'get_point', 'clear_mesh', 'live_meshes', 'world_state', 'create_mapped_world', 'destroy_mapped_world', 'build_geometry', 'clear_geometry', 'geometry_count', 'geometry_body', 'define_vehicle', 'define_vehicle_named', 'vehicle_definition_count', 'select_vehicle_definition', 'add_vehicle', 'vehicle_state', 'vehicle_child', 'vehicle_wheel', 'set_vehicle_active', 'set_vehicle_mass', 'set_vehicle_static', 'set_tire_inflation', 'set_tire_removed', 'set_vehicle_params', 'set_vehicle_velocity_multiplier', 'control_vehicle', 'step_vehicle_freefall', 'get_vehicle_physics', 'replace_chunk_level', 'begin_vehicle_publication', 'finish_vehicle_publication', 'step_mapped_vehicle', 'chunk_level_state', 'vehicle_material', 'set_chunk_levels', 'registered_vehicle_count', 'object_registry_count', 'remove_vehicle', 'world_header', 'activate_map', 'deactivate_map', 'map_info', 'map_chunk', 'malloc', 'free', 'create_world'];

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
    const ragdollBodyHeader = profile === 'vehicle' ? path.join(import.meta.dirname, 'bullet-ragdoll-body.h') : null;
    const ragdollBodySha = ragdollBodyHeader ? digest(await readFile(ragdollBodyHeader)) : null;
    const ragdollActionsHeader = profile === 'vehicle' ? path.join(import.meta.dirname, 'bullet-ragdoll-actions.h') : null;
    const ragdollActionsSha = ragdollActionsHeader ? digest(await readFile(ragdollActionsHeader)) : null;
    const ragdollReadbackHeader = profile === 'vehicle' ? path.join(import.meta.dirname, 'bullet-ragdoll-readback.h') : null;
    const ragdollReadbackSha = ragdollReadbackHeader ? digest(await readFile(ragdollReadbackHeader)) : null;
    const cpp = inputs.filter(([name]) => name.endsWith('.cpp')).map(([name]) => path.join(sourceRoot, name));
    let solverOverlay = null;
    let capsuleOverlay = null;
    let gjkOverlay = null;
    let pairOverlay = null;
    let convexOverlay = null;

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
        /* The original capsule has radial support and an extra margin in its virtual AABB.
         * Modern type-specialized fastpaths otherwise bypass the authored original shape. */
        const capsuleOriginal = path.join(sourceRoot, 'src/BulletCollision/CollisionShapes/btConvexShape.cpp');
        const capsuleBytes = await readFile(capsuleOriginal);
        const supportBefore = 'btVector3 btConvexShape::localGetSupportVertexWithoutMarginNonVirtual(const btVector3& localDir) const\n{\n';
        const aabbBefore = 'void btConvexShape::getAabbNonVirtual(const btTransform& t, btVector3& aabbMin, btVector3& aabbMax) const\n{\n';
        const capsuleText = capsuleBytes.toString('utf8');

        if (digest(capsuleBytes) !== 'a5ca083fd8eaa1a5c7343cbd79d7bdeec52b85c680e492ecec1d9cb3917c02e5'
            || capsuleText.split(supportBefore).length !== 2 || capsuleText.split(aabbBefore).length !== 2) {
            throw new Error('Unqualified original capsule fastpath source');
        }

        const capsuleDerived = Buffer.from(capsuleText
            .replace(supportBefore, `${supportBefore}\tif (m_shapeType == CAPSULE_SHAPE_PROXYTYPE && getUserIndex2() == 0x505a5244) return localGetSupportingVertexWithoutMargin(localDir);\n`)
            .replace(aabbBefore, `${aabbBefore}\tif (m_shapeType == CAPSULE_SHAPE_PROXYTYPE && getUserIndex2() == 0x505a5244) { getAabb(t, aabbMin, aabbMax); return; }\n`));

        if (digest(capsuleDerived) !== '9cf066a92ff92625041e871e0b049dc4a19e245734cc41f70cf0205651ba35f3') {
            throw new Error('Capsule fastpath derivative differs from reviewed bytes');
        }

        const capsuleOutput = path.join(output, 'btConvexShape.cpp');
        const capsuleIndex = cpp.indexOf(capsuleOriginal);

        if (capsuleIndex === -1 || cpp.lastIndexOf(capsuleOriginal) !== capsuleIndex) {
            throw new Error('Expected exactly one capsule fastpath translation unit');
        }

        await writeFile(capsuleOutput, capsuleDerived, { flag: 'wx' });
        cpp[capsuleIndex] = capsuleOutput;
        capsuleOverlay = {
            originalSha: digest(capsuleBytes), overlaySha: digest(capsuleDerived), overlay: capsuleOutput,
            originalNativeSupport: '0x18007c660', originalNativeAabb: '0x180037800',
        };
        const gjkOriginal = path.join(sourceRoot, 'src/BulletCollision/NarrowPhaseCollision/btGjkEpa2.cpp');
        const gjkBytes = await readFile(gjkOriginal);

        if (digest(gjkBytes) !== 'd0f17f0d545646f79b052a1e3691ff2f8ecc775dde5bbcceb1dbbef5c5bc3635') {
            throw new Error('Unqualified original GJK/EPA source');
        }

        let gjkText = gjkBytes.toString('utf8');
        const gjkChanges = [
            ['#define GJK_ACCURACY ((btScalar)1e-12)', '#define GJK_ACCURACY ((btScalar)0.0001)', '0x1800981fe..9821e'],
            ['#define GJK_MIN_DISTANCE ((btScalar)1e-12)', '#define GJK_MIN_DISTANCE ((btScalar)0.0001)', '0x1800980d8..980e1'],
            ['#define GJK_DUPLICATED_EPS ((btScalar)1e-12)', '#define GJK_DUPLICATED_EPS ((btScalar)0.0001)', '0x180098170..981af'],
            ['#define EPA_ACCURACY ((btScalar)1e-12)', '#define EPA_ACCURACY ((btScalar)0.0001)', '0x18009774f..97852'],
            ['#define EPA_PLANE_EPS ((btScalar)1e-14)', '#define EPA_PLANE_EPS ((btScalar)0.00001)', '0x180099fd6;0x18009a6f4'],
            ['#define EPA_MAX_VERTICES 128', '#define EPA_MAX_VERTICES 64', '0x1800977e0..977e9'],
        ];

        for (const [before, after] of gjkChanges) {
            if (gjkText.split(before).length !== 2) {
                throw new Error('Original GJK/EPA compatibility context is absent or ambiguous');
            }

            gjkText = gjkText.replace(before, after);
        }

        gjkText = gjkText.replace('// Config', '// Altered compatibility overlay: source-recovered original native convergence limits.\n// Config');

        const gjkDerived = Buffer.from(gjkText);

        if (digest(gjkDerived) !== '8a074be6640aa3991bb9dbc7a8568c2b3c952efafa2d6c15991de710d503f417') {
            throw new Error('GJK/EPA derivative differs from reviewed bytes');
        }

        const gjkOutput = path.join(output, 'btGjkEpa2.cpp');
        const gjkIndex = cpp.indexOf(gjkOriginal);

        if (gjkIndex === -1 || cpp.lastIndexOf(gjkOriginal) !== gjkIndex) {
            throw new Error('Expected exactly one GJK/EPA translation unit');
        }

        await writeFile(gjkOutput, gjkDerived, { flag: 'wx' });
        cpp[gjkIndex] = gjkOutput;
        gjkOverlay = { originalSha: digest(gjkBytes), overlaySha: digest(gjkDerived), overlay: gjkOutput, changes: gjkChanges };
        const pairOriginal = path.join(sourceRoot, 'src/BulletCollision/NarrowPhaseCollision/btGjkPairDetector.cpp');
        const pairBytes = await readFile(pairOriginal);

        if (digest(pairBytes) !== 'b32b8411f2b3b5e3cfedfa198198c6b7842ac4e9b092873c71155b0ab45b84e8') {
            throw new Error('Unqualified original distance-GJK source');
        }

        let pairText = pairBytes.toString('utf8');
        const pairChanges = [
            ['#define REL_ERROR2 btScalar(1.0e-12)', '#define REL_ERROR2 btScalar(1.0e-6)', '0x1800a59c5..a59ca;0x1800a5a2a'],
            ['btScalar gGjkEpaPenetrationTolerance = 1.0e-12;', 'btScalar gGjkEpaPenetrationTolerance = 0.01;', '0x1800a5c6b..a5c7c'],
            ['if (lenSqr < REL_ERROR2)', 'if (lenSqr < btScalar(0.0001))', '0x1800a5b36..a5b4f'],
        ];

        for (const [before, after] of pairChanges) {
            if (pairText.split(before).length !== 2) {
                throw new Error('Original distance-GJK compatibility context is absent or ambiguous');
            }

            pairText = pairText.replace(before, after);
        }

        const precheckStart = '\t//we add a separate implementation to check if the convex shapes intersect\n';
        const precheckEnd = '\t\t//printf("dir=%f,%f,%f\\n",dir[0],dir[1],dir[2]);\n';

        if (pairText.split(precheckStart).length !== 2 || pairText.split(precheckEnd).length !== 2
            || pairText.split('\tint status = -2;\n').length !== 2
            || pairText.split('if ((checkPenetration && (!isValid || catchDegeneratePenetrationCase)) || (status == 0))').length !== 2) {
            throw new Error('Original distance-GJK call-flow context is absent or ambiguous');
        }

        const precheckOffset = pairText.indexOf(precheckStart);
        const precheckLimit = pairText.indexOf(precheckEnd, precheckOffset) + precheckEnd.length;

        const precheckReplacement = '\t// Original native enters classic distance GJK directly, without the later libCCD precheck.\n\t{\n\t\tbtScalar squaredDistance = BT_LARGE_FLOAT;\n\t\tbtScalar delta = btScalar(0.);\n\t\tm_simplexSolver->reset();\n';

        pairText = `${pairText.slice(0, precheckOffset)}${precheckReplacement}${pairText.slice(precheckLimit)}`;
        pairText = pairText.replace('\tint status = -2;\n', '')
            .replace('if ((checkPenetration && (!isValid || catchDegeneratePenetrationCase)) || (status == 0))', 'if (checkPenetration && (!isValid || catchDegeneratePenetrationCase))');

        pairText = pairText.replace('//must be above the machine epsilon', '// Altered compatibility overlay: original native relative/normal/fallback thresholds.\n//must be above the machine epsilon');

        const pairDerived = Buffer.from(pairText);

        if (digest(pairDerived) !== '6ddda5861e742d50556951e9d73c135263d78321f64953ab0eee08350557a803') {
            throw new Error('Distance-GJK derivative differs from reviewed bytes');
        }

        const pairOutput = path.join(output, 'btGjkPairDetector.cpp');
        const pairIndex = cpp.indexOf(pairOriginal);

        if (pairIndex === -1 || cpp.lastIndexOf(pairOriginal) !== pairIndex) {
            throw new Error('Expected exactly one distance-GJK translation unit');
        }

        await writeFile(pairOutput, pairDerived, { flag: 'wx' });
        cpp[pairIndex] = pairOutput;
        pairOverlay = { originalSha: digest(pairBytes), overlaySha: digest(pairDerived), overlay: pairOutput, changes: pairChanges, callFlowNative: '0x1800a5380..a5633;0x1800a5c84..a5c91' };
        const convexOriginal = path.join(sourceRoot, 'src/BulletCollision/CollisionDispatch/btConvexConvexAlgorithm.cpp');
        const convexBytes = await readFile(convexOriginal);
        const simplexBefore = '\t\tbtVoronoiSimplexSolver simplexSolver;\n\t\tbtGjkPairDetector gjkPairDetector';
        const simplexAfter = '\t\tbtVoronoiSimplexSolver simplexSolver;\n\t\t// Altered compatibility: original constructor 0x18007854a stores double(float(.0001)).\n\t\tsimplexSolver.setEqualVertexThreshold(btScalar(0.0001f));\n\t\tbtGjkPairDetector gjkPairDetector';
        const convexText = convexBytes.toString('utf8');

        if (digest(convexBytes) !== '7b02cbe1ce4d7024b37129905fffeffc68110923de3de6308e1d93b61d88760c' || convexText.split(simplexBefore).length !== 2) {
            throw new Error('Unqualified original contact simplex constructor context');
        }

        const convexDerived = Buffer.from(convexText.replace(simplexBefore, simplexAfter));

        if (digest(convexDerived) !== 'bb5272915473174b8b1d9dc5ed817f27de8cdf418912f50dd04ab8657376ce37') {
            throw new Error('Contact simplex derivative differs from reviewed bytes');
        }

        const convexOutput = path.join(output, 'btConvexConvexAlgorithm.cpp');
        const convexIndex = cpp.indexOf(convexOriginal);

        if (convexIndex === -1 || cpp.lastIndexOf(convexOriginal) !== convexIndex) {
            throw new Error('Expected exactly one convex contact translation unit');
        }

        await writeFile(convexOutput, convexDerived, { flag: 'wx' });
        cpp[convexIndex] = convexOutput;
        convexOverlay = {
            originalSha: digest(convexBytes), overlaySha: digest(convexDerived), overlay: convexOutput,
            simplexNative: '0x18007854a..78560;0x1800a42d1..a4334',
        };
    }

    const compilerArguments = ['-3', compiler, '-std=c++17', '-O1', '-DBT_USE_DOUBLE_PRECISION', `-I${path.join(sourceRoot, 'src')}`,
        ...(capsuleOverlay ? [`-I${path.join(sourceRoot, 'src/BulletCollision/CollisionShapes')}`] : []),
        ...(gjkOverlay ? [`-I${path.join(sourceRoot, 'src/BulletCollision/NarrowPhaseCollision')}`] : []),
        ...(convexOverlay ? [`-I${path.join(sourceRoot, 'src/BulletCollision/CollisionDispatch')}`] : []), bridge, ...cpp,
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
        `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map((name) => `_${name}`))}`, '-o', path.join(output, 'bullet-engine.mjs')];

    await execute('py', compilerArguments,
        { env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 180_000, maxBuffer: 4_194_304 });

    const manifest = {
        profile, exports, solverOverlay, capsuleOverlay, gjkOverlay, pairOverlay, convexOverlay, compilerArguments, sourceInventorySha: digest(JSON.stringify(inputs)),
        compilerSha: digest(await readFile(compiler)), compilerConfigSha: digest(await readFile(path.join(sdk, '.emscripten'))),
        candidateCommit: '2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5', candidateVersion: '3.25', installedCoreVersion: 'unknown', versionMatchVerified: false,
        compilerVersion: '3.1.74', scalarBytes: 8, bridgeSha, ragdollTemplateSha, ragdollBodySha, ragdollActionsSha, ragdollReadbackSha, sources: cpp.length,
        compilerVerification: 'emcc.py SHA-256; SDK release provenance is documented separately', upstreamLicense: 'BULLET-LICENSE.txt',
        moduleSha: digest(await readFile(path.join(output, 'bullet-engine.mjs'))), wasmSha: digest(await readFile(path.join(output, 'bullet-engine.wasm'))),
    };

    if (digest(await readFile(bridge)) !== bridgeSha || (ragdollHeader && digest(await readFile(ragdollHeader)) !== ragdollTemplateSha)
        || (ragdollBodyHeader && digest(await readFile(ragdollBodyHeader)) !== ragdollBodySha)
        || (ragdollActionsHeader && digest(await readFile(ragdollActionsHeader)) !== ragdollActionsSha)
        || (ragdollReadbackHeader && digest(await readFile(ragdollReadbackHeader)) !== ragdollReadbackSha)) {
        throw new Error('Bullet bridge changed during compilation');
    }

    if (solverOverlay && (digest(await readFile(solverOverlay.overlay)) !== solverOverlay.overlaySha
        || digest(await readFile(solverOverlay.copiedHeader)) !== solverOverlay.headerSha
        || digest(await readFile(path.join(import.meta.dirname, 'bullet-vehicle-warmstart.patch'))) !== solverOverlay.patchSha
        || digest(await readFile(path.join(import.meta.dirname, 'bullet-vehicle-force-order.patch'))) !== solverOverlay.forcePatchSha)) {
        throw new Error('Vehicle solver derivative changed during compilation');
    }

    if (capsuleOverlay && digest(await readFile(capsuleOverlay.overlay)) !== capsuleOverlay.overlaySha) {
        throw new Error('Capsule fastpath derivative changed during compilation');
    }

    if (gjkOverlay && digest(await readFile(gjkOverlay.overlay)) !== gjkOverlay.overlaySha) {
        throw new Error('GJK/EPA derivative changed during compilation');
    }

    if (pairOverlay && digest(await readFile(pairOverlay.overlay)) !== pairOverlay.overlaySha) {
        throw new Error('Distance-GJK derivative changed during compilation');
    }

    if (convexOverlay && digest(await readFile(convexOverlay.overlay)) !== convexOverlay.overlaySha) {
        throw new Error('Contact simplex derivative changed during compilation');
    }

    await verifySources(inputs);

    await writeFile(path.join(output, 'BULLET-LICENSE.txt'), await readFile(path.join(sourceRoot, 'LICENSE.txt')));
    await writeFile(path.join(output, 'bullet-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
}
