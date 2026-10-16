import { visit } from '../node_modules/@shaderfrog/glsl-parser/ast/index.js';
import { parse, generate } from '../node_modules/@shaderfrog/glsl-parser/index.js';

const reservedFunctions = new Set(['min', 'max', 'clamp']);

/**
 * Finds the scalar component type of a GLSL numeric type.
 *
 * @param {string} type - GLSL scalar, vector, or matrix type.
 * @returns {string} Component type, or the unchanged scalar type.
 */
function scalar(type) {
    if (!/^(?:[biu]?vec[2-4]|mat[2-4](?:x[2-4])?)$/.test(type)) {
        return type;
    }

    for (const [prefix, component] of [['ivec', 'int'], ['uvec', 'uint'], ['bvec', 'bool']]) {
        if (type.startsWith(prefix)) {
            return component;
        }
    }

    return 'float';
}

/**
 * Reads a declared type from a parser type specifier.
 *
 * @param {object} node - Type-specifier AST node.
 * @returns {string|undefined} Declared GLSL type name.
 */
const typeName = (node) => node?.specifier?.token || node?.specifier?.identifier;
/**
 * Excludes punctuation from a call's argument list.
 *
 * @param {object} node - Function-call AST node.
 * @returns {object[]} Argument expression nodes.
 */
const argumentsOf = (node) => node.args.filter((argument) => argument.type !== 'literal');
/**
 * Reads the name of a function or constructor call.
 *
 * @param {object} node - Function-call AST node.
 * @returns {string|undefined} Called function or constructor name.
 */
const callableName = (node) => node.identifier?.identifier || typeName(node.identifier);

/**
 * Constructs an explicit scalar/vector conversion around the original expression.
 *
 * @param {object} node - Original expression, evaluated exactly once.
 * @param {string} target - GLSL constructor name.
 * @returns {object} Constructor-call AST retaining the original expression.
 */
function cast(node, target) {
    return {
        type: 'function_call',
        identifier: { type: 'identifier', identifier: target },
        lp: { type: 'literal', literal: '(' },
        args: [node],
        rp: { type: 'literal', literal: ')' },
    };
}

/**
 * Scores the supported standard int-to-float conversion, preserving vector dimensions.
 *
 * @param {string} from - Expression type.
 * @param {string} to - Parameter or result type.
 * @returns {number} Zero for exact, one for promotion, infinity for unsupported.
 */
function conversion(from, to) {
    if (from === to && from) {
        return 0;
    }

    return ((from === 'int' || from === 'uint') && to === 'float')
        || (/^[iu]vec[2-4]$/.test(from) && to === from.slice(1))
        ? 1
        : Infinity;
}

/**
 * Retains integer operations and promotes only an integer operand paired with a float.
 *
 * @param {object} node - Binary or conditional expression.
 * @param {string} left - Left operand type.
 * @param {string} right - Right operand type.
 * @returns {string|undefined} Arithmetic result type when known.
 */
function pair(node, left, right) {
    if (!left || !right) {
        return undefined;
    }

    if (scalar(left) === 'float' && scalar(right) !== 'float' && conversion(right, 'float') === 1) {
        node.right = cast(node.right, 'float');
        right = 'float';
    } else if (scalar(right) === 'float' && scalar(left) !== 'float' && conversion(left, 'float') === 1) {
        node.left = cast(node.left, 'float');
        left = 'float';
    }

    if (left === right || right === scalar(left)) {
        return left;
    }

    return left === scalar(right) ? right : undefined;
}

/**
 * Makes demonstrated desktop GLSL conversions explicit without changing integer expressions.
 * Function signatures are resolved here; the parser's scope index only resolves call arity.
 *
 * @param {string} source - A complete shader stage or individual desktop compilation unit.
 * @param {string} stage - Vertex or fragment stage used for built-in identifiers.
 * @returns {string} Structurally adapted GLSL for the actual ES compiler.
 */
