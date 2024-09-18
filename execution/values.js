"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDirectiveValues = exports.experimentalGetArgumentValues = exports.getArgumentValues = exports.getVariableValues = void 0;
const inspect_js_1 = require("../jsutils/inspect.js");
const printPathArray_js_1 = require("../jsutils/printPathArray.js");
const GraphQLError_js_1 = require("../error/GraphQLError.js");
const kinds_js_1 = require("../language/kinds.js");
const printer_js_1 = require("../language/printer.js");
const definition_js_1 = require("../type/definition.js");
const coerceInputValue_js_1 = require("../utilities/coerceInputValue.js");
const getVariableSignature_js_1 = require("./getVariableSignature.js");
/**
 * Prepares an object map of variableValues of the correct type based on the
 * provided variable definitions and arbitrary input. If the input cannot be
 * parsed to match the variable definitions, a GraphQLError will be thrown.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
function getVariableValues(schema, varDefNodes, inputs, options) {
    const errors = [];
    const maxErrors = options?.maxErrors;
    try {
        const coerced = coerceVariableValues(schema, varDefNodes, inputs, (error) => {
            if (maxErrors != null && errors.length >= maxErrors) {
                throw new GraphQLError_js_1.GraphQLError('Too many errors processing variables, error limit reached. Execution aborted.');
            }
            errors.push(error);
        });
        if (errors.length === 0) {
            return { coerced };
        }
    }
    catch (error) {
        errors.push(error);
    }
    return { errors };
}
exports.getVariableValues = getVariableValues;
function coerceVariableValues(schema, varDefNodes, inputs, onError) {
    const coercedValues = {};
    for (const varDefNode of varDefNodes) {
        const varSignature = (0, getVariableSignature_js_1.getVariableSignature)(schema, varDefNode);
        if (varSignature instanceof GraphQLError_js_1.GraphQLError) {
            onError(varSignature);
            continue;
        }
        const { name: varName, type: varType } = varSignature;
        if (!Object.hasOwn(inputs, varName)) {
            if (varDefNode.defaultValue) {
                coercedValues[varName] = varSignature.defaultValue;
            }
            else if ((0, definition_js_1.isNonNullType)(varType)) {
                const varTypeStr = (0, inspect_js_1.inspect)(varType);
                onError(new GraphQLError_js_1.GraphQLError(`Variable "$${varName}" of required type "${varTypeStr}" was not provided.`, { nodes: varDefNode }));
            }
            continue;
        }
        const value = inputs[varName];
        if (value === null && (0, definition_js_1.isNonNullType)(varType)) {
            const varTypeStr = (0, inspect_js_1.inspect)(varType);
            onError(new GraphQLError_js_1.GraphQLError(`Variable "$${varName}" of non-null type "${varTypeStr}" must not be null.`, { nodes: varDefNode }));
            continue;
        }
        coercedValues[varName] = (0, coerceInputValue_js_1.coerceInputValue)(value, varType, (path, invalidValue, error) => {
            let prefix = `Variable "$${varName}" got invalid value ` + (0, inspect_js_1.inspect)(invalidValue);
            if (path.length > 0) {
                prefix += ` at "${varName}${(0, printPathArray_js_1.printPathArray)(path)}"`;
            }
            onError(new GraphQLError_js_1.GraphQLError(prefix + '; ' + error.message, {
                nodes: varDefNode,
                originalError: error,
            }));
        });
    }
    return coercedValues;
}
/**
 * Prepares an object map of argument values given a list of argument
 * definitions and list of argument AST nodes.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
function getArgumentValues(def, node, variableValues) {
    return experimentalGetArgumentValues(node, def.args, variableValues);
}
exports.getArgumentValues = getArgumentValues;
function experimentalGetArgumentValues(node, argDefs, variableValues, fragmentVariables) {
    const coercedValues = {};
    // FIXME: https://github.com/graphql/graphql-js/issues/2203
    /* c8 ignore next */
    const argumentNodes = node.arguments ?? [];
    const argNodeMap = new Map(argumentNodes.map((arg) => [arg.name.value, arg]));
    for (const argDef of argDefs) {
        const name = argDef.name;
        const argType = argDef.type;
        const argumentNode = argNodeMap.get(name);
        if (argumentNode == null) {
            if (argDef.defaultValue !== undefined) {
                coercedValues[name] = argDef.defaultValue;
            }
            else if ((0, definition_js_1.isNonNullType)(argType)) {
                throw new GraphQLError_js_1.GraphQLError(`Argument "${name}" of required type "${(0, inspect_js_1.inspect)(argType)}" ` +
                    'was not provided.', { nodes: node });
            }
            continue;
        }
        const valueNode = argumentNode.value;
        let isNull = valueNode.kind === kinds_js_1.Kind.NULL;
        if (valueNode.kind === kinds_js_1.Kind.VARIABLE) {
            const variableName = valueNode.name.value;
            const scopedVariableValues = fragmentVariables?.signatures[variableName]
                ? fragmentVariables.values
                : variableValues;
            if (scopedVariableValues == null ||
                !Object.hasOwn(scopedVariableValues, variableName)) {
                if (argDef.defaultValue !== undefined) {
                    coercedValues[name] = argDef.defaultValue;
                }
                else if ((0, definition_js_1.isNonNullType)(argType)) {
                    throw new GraphQLError_js_1.GraphQLError(`Argument "${name}" of required type "${(0, inspect_js_1.inspect)(argType)}" ` +
                        `was provided the variable "$${variableName}" which was not provided a runtime value.`, { nodes: valueNode });
                }
                continue;
            }
            isNull = scopedVariableValues[variableName] == null;
        }
        if (isNull && (0, definition_js_1.isNonNullType)(argType)) {
            throw new GraphQLError_js_1.GraphQLError(`Argument "${name}" of non-null type "${(0, inspect_js_1.inspect)(argType)}" ` +
                'must not be null.', { nodes: valueNode });
        }
        const coercedValue = (0, coerceInputValue_js_1.coerceInputLiteral)(valueNode, argType, variableValues, fragmentVariables);
        if (coercedValue === undefined) {
            // Note: ValuesOfCorrectTypeRule validation should catch this before
            // execution. This is a runtime check to ensure execution does not
            // continue with an invalid argument value.
            throw new GraphQLError_js_1.GraphQLError(`Argument "${name}" of type "${(0, inspect_js_1.inspect)(argType)}" has invalid value ${(0, printer_js_1.print)(valueNode)}.`, { nodes: valueNode });
        }
        coercedValues[name] = coercedValue;
    }
    return coercedValues;
}
exports.experimentalGetArgumentValues = experimentalGetArgumentValues;
/**
 * Prepares an object map of argument values given a directive definition
 * and a AST node which may contain directives. Optionally also accepts a map
 * of variable values.
 *
 * If the directive does not exist on the node, returns undefined.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
function getDirectiveValues(directiveDef, node, variableValues, fragmentVariables) {
    const directiveNode = node.directives?.find((directive) => directive.name.value === directiveDef.name);
    if (directiveNode) {
        return experimentalGetArgumentValues(directiveNode, directiveDef.args, variableValues, fragmentVariables);
    }
}
exports.getDirectiveValues = getDirectiveValues;
