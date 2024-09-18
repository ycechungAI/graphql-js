"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectSubfields = exports.collectFields = void 0;
const AccumulatorMap_js_1 = require("../jsutils/AccumulatorMap.js");
const invariant_js_1 = require("../jsutils/invariant.js");
const ast_js_1 = require("../language/ast.js");
const kinds_js_1 = require("../language/kinds.js");
const definition_js_1 = require("../type/definition.js");
const directives_js_1 = require("../type/directives.js");
const typeFromAST_js_1 = require("../utilities/typeFromAST.js");
const values_js_1 = require("./values.js");
/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
function collectFields(schema, fragments, variableValues, runtimeType, operation) {
    const groupedFieldSet = new AccumulatorMap_js_1.AccumulatorMap();
    const newDeferUsages = [];
    const context = {
        schema,
        fragments,
        variableValues,
        runtimeType,
        operation,
        visitedFragmentNames: new Set(),
    };
    collectFieldsImpl(context, operation.selectionSet, groupedFieldSet, newDeferUsages);
    return { groupedFieldSet, newDeferUsages };
}
exports.collectFields = collectFields;
/**
 * Given an array of field nodes, collects all of the subfields of the passed
 * in fields, and returns them at the end.
 *
 * CollectSubFields requires the "return type" of an object. For a field that
 * returns an Interface or Union type, the "return type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/max-params
function collectSubfields(schema, fragments, variableValues, operation, returnType, fieldGroup) {
    const context = {
        schema,
        fragments,
        variableValues,
        runtimeType: returnType,
        operation,
        visitedFragmentNames: new Set(),
    };
    const subGroupedFieldSet = new AccumulatorMap_js_1.AccumulatorMap();
    const newDeferUsages = [];
    for (const fieldDetail of fieldGroup) {
        const selectionSet = fieldDetail.node.selectionSet;
        if (selectionSet) {
            const { deferUsage, fragmentVariables } = fieldDetail;
            collectFieldsImpl(context, selectionSet, subGroupedFieldSet, newDeferUsages, deferUsage, fragmentVariables);
        }
    }
    return {
        groupedFieldSet: subGroupedFieldSet,
        newDeferUsages,
    };
}
exports.collectSubfields = collectSubfields;
// eslint-disable-next-line @typescript-eslint/max-params
function collectFieldsImpl(context, selectionSet, groupedFieldSet, newDeferUsages, deferUsage, fragmentVariables) {
    const { schema, fragments, variableValues, runtimeType, operation, visitedFragmentNames, } = context;
    for (const selection of selectionSet.selections) {
        switch (selection.kind) {
            case kinds_js_1.Kind.FIELD: {
                if (!shouldIncludeNode(selection, variableValues, fragmentVariables)) {
                    continue;
                }
                groupedFieldSet.add(getFieldEntryKey(selection), {
                    node: selection,
                    deferUsage,
                    fragmentVariables,
                });
                break;
            }
            case kinds_js_1.Kind.INLINE_FRAGMENT: {
                if (!shouldIncludeNode(selection, variableValues, fragmentVariables) ||
                    !doesFragmentConditionMatch(schema, selection, runtimeType)) {
                    continue;
                }
                const newDeferUsage = getDeferUsage(operation, variableValues, fragmentVariables, selection, deferUsage);
                if (!newDeferUsage) {
                    collectFieldsImpl(context, selection.selectionSet, groupedFieldSet, newDeferUsages, deferUsage, fragmentVariables);
                }
                else {
                    newDeferUsages.push(newDeferUsage);
                    collectFieldsImpl(context, selection.selectionSet, groupedFieldSet, newDeferUsages, newDeferUsage, fragmentVariables);
                }
                break;
            }
            case kinds_js_1.Kind.FRAGMENT_SPREAD: {
                const fragName = selection.name.value;
                const newDeferUsage = getDeferUsage(operation, variableValues, fragmentVariables, selection, deferUsage);
                if (!newDeferUsage &&
                    (visitedFragmentNames.has(fragName) ||
                        !shouldIncludeNode(selection, variableValues, fragmentVariables))) {
                    continue;
                }
                const fragment = fragments[fragName];
                if (fragment == null ||
                    !doesFragmentConditionMatch(schema, fragment.definition, runtimeType)) {
                    continue;
                }
                const fragmentVariableSignatures = fragment.variableSignatures;
                let newFragmentVariables;
                if (fragmentVariableSignatures) {
                    newFragmentVariables = {
                        signatures: fragmentVariableSignatures,
                        values: (0, values_js_1.experimentalGetArgumentValues)(selection, Object.values(fragmentVariableSignatures), variableValues, fragmentVariables),
                    };
                }
                if (!newDeferUsage) {
                    visitedFragmentNames.add(fragName);
                    collectFieldsImpl(context, fragment.definition.selectionSet, groupedFieldSet, newDeferUsages, deferUsage, newFragmentVariables);
                }
                else {
                    newDeferUsages.push(newDeferUsage);
                    collectFieldsImpl(context, fragment.definition.selectionSet, groupedFieldSet, newDeferUsages, newDeferUsage, newFragmentVariables);
                }
                break;
            }
        }
    }
}
/**
 * Returns an object containing the `@defer` arguments if a field should be
 * deferred based on the experimental flag, defer directive present and
 * not disabled by the "if" argument.
 */
function getDeferUsage(operation, variableValues, fragmentVariables, node, parentDeferUsage) {
    const defer = (0, values_js_1.getDirectiveValues)(directives_js_1.GraphQLDeferDirective, node, variableValues, fragmentVariables);
    if (!defer) {
        return;
    }
    if (defer.if === false) {
        return;
    }
    (operation.operation !== ast_js_1.OperationTypeNode.SUBSCRIPTION) || (0, invariant_js_1.invariant)(false, '`@defer` directive not supported on subscription operations. Disable `@defer` by setting the `if` argument to `false`.');
    return {
        label: typeof defer.label === 'string' ? defer.label : undefined,
        parentDeferUsage,
    };
}
/**
 * Determines if a field should be included based on the `@include` and `@skip`
 * directives, where `@skip` has higher precedence than `@include`.
 */
function shouldIncludeNode(node, variableValues, fragmentVariables) {
    const skip = (0, values_js_1.getDirectiveValues)(directives_js_1.GraphQLSkipDirective, node, variableValues, fragmentVariables);
    if (skip?.if === true) {
        return false;
    }
    const include = (0, values_js_1.getDirectiveValues)(directives_js_1.GraphQLIncludeDirective, node, variableValues, fragmentVariables);
    if (include?.if === false) {
        return false;
    }
    return true;
}
/**
 * Determines if a fragment is applicable to the given type.
 */
function doesFragmentConditionMatch(schema, fragment, type) {
    const typeConditionNode = fragment.typeCondition;
    if (!typeConditionNode) {
        return true;
    }
    const conditionalType = (0, typeFromAST_js_1.typeFromAST)(schema, typeConditionNode);
    if (conditionalType === type) {
        return true;
    }
    if ((0, definition_js_1.isAbstractType)(conditionalType)) {
        return schema.isSubType(conditionalType, type);
    }
    return false;
}
/**
 * Implements the logic to compute the key of a given field's entry
 */
function getFieldEntryKey(node) {
    return node.alias ? node.alias.value : node.name.value;
}
