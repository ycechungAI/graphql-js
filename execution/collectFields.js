'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.collectSubfields = exports.collectFields = void 0;
const AccumulatorMap_js_1 = require('../jsutils/AccumulatorMap.js');
const invariant_js_1 = require('../jsutils/invariant.js');
const ast_js_1 = require('../language/ast.js');
const kinds_js_1 = require('../language/kinds.js');
const definition_js_1 = require('../type/definition.js');
const directives_js_1 = require('../type/directives.js');
const typeFromAST_js_1 = require('../utilities/typeFromAST.js');
const values_js_1 = require('./values.js');
/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
function collectFields(
  schema,
  fragments,
  variableValues,
  runtimeType,
  operation,
) {
  const groupedFieldSet = new AccumulatorMap_js_1.AccumulatorMap();
  const patches = [];
  collectFieldsImpl(
    schema,
    fragments,
    variableValues,
    operation,
    runtimeType,
    operation.selectionSet,
    groupedFieldSet,
    patches,
    new Set(),
  );
  return { groupedFieldSet, patches };
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
// eslint-disable-next-line max-params
function collectSubfields(
  schema,
  fragments,
  variableValues,
  operation,
  returnType,
  fieldGroup,
) {
  const subGroupedFieldSet = new AccumulatorMap_js_1.AccumulatorMap();
  const visitedFragmentNames = new Set();
  const subPatches = [];
  const subFieldsAndPatches = {
    groupedFieldSet: subGroupedFieldSet,
    patches: subPatches,
  };
  for (const node of fieldGroup) {
    if (node.selectionSet) {
      collectFieldsImpl(
        schema,
        fragments,
        variableValues,
        operation,
        returnType,
        node.selectionSet,
        subGroupedFieldSet,
        subPatches,
        visitedFragmentNames,
      );
    }
  }
  return subFieldsAndPatches;
}
exports.collectSubfields = collectSubfields;
// eslint-disable-next-line max-params
function collectFieldsImpl(
  schema,
  fragments,
  variableValues,
  operation,
  runtimeType,
  selectionSet,
  groupedFieldSet,
  patches,
  visitedFragmentNames,
) {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case kinds_js_1.Kind.FIELD: {
        if (!shouldIncludeNode(variableValues, selection)) {
          continue;
        }
        groupedFieldSet.add(getFieldEntryKey(selection), selection);
        break;
      }
      case kinds_js_1.Kind.INLINE_FRAGMENT: {
        if (
          !shouldIncludeNode(variableValues, selection) ||
          !doesFragmentConditionMatch(schema, selection, runtimeType)
        ) {
          continue;
        }
        const defer = getDeferValues(operation, variableValues, selection);
        if (defer) {
          const patchFields = new AccumulatorMap_js_1.AccumulatorMap();
          collectFieldsImpl(
            schema,
            fragments,
            variableValues,
            operation,
            runtimeType,
            selection.selectionSet,
            patchFields,
            patches,
            visitedFragmentNames,
          );
          patches.push({
            label: defer.label,
            groupedFieldSet: patchFields,
          });
        } else {
          collectFieldsImpl(
            schema,
            fragments,
            variableValues,
            operation,
            runtimeType,
            selection.selectionSet,
            groupedFieldSet,
            patches,
            visitedFragmentNames,
          );
        }
        break;
      }
      case kinds_js_1.Kind.FRAGMENT_SPREAD: {
        const fragName = selection.name.value;
        if (!shouldIncludeNode(variableValues, selection)) {
          continue;
        }
        const defer = getDeferValues(operation, variableValues, selection);
        if (visitedFragmentNames.has(fragName) && !defer) {
          continue;
        }
        const fragment = fragments[fragName];
        if (
          fragment == null ||
          !doesFragmentConditionMatch(schema, fragment, runtimeType)
        ) {
          continue;
        }
        if (!defer) {
          visitedFragmentNames.add(fragName);
        }
        if (defer) {
          const patchFields = new AccumulatorMap_js_1.AccumulatorMap();
          collectFieldsImpl(
            schema,
            fragments,
            variableValues,
            operation,
            runtimeType,
            fragment.selectionSet,
            patchFields,
            patches,
            visitedFragmentNames,
          );
          patches.push({
            label: defer.label,
            groupedFieldSet: patchFields,
          });
        } else {
          collectFieldsImpl(
            schema,
            fragments,
            variableValues,
            operation,
            runtimeType,
            fragment.selectionSet,
            groupedFieldSet,
            patches,
            visitedFragmentNames,
          );
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
function getDeferValues(operation, variableValues, node) {
  const defer = (0, values_js_1.getDirectiveValues)(
    directives_js_1.GraphQLDeferDirective,
    node,
    variableValues,
  );
  if (!defer) {
    return;
  }
  if (defer.if === false) {
    return;
  }
  operation.operation !== ast_js_1.OperationTypeNode.SUBSCRIPTION ||
    (0, invariant_js_1.invariant)(
      false,
      '`@defer` directive not supported on subscription operations. Disable `@defer` by setting the `if` argument to `false`.',
    );
  return {
    label: typeof defer.label === 'string' ? defer.label : undefined,
  };
}
/**
 * Determines if a field should be included based on the `@include` and `@skip`
 * directives, where `@skip` has higher precedence than `@include`.
 */
function shouldIncludeNode(variableValues, node) {
  const skip = (0, values_js_1.getDirectiveValues)(
    directives_js_1.GraphQLSkipDirective,
    node,
    variableValues,
  );
  if (skip?.if === true) {
    return false;
  }
  const include = (0, values_js_1.getDirectiveValues)(
    directives_js_1.GraphQLIncludeDirective,
    node,
    variableValues,
  );
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
  const conditionalType = (0, typeFromAST_js_1.typeFromAST)(
    schema,
    typeConditionNode,
  );
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