export function normalizeDesktopShader(source, stage) {
    const ast = parse(source, { stage, quiet: true });
    const types = new WeakMap();
    const functions = new Map();
    const definitions = [];
    const identifiers = new Set();
    const legacyTextureArities = new Set();
    let legacyTextureName = 'portLegacyTexture2D';
    const legacyColor = stage === 'vertex' ? 'gl_FrontColor' : 'gl_Color';
    let needsLegacyColor = false;

    visit(ast, {
        identifier: {
            /**
             * Preserves the legacy front-color varying across desktop shader stages.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Identifier AST node.
             */
            enter: ({ node }) => {
                identifiers.add(node.identifier);

                if (node.identifier === legacyColor) {
                    node.identifier = 'portLegacyFrontColor';
                    types.set(node, 'vec4');
                    needsLegacyColor = true;
                }
            },
        },
        declarator_list: {
            /**
             * Records the declared type of each variable.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Current GLSL AST node.
             */
            enter: ({ node }) => {
                const type = typeName(node.specified_type.specifier);

                for (const declaration of node.declarations) {
                    types.set(declaration.identifier, type + (declaration.quantifier?.length ? '[]' : ''));
                }
            },
        },
        parameter_declaration: {
            /**
             * Records each parameter type for scope references.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Current GLSL AST node.
             */
            enter: ({ node }) => {
                types.set(node, typeName(node.specifier) + (node.quantifier?.length ? '[]' : ''));
            },
        },
        function_prototype: {
            /**
             * Indexes function overloads and renames conflicting desktop built-ins.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Current GLSL AST node.
             */
            enter: ({ node }) => {
                const name = node.header.name.identifier;
                const parameters = (node.parameters || []).map((parameter) => typeName(parameter.specifier));
                const signature = { name, parameters, result: typeName(node.header.returnType.specifier), prototype: node };

                if (!functions.has(name)) {
                    functions.set(name, []);
                }

                if (!functions.get(name).some((item) => item.parameters.join() === parameters.join())) {
                    functions.get(name).push(signature);
                }

                if (reservedFunctions.has(name)) {
                    node.header.name.identifier = `portDesktop_${name}`;
                }

                definitions.push(signature);
            },
        },
    });

    while (identifiers.has(legacyTextureName)) {
        legacyTextureName += '_';
    }

    for (const scope of ast.scopes) {
        for (const binding of Object.values(scope.bindings)) {
            const type = types.get(binding.declaration);

            if (type) {
                for (const reference of binding.references) {
                    types.set(reference, type);
                }
            }
        }
    }

    /**
     * Infers the encountered expression types and adapts their required numeric promotions.
     * Unknown syntax remains subject to the real compiler, never guessed from source names.
     *
     * @param {object} node - GLSL expression.
     * @returns {string|undefined} Known GLSL type.
     */
    function expression(node) {
        if (!node) {
            return undefined;
        }

        if (types.has(node)) {
            return types.get(node);
        }

        let result;

        switch (node.type) {
            case 'int_constant':
                result = 'int';
                break;
            case 'uint_constant':
                result = 'uint';
                break;
            case 'float_constant':
                result = 'float';
                break;
            case 'bool_constant':
                result = 'bool';
                break;
            case 'identifier':
                result = { gl_Position: 'vec4', gl_FragCoord: 'vec4', gl_FragColor: 'vec4', gl_FragDepth: 'float', gl_VertexID: 'int' }[node.identifier];
                break;
            case 'group':
                result = expression(node.expression);
                break;
            case 'unary':
                result = expression(node.expression);
                break;
            case 'postfix': {
                const base = expression(node.expression);

                if (node.postfix.type === 'field_selection' && /^[biu]?vec[2-4]$/.test(base)) {
                    const length = node.postfix.selection.identifier?.length || node.postfix.selection.literal?.length;

                    result = length === 1 ? scalar(base) : base.replace(/[2-4]$/, String(length));
                } else if (node.postfix.type === 'quantifier') {
                    if (base?.endsWith('[]')) {
                        result = base.slice(0, -2);
                    } else {
                        result = /^mat[2-4]$/.test(base) ? `vec${base.slice(3)}` : scalar(base);
                    }
                } else {
                    result = base;
                }

                break;
            }
            case 'binary': {
                const left = expression(node.left);
                const right = expression(node.right);

                result = pair(node, left, right);

                if (['==', '!=', '<', '>', '<=', '>=', '&&', '||', '^^'].includes(node.operator.literal)) {
                    result = 'bool';
                } else if (node.operator.literal === '*' && /^mat[2-4]$/.test(left) && right === `vec${left.slice(3)}`) {
                    result = right;
                }

                break;
            }
            case 'assignment': {
                result = expression(node.left);
                const right = expression(node.right);

                if (conversion(right, result) === 1) {
                    node.right = cast(node.right, result);
                }

                break;
            }
            case 'ternary':
                expression(node.expression);
                result = pair(node, expression(node.left), expression(node.right));
                break;
            case 'function_call': {
                const name = callableName(node);
                const args = argumentsOf(node);
                const argumentTypes = args.map(expression);

                if (reservedFunctions.has(name) && functions.has(name) && argumentTypes.some((type) => !type)) {
                    throw new Error(`Unresolved desktop overload ${name}(${argumentTypes.join(', ')})`);
                }

                if (/^(?:float|int|uint|bool|[biu]?vec[2-4]|mat[2-4](?:x[2-4])?)$/.test(name)) {
                    result = name;
                    break;
                }

                const candidates = (functions.get(name) || []).filter((candidate) => candidate.parameters.length === args.length)
                    .map((candidate) => ({ ...candidate, score: candidate.parameters.reduce((sum, type, index) => sum + conversion(argumentTypes[index], type), 0) }))
                    .filter((candidate) => Number.isFinite(candidate.score)).sort((a, b) => a.score - b.score);
                const builtinTargets = [];

                if (reservedFunctions.has(name)) {
                    const count = name === 'clamp' ? 3 : 2;

                    for (const base of ['float', 'int', 'uint']) {
                        for (const width of [1, 2, 3, 4]) {
                            const vector = width === 1 ? base : `${base === 'float' ? '' : base.slice(0, 1)}vec${width}`;

                            builtinTargets.push(Array.from({ length: count }, () => vector));

                            if (width > 1) {
                                builtinTargets.push([vector, ...Array.from({ length: count - 1 }, () => base)]);
                            }
                        }
                    }
                }

                const builtinScore = Math.min(...builtinTargets.map((parameters) => parameters.length === args.length
                    ? parameters.reduce((sum, type, index) => sum + conversion(argumentTypes[index], type), 0)
                    : Infinity));
                const selected = candidates[0]?.score <= builtinScore ? candidates[0] : undefined;

                if (selected && candidates[1]?.score === selected.score) {
                    throw new Error(`Ambiguous desktop overload ${name}(${argumentTypes.join(', ')})`);
                }

                if (selected && (!candidates[1] || selected.score < candidates[1].score)) {
                    for (let index = 0; index < node.args.length; index += 2) {
                        const type = selected.parameters[index / 2];

                        if (conversion(argumentTypes[index / 2], type) === 1) {
                            node.args[index] = cast(node.args[index], type);
                        }
                    }

                    if (reservedFunctions.has(name)) {
                        node.identifier.identifier = `portDesktop_${name}`;
                    }

                    result = selected.result;
                } else if (name === 'texture2D') {
                    if (argumentTypes[0] !== 'sampler2D' || argumentTypes[1] !== 'vec2'
                        || (args.length !== 2 && !(stage === 'fragment' && args.length === 3 && Number.isFinite(conversion(argumentTypes[2], 'float'))))) {
                        throw new Error(`Unqualified legacy texture2D(${argumentTypes.join(', ')}) in ${stage} shader`);
                    }

                    if (args.length === 3 && conversion(argumentTypes[2], 'float') === 1) {
                        node.args[4] = cast(node.args[4], 'float');
                    }

                    node.identifier.identifier = legacyTextureName;
                    legacyTextureArities.add(args.length);
                    result = 'vec4';
                } else if (/^(?:texture|textureLod|textureProj)$/.test(name)) {
                    result = 'vec4';
                } else if (['dot', 'length', 'distance', 'determinant'].includes(name)) {
                    result = 'float';
                } else if (['any', 'all'].includes(name)) {
                    result = 'bool';
                } else if (reservedFunctions.has(name) || ['mix', 'step', 'smoothstep', 'pow', 'mod'].includes(name)) {
                    result = argumentTypes.find((type) => /vec[2-4]$/.test(type)) || argumentTypes.find((type) => scalar(type) === 'float') || argumentTypes[0];

                    for (let index = 0; index < node.args.length; index += 2) {
                        if (scalar(result) === 'float' && conversion(argumentTypes[index / 2], 'float') === 1) {
                            node.args[index] = cast(node.args[index], 'float');
                        }
                    }
                } else if (['abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'normalize', 'reflect', 'refract', 'cross', 'faceforward', 'inverse', 'transpose', 'dFdx', 'dFdy', 'fwidth'].includes(name)) {
                    result = argumentTypes[0];
                }

                break;
            }

            default: break;
        }

        if (result) {
            types.set(node, result);
        }

        return result;
    }

    visit(ast, {
        declarator_list: {
            /**
             * Promotes variable initializers to their declared type.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Current GLSL AST node.
             */
            enter: ({ node }) => {
                const target = typeName(node.specified_type.specifier);

                for (const declaration of node.declarations) {
                    const actual = expression(declaration.initializer);

                    if (conversion(actual, target) === 1) {
                        declaration.initializer = cast(declaration.initializer, target);
                    }
                }
            },
        },
        function: {
            /**
             * Adapts return expressions to the enclosing function result type.
             *
             * @param {object} root0 - Visitor context.
             * @param {object} root0.node - Current GLSL AST node.
             */
            enter: ({ node }) => {
                const target = typeName(node.prototype.header.returnType.specifier);

                visit(node.body, {
                    return_statement: {
                        /**
                         * Promotes this return expression when required.
                         *
                         * @param {object} root0 - Visitor context.
                         * @param {object} root0.node - Current GLSL AST node.
                         */
                        enter: ({ node: statement }) => {
                            if (conversion(expression(statement.expression), target) === 1) {
                                statement.expression = cast(statement.expression, target);
                            }
                        },
                    },
                });
            },
        },
        binary: { /**
                   * Infers and adapts binary operands.
                   *
                   * @param {object} root0 - Visitor context.
                   * @param {object} root0.node - Current GLSL AST node.
                   * @returns {string|undefined} Known expression result type.
                   */
            enter: ({ node }) => expression(node),
        },
        assignment: { /**
                       * Infers and adapts assignment operands.
                       *
                       * @param {object} root0 - Visitor context.
                       * @param {object} root0.node - Current GLSL AST node.
                       * @returns {string|undefined} Known expression result type.
                       */
            enter: ({ node }) => expression(node),
        },
        function_call: { /**
                          * Resolves function signatures and required argument conversions.
                          *
                          * @param {object} root0 - Visitor context.
                          * @param {object} root0.node - Current GLSL AST node.
                          * @returns {string|undefined} Known expression result type.
                          */
            enter: ({ node }) => expression(node),
        },
        ternary: { /**
                    * Infers and adapts conditional branches.
                    *
                    * @param {object} root0 - Visitor context.
                    * @param {object} root0.node - Current GLSL AST node.
                    * @returns {string|undefined} Known expression result type.
                    */
            enter: ({ node }) => expression(node),
        },
    });

    const initializers = [];

    for (const statement of ast.program) {
        const declaration = statement.declaration;

        if (declaration?.type !== 'declarator_list' || declaration.specified_type.qualifiers?.some((qualifier) => ['const', 'uniform', 'in', 'out', 'attribute', 'varying'].includes(qualifier.token))) {
            continue;
        }

        for (const variable of declaration.declarations) {
            if (variable.initializer) {
                initializers.push(`${variable.identifier.identifier} = ${generate(variable.initializer)};`);
                delete variable.initializer;
                delete variable.equal;
            }
        }
    }

    const main = ast.program.find((node) => node.type === 'function' && node.prototype.header.name.identifier === 'main');

    const prototypes = [...new Set(definitions.filter((item) => reservedFunctions.has(item.name)).map((item) => `${generate(item.prototype)};\n`))];

    // Library units only compile here; the facade recomposes their raw sources before linking.
    if (main && initializers.length) {
        if (functions.has('portInitializeGlobals')) {
            throw new Error('Shader function collides with the global initializer adapter');
        }

        prototypes.push('void portInitializeGlobals();\n');
        main.body.statements.unshift(...parse('void main(){portInitializeGlobals();}', { quiet: true }).program[0].body.statements);
        // Define after every original global, including globals from subsequently attached units.
        ast.program.push(...parse(`\nvoid portInitializeGlobals(){${initializers.join('\n')}}\n`, { quiet: true }).program);
    }

    const firstFunction = ast.program.findIndex((node) => node.type === 'function');

    if (needsLegacyColor && firstFunction !== -1) {
        prototypes.unshift(`${stage === 'vertex' ? 'out' : 'in'} highp vec4 portLegacyFrontColor;\n`);
    }

    if (prototypes.length && firstFunction !== -1) {
        ast.program.splice(firstFunction, 0, ...parse(prototypes.join(''), { quiet: true }).program);
    }

    if (legacyTextureArities.size) {
        const helpers = [...legacyTextureArities].map((arity) => `highp vec4 ${legacyTextureName}(highp sampler2D image, highp vec2 uv${arity === 3 ? ', highp float bias' : ''}) { return texture(image, uv${arity === 3 ? ', bias' : ''}); }\n`);
        const firstGlobal = ast.program.findIndex((node) => node.type !== 'preprocessor' && node.declaration?.type !== 'precision');

        /* Resolve the builtin before an original global named texture enters scope.
         * Insert once after stage composition, retaining every original uniform name.
         */
        ast.program.splice(firstGlobal === -1 ? ast.program.length : firstGlobal, 0, ...parse(`precision highp float;\nprecision highp int;\n${helpers.join('')}`, { quiet: true }).program);
    }

    return generate(ast);
}

export const alphaNames = ['portAlphaOriginalMain', 'portAlphaFunction', 'portAlphaReference', 'portAlphaValue', 'portAlphaPassed'];

/**
 * Checks every shader stage before introducing shared program uniform names.
 *
 * @param {string} source - One original translated shader unit.
 * @returns {boolean} Whether original identifiers conflict with the alpha adapter.
 */
export function hasAlphaIdentifiers(source) {
    const ast = parse(source, { quiet: true });
    let collision = false;

    visit(ast, {
        identifier: {
            /**
             * Conservatively reserves adapter names across all shader scopes.
             *
             * @param {object} context - AST visitor context.
             * @param {object} context.node - Original identifier node.
             */
            enter: ({ node }) => {
                if (alphaNames.includes(node.identifier)) {
                    collision = true;
                }
            },
        },
    });

    return collision;
}

/**
 * Tests final location-zero alpha after original main returns, including early returns.
 *
 * @param {string} source - Complete normalized fragment stage.
 * @returns {object} Preserved or instrumented source and its qualification boundary.
 */
export function instrumentAlphaTest(source) {
    if (hasAlphaIdentifiers(source)) {
        return { source, supported: false, reason: 'Alpha adapter identifier collision' };
    }

    const ast = parse(source, { stage: 'fragment', quiet: true });
    const main = ast.program.find((node) => node.type === 'function' && node.prototype.header.name.identifier === 'main');

    if (!main) {
        return { source, supported: false, reason: 'Fragment stage has no main' };
    }

    const outputs = [];

    for (const statement of ast.program) {
        const declaration = statement.declaration;

        if (declaration?.type !== 'declarator_list' || !declaration.specified_type.qualifiers?.some((qualifier) => qualifier.token === 'out')) {
            continue;
        }

        const location = declaration.specified_type.qualifiers.filter((qualifier) => qualifier.type === 'layout_qualifier')
            .flatMap((qualifier) => qualifier.qualifiers).find((qualifier) => qualifier.identifier.identifier === 'location');

        for (const variable of declaration.declarations) {
            outputs.push({
                name: variable.identifier.identifier,
                type: declaration.specified_type.specifier.specifier.token,
                array: variable.quantifier || declaration.specified_type.specifier.quantifier,
                location: location ? generate(location.expression).trim() : undefined,
            });
        }
    }

    const output = outputs.length === 1 && outputs[0].location === undefined ? outputs[0] : outputs.find((candidate) => candidate.location === '0');

    if (!output || output.type !== 'vec4' || output.array) {
        return { source, supported: false, reason: 'No unambiguous vec4 output at location zero' };
    }

    main.prototype.header.name.identifier = alphaNames[0];
    ast.program.push(...parse(`
uniform int portAlphaFunction;
uniform highp float portAlphaReference;
void main() {
    portAlphaOriginalMain();
    highp float portAlphaValue = clamp(${output.name}.a, 0.0, 1.0);
    bool portAlphaPassed = portAlphaFunction == 519
        || (portAlphaFunction == 513 && portAlphaValue < portAlphaReference)
        || (portAlphaFunction == 514 && portAlphaValue == portAlphaReference)
        || (portAlphaFunction == 515 && portAlphaValue <= portAlphaReference)
        || (portAlphaFunction == 516 && portAlphaValue > portAlphaReference)
        || (portAlphaFunction == 517 && portAlphaValue != portAlphaReference)
        || (portAlphaFunction == 518 && portAlphaValue >= portAlphaReference);
    if (!portAlphaPassed) discard;
}
`, { stage: 'fragment', quiet: true }).program);

    return { source: generate(ast), supported: true };
}
