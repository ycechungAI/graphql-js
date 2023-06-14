'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.createSourceEventStream =
  exports.subscribe =
  exports.defaultFieldResolver =
  exports.defaultTypeResolver =
  exports.buildResolveInfo =
  exports.buildExecutionContext =
  exports.executeSync =
  exports.experimentalExecuteIncrementally =
  exports.execute =
    void 0;
const inspect_js_1 = require('../jsutils/inspect.js');
const invariant_js_1 = require('../jsutils/invariant.js');
const isAsyncIterable_js_1 = require('../jsutils/isAsyncIterable.js');
const isIterableObject_js_1 = require('../jsutils/isIterableObject.js');
const isObjectLike_js_1 = require('../jsutils/isObjectLike.js');
const isPromise_js_1 = require('../jsutils/isPromise.js');
const memoize3_js_1 = require('../jsutils/memoize3.js');
const Path_js_1 = require('../jsutils/Path.js');
const promiseForObject_js_1 = require('../jsutils/promiseForObject.js');
const promiseReduce_js_1 = require('../jsutils/promiseReduce.js');
const GraphQLError_js_1 = require('../error/GraphQLError.js');
const locatedError_js_1 = require('../error/locatedError.js');
const ast_js_1 = require('../language/ast.js');
const kinds_js_1 = require('../language/kinds.js');
const definition_js_1 = require('../type/definition.js');
const directives_js_1 = require('../type/directives.js');
const validate_js_1 = require('../type/validate.js');
const collectFields_js_1 = require('./collectFields.js');
const IncrementalPublisher_js_1 = require('./IncrementalPublisher.js');
const mapAsyncIterable_js_1 = require('./mapAsyncIterable.js');
const values_js_1 = require('./values.js');
/* eslint-disable max-params */
// This file contains a lot of such errors but we plan to refactor it anyway
// so just disable it for entire file.
/**
 * A memoized collection of relevant subfields with regard to the return
 * type. Memoizing ensures the subfields are not repeatedly calculated, which
 * saves overhead when resolving lists of values.
 */
const collectSubfields = (0, memoize3_js_1.memoize3)(
  (exeContext, returnType, fieldGroup) =>
    (0, collectFields_js_1.collectSubfields)(
      exeContext.schema,
      exeContext.fragments,
      exeContext.variableValues,
      exeContext.operation,
      returnType,
      fieldGroup,
    ),
);
const UNEXPECTED_EXPERIMENTAL_DIRECTIVES =
  'The provided schema unexpectedly contains experimental directives (@defer or @stream). These directives may only be utilized if experimental execution features are explicitly enabled.';
const UNEXPECTED_MULTIPLE_PAYLOADS =
  'Executing this GraphQL operation would unexpectedly produce multiple payloads (due to @defer or @stream directive)';
/**
 * Implements the "Executing requests" section of the GraphQL specification.
 *
 * Returns either a synchronous ExecutionResult (if all encountered resolvers
 * are synchronous), or a Promise of an ExecutionResult that will eventually be
 * resolved and never rejected.
 *
 * If the arguments to this function do not result in a legal execution context,
 * a GraphQLError will be thrown immediately explaining the invalid input.
 *
 * This function does not support incremental delivery (`@defer` and `@stream`).
 * If an operation which would defer or stream data is executed with this
 * function, it will throw or return a rejected promise.
 * Use `experimentalExecuteIncrementally` if you want to support incremental
 * delivery.
 */
function execute(args) {
  if (args.schema.getDirective('defer') || args.schema.getDirective('stream')) {
    throw new Error(UNEXPECTED_EXPERIMENTAL_DIRECTIVES);
  }
  const result = experimentalExecuteIncrementally(args);
  if (!(0, isPromise_js_1.isPromise)(result)) {
    if ('initialResult' in result) {
      // This can happen if the operation contains @defer or @stream directives
      // and is not validated prior to execution
      throw new Error(UNEXPECTED_MULTIPLE_PAYLOADS);
    }
    return result;
  }
  return result.then((incrementalResult) => {
    if ('initialResult' in incrementalResult) {
      // This can happen if the operation contains @defer or @stream directives
      // and is not validated prior to execution
      throw new Error(UNEXPECTED_MULTIPLE_PAYLOADS);
    }
    return incrementalResult;
  });
}
exports.execute = execute;
/**
 * Implements the "Executing requests" section of the GraphQL specification,
 * including `@defer` and `@stream` as proposed in
 * https://github.com/graphql/graphql-spec/pull/742
 *
 * This function returns a Promise of an ExperimentalIncrementalExecutionResults
 * object. This object either consists of a single ExecutionResult, or an
 * object containing an `initialResult` and a stream of `subsequentResults`.
 *
 * If the arguments to this function do not result in a legal execution context,
 * a GraphQLError will be thrown immediately explaining the invalid input.
 */
function experimentalExecuteIncrementally(args) {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const exeContext = buildExecutionContext(args);
  // Return early errors if execution context failed.
  if (!('schema' in exeContext)) {
    return { errors: exeContext };
  }
  return executeImpl(exeContext);
}
exports.experimentalExecuteIncrementally = experimentalExecuteIncrementally;
function executeImpl(exeContext) {
  // Return a Promise that will eventually resolve to the data described by
  // The "Response" section of the GraphQL specification.
  //
  // If errors are encountered while executing a GraphQL field, only that
  // field and its descendants will be omitted, and sibling fields will still
  // be executed. An execution which encounters errors will still result in a
  // resolved Promise.
  //
  // Errors from sub-fields of a NonNull type may propagate to the top level,
  // at which point we still log the error and null the parent field, which
  // in this case is the entire response.
  try {
    const result = executeOperation(exeContext);
    if ((0, isPromise_js_1.isPromise)(result)) {
      return result.then(
        (data) => {
          const initialResult = buildResponse(data, exeContext.errors);
          if (exeContext.subsequentPayloads.size > 0) {
            return {
              initialResult: {
                ...initialResult,
                hasNext: true,
              },
              subsequentResults: (0,
              IncrementalPublisher_js_1.yieldSubsequentPayloads)(
                exeContext.subsequentPayloads,
              ),
            };
          }
          return initialResult;
        },
        (error) => {
          exeContext.errors.push(error);
          return buildResponse(null, exeContext.errors);
        },
      );
    }
    const initialResult = buildResponse(result, exeContext.errors);
    if (exeContext.subsequentPayloads.size > 0) {
      return {
        initialResult: {
          ...initialResult,
          hasNext: true,
        },
        subsequentResults: (0,
        IncrementalPublisher_js_1.yieldSubsequentPayloads)(
          exeContext.subsequentPayloads,
        ),
      };
    }
    return initialResult;
  } catch (error) {
    exeContext.errors.push(error);
    return buildResponse(null, exeContext.errors);
  }
}
/**
 * Also implements the "Executing requests" section of the GraphQL specification.
 * However, it guarantees to complete synchronously (or throw an error) assuming
 * that all field resolvers are also synchronous.
 */
function executeSync(args) {
  const result = experimentalExecuteIncrementally(args);
  // Assert that the execution was synchronous.
  if ((0, isPromise_js_1.isPromise)(result) || 'initialResult' in result) {
    throw new Error('GraphQL execution failed to complete synchronously.');
  }
  return result;
}
exports.executeSync = executeSync;
/**
 * Given a completed execution context and data, build the `{ errors, data }`
 * response defined by the "Response" section of the GraphQL specification.
 */
function buildResponse(data, errors) {
  return errors.length === 0 ? { data } : { errors, data };
}
/**
 * Constructs a ExecutionContext object from the arguments passed to
 * execute, which we will pass throughout the other execution methods.
 *
 * Throws a GraphQLError if a valid execution context cannot be created.
 *
 * TODO: consider no longer exporting this function
 * @internal
 */
function buildExecutionContext(args) {
  const {
    schema,
    document,
    rootValue,
    contextValue,
    variableValues: rawVariableValues,
    operationName,
    fieldResolver,
    typeResolver,
    subscribeFieldResolver,
  } = args;
  // If the schema used for execution is invalid, throw an error.
  (0, validate_js_1.assertValidSchema)(schema);
  let operation;
  const fragments = Object.create(null);
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case kinds_js_1.Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return [
              new GraphQLError_js_1.GraphQLError(
                'Must provide operation name if query contains multiple operations.',
              ),
            ];
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case kinds_js_1.Kind.FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition;
        break;
      default:
      // ignore non-executable definitions
    }
  }
  if (!operation) {
    if (operationName != null) {
      return [
        new GraphQLError_js_1.GraphQLError(
          `Unknown operation named "${operationName}".`,
        ),
      ];
    }
    return [new GraphQLError_js_1.GraphQLError('Must provide an operation.')];
  }
  // FIXME: https://github.com/graphql/graphql-js/issues/2203
  /* c8 ignore next */
  const variableDefinitions = operation.variableDefinitions ?? [];
  const coercedVariableValues = (0, values_js_1.getVariableValues)(
    schema,
    variableDefinitions,
    rawVariableValues ?? {},
    { maxErrors: 50 },
  );
  if (coercedVariableValues.errors) {
    return coercedVariableValues.errors;
  }
  return {
    schema,
    fragments,
    rootValue,
    contextValue,
    operation,
    variableValues: coercedVariableValues.coerced,
    fieldResolver: fieldResolver ?? exports.defaultFieldResolver,
    typeResolver: typeResolver ?? exports.defaultTypeResolver,
    subscribeFieldResolver:
      subscribeFieldResolver ?? exports.defaultFieldResolver,
    subsequentPayloads: new Set(),
    errors: [],
  };
}
exports.buildExecutionContext = buildExecutionContext;
function buildPerEventExecutionContext(exeContext, payload) {
  return {
    ...exeContext,
    rootValue: payload,
    subsequentPayloads: new Set(),
    errors: [],
  };
}
/**
 * Implements the "Executing operations" section of the spec.
 */
function executeOperation(exeContext) {
  const { operation, schema, fragments, variableValues, rootValue } =
    exeContext;
  const rootType = schema.getRootType(operation.operation);
  if (rootType == null) {
    throw new GraphQLError_js_1.GraphQLError(
      `Schema is not configured to execute ${operation.operation} operation.`,
      { nodes: operation },
    );
  }
  const { groupedFieldSet, patches } = (0, collectFields_js_1.collectFields)(
    schema,
    fragments,
    variableValues,
    rootType,
    operation,
  );
  const path = undefined;
  let result;
  switch (operation.operation) {
    case ast_js_1.OperationTypeNode.QUERY:
      result = executeFields(
        exeContext,
        rootType,
        rootValue,
        path,
        groupedFieldSet,
      );
      break;
    case ast_js_1.OperationTypeNode.MUTATION:
      result = executeFieldsSerially(
        exeContext,
        rootType,
        rootValue,
        path,
        groupedFieldSet,
      );
      break;
    case ast_js_1.OperationTypeNode.SUBSCRIPTION:
      // TODO: deprecate `subscribe` and move all logic here
      // Temporary solution until we finish merging execute and subscribe together
      result = executeFields(
        exeContext,
        rootType,
        rootValue,
        path,
        groupedFieldSet,
      );
  }
  for (const patch of patches) {
    const { label, groupedFieldSet: patchGroupedFieldSet } = patch;
    executeDeferredFragment(
      exeContext,
      rootType,
      rootValue,
      patchGroupedFieldSet,
      label,
      path,
    );
  }
  return result;
}
/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that must be executed serially.
 */
function executeFieldsSerially(
  exeContext,
  parentType,
  sourceValue,
  path,
  groupedFieldSet,
) {
  return (0, promiseReduce_js_1.promiseReduce)(
    groupedFieldSet,
    (results, [responseName, fieldGroup]) => {
      const fieldPath = (0, Path_js_1.addPath)(
        path,
        responseName,
        parentType.name,
      );
      const result = executeField(
        exeContext,
        parentType,
        sourceValue,
        fieldGroup,
        fieldPath,
      );
      if (result === undefined) {
        return results;
      }
      if ((0, isPromise_js_1.isPromise)(result)) {
        return result.then((resolvedResult) => {
          results[responseName] = resolvedResult;
          return results;
        });
      }
      results[responseName] = result;
      return results;
    },
    Object.create(null),
  );
}
/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that may be executed in parallel.
 */
function executeFields(
  exeContext,
  parentType,
  sourceValue,
  path,
  groupedFieldSet,
  incrementalDataRecord,
) {
  const results = Object.create(null);
  let containsPromise = false;
  try {
    for (const [responseName, fieldGroup] of groupedFieldSet) {
      const fieldPath = (0, Path_js_1.addPath)(
        path,
        responseName,
        parentType.name,
      );
      const result = executeField(
        exeContext,
        parentType,
        sourceValue,
        fieldGroup,
        fieldPath,
        incrementalDataRecord,
      );
      if (result !== undefined) {
        results[responseName] = result;
        if ((0, isPromise_js_1.isPromise)(result)) {
          containsPromise = true;
        }
      }
    }
  } catch (error) {
    if (containsPromise) {
      // Ensure that any promises returned by other fields are handled, as they may also reject.
      return (0, promiseForObject_js_1.promiseForObject)(results).finally(
        () => {
          throw error;
        },
      );
    }
    throw error;
  }
  // If there are no promises, we can just return the object
  if (!containsPromise) {
    return results;
  }
  // Otherwise, results is a map from field name to the result of resolving that
  // field, which is possibly a promise. Return a promise that will return this
  // same map, but with any promises replaced with the values they resolved to.
  return (0, promiseForObject_js_1.promiseForObject)(results);
}
/**
 * Implements the "Executing fields" section of the spec
 * In particular, this function figures out the value that the field returns by
 * calling its resolve function, then calls completeValue to complete promises,
 * serialize scalars, or execute the sub-selection-set for objects.
 */
function executeField(
  exeContext,
  parentType,
  source,
  fieldGroup,
  path,
  incrementalDataRecord,
) {
  const fieldName = fieldGroup[0].name.value;
  const fieldDef = exeContext.schema.getField(parentType, fieldName);
  if (!fieldDef) {
    return;
  }
  const returnType = fieldDef.type;
  const resolveFn = fieldDef.resolve ?? exeContext.fieldResolver;
  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldGroup,
    parentType,
    path,
  );
  // Get the resolve function, regardless of if its result is normal or abrupt (error).
  try {
    // Build a JS object of arguments from the field.arguments AST, using the
    // variables scope to fulfill any variable references.
    // TODO: find a way to memoize, in case this field is within a List type.
    const args = (0, values_js_1.getArgumentValues)(
      fieldDef,
      fieldGroup[0],
      exeContext.variableValues,
    );
    // The resolve function's optional third argument is a context value that
    // is provided to every resolve function within an execution. It is commonly
    // used to represent an authenticated user, or request-specific caches.
    const contextValue = exeContext.contextValue;
    const result = resolveFn(source, args, contextValue, info);
    if ((0, isPromise_js_1.isPromise)(result)) {
      return completePromisedValue(
        exeContext,
        returnType,
        fieldGroup,
        info,
        path,
        result,
        incrementalDataRecord,
      );
    }
    const completed = completeValue(
      exeContext,
      returnType,
      fieldGroup,
      info,
      path,
      result,
      incrementalDataRecord,
    );
    if ((0, isPromise_js_1.isPromise)(completed)) {
      // Note: we don't rely on a `catch` method, but we do expect "thenable"
      // to take a second callback for the error case.
      return completed.then(undefined, (rawError) => {
        handleFieldError(
          rawError,
          exeContext,
          returnType,
          fieldGroup,
          path,
          incrementalDataRecord,
        );
        (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
          exeContext.subsequentPayloads,
          path,
          incrementalDataRecord,
        );
        return null;
      });
    }
    return completed;
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      returnType,
      fieldGroup,
      path,
      incrementalDataRecord,
    );
    (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
      exeContext.subsequentPayloads,
      path,
      incrementalDataRecord,
    );
    return null;
  }
}
/**
 * TODO: consider no longer exporting this function
 * @internal
 */
function buildResolveInfo(exeContext, fieldDef, fieldGroup, parentType, path) {
  // The resolve function's optional fourth argument is a collection of
  // information about the current execution state.
  return {
    fieldName: fieldDef.name,
    fieldNodes: fieldGroup,
    returnType: fieldDef.type,
    parentType,
    path,
    schema: exeContext.schema,
    fragments: exeContext.fragments,
    rootValue: exeContext.rootValue,
    operation: exeContext.operation,
    variableValues: exeContext.variableValues,
  };
}
exports.buildResolveInfo = buildResolveInfo;
function handleFieldError(
  rawError,
  exeContext,
  returnType,
  fieldGroup,
  path,
  incrementalDataRecord,
) {
  const error = (0, locatedError_js_1.locatedError)(
    rawError,
    fieldGroup,
    (0, Path_js_1.pathToArray)(path),
  );
  // If the field type is non-nullable, then it is resolved without any
  // protection from errors, however it still properly locates the error.
  if ((0, definition_js_1.isNonNullType)(returnType)) {
    throw error;
  }
  const errors = incrementalDataRecord?.errors ?? exeContext.errors;
  // Otherwise, error protection is applied, logging the error and resolving
  // a null value for this field if one is encountered.
  errors.push(error);
}
/**
 * Implements the instructions for completeValue as defined in the
 * "Value Completion" section of the spec.
 *
 * If the field type is Non-Null, then this recursively completes the value
 * for the inner type. It throws a field error if that completion returns null,
 * as per the "Nullability" section of the spec.
 *
 * If the field type is a List, then this recursively completes the value
 * for the inner type on each item in the list.
 *
 * If the field type is a Scalar or Enum, ensures the completed value is a legal
 * value of the type by calling the `serialize` method of GraphQL type
 * definition.
 *
 * If the field is an abstract type, determine the runtime type of the value
 * and then complete based on that type
 *
 * Otherwise, the field type expects a sub-selection set, and will complete the
 * value by executing all sub-selections.
 */
function completeValue(
  exeContext,
  returnType,
  fieldGroup,
  info,
  path,
  result,
  incrementalDataRecord,
) {
  // If result is an Error, throw a located error.
  if (result instanceof Error) {
    throw result;
  }
  // If field type is NonNull, complete for inner type, and throw field error
  // if result is null.
  if ((0, definition_js_1.isNonNullType)(returnType)) {
    const completed = completeValue(
      exeContext,
      returnType.ofType,
      fieldGroup,
      info,
      path,
      result,
      incrementalDataRecord,
    );
    if (completed === null) {
      throw new Error(
        `Cannot return null for non-nullable field ${info.parentType.name}.${info.fieldName}.`,
      );
    }
    return completed;
  }
  // If result value is null or undefined then return null.
  if (result == null) {
    return null;
  }
  // If field type is List, complete each item in the list with the inner type
  if ((0, definition_js_1.isListType)(returnType)) {
    return completeListValue(
      exeContext,
      returnType,
      fieldGroup,
      info,
      path,
      result,
      incrementalDataRecord,
    );
  }
  // If field type is a leaf type, Scalar or Enum, serialize to a valid value,
  // returning null if serialization is not possible.
  if ((0, definition_js_1.isLeafType)(returnType)) {
    return completeLeafValue(returnType, result);
  }
  // If field type is an abstract type, Interface or Union, determine the
  // runtime Object type and complete for that type.
  if ((0, definition_js_1.isAbstractType)(returnType)) {
    return completeAbstractValue(
      exeContext,
      returnType,
      fieldGroup,
      info,
      path,
      result,
      incrementalDataRecord,
    );
  }
  // If field type is Object, execute and complete all sub-selections.
  if ((0, definition_js_1.isObjectType)(returnType)) {
    return completeObjectValue(
      exeContext,
      returnType,
      fieldGroup,
      info,
      path,
      result,
      incrementalDataRecord,
    );
  }
  /* c8 ignore next 6 */
  // Not reachable, all possible output types have been considered.
  false ||
    (0, invariant_js_1.invariant)(
      false,
      'Cannot complete value of unexpected output type: ' +
        (0, inspect_js_1.inspect)(returnType),
    );
}
async function completePromisedValue(
  exeContext,
  returnType,
  fieldGroup,
  info,
  path,
  result,
  incrementalDataRecord,
) {
  try {
    const resolved = await result;
    let completed = completeValue(
      exeContext,
      returnType,
      fieldGroup,
      info,
      path,
      resolved,
      incrementalDataRecord,
    );
    if ((0, isPromise_js_1.isPromise)(completed)) {
      completed = await completed;
    }
    return completed;
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      returnType,
      fieldGroup,
      path,
      incrementalDataRecord,
    );
    (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
      exeContext.subsequentPayloads,
      path,
      incrementalDataRecord,
    );
    return null;
  }
}
/**
 * Returns an object containing the `@stream` arguments if a field should be
 * streamed based on the experimental flag, stream directive present and
 * not disabled by the "if" argument.
 */
function getStreamValues(exeContext, fieldGroup, path) {
  // do not stream inner lists of multi-dimensional lists
  if (typeof path.key === 'number') {
    return;
  }
  // validation only allows equivalent streams on multiple fields, so it is
  // safe to only check the first fieldNode for the stream directive
  const stream = (0, values_js_1.getDirectiveValues)(
    directives_js_1.GraphQLStreamDirective,
    fieldGroup[0],
    exeContext.variableValues,
  );
  if (!stream) {
    return;
  }
  if (stream.if === false) {
    return;
  }
  typeof stream.initialCount === 'number' ||
    (0, invariant_js_1.invariant)(false, 'initialCount must be a number');
  stream.initialCount >= 0 ||
    (0, invariant_js_1.invariant)(
      false,
      'initialCount must be a positive integer',
    );
  exeContext.operation.operation !== ast_js_1.OperationTypeNode.SUBSCRIPTION ||
    (0, invariant_js_1.invariant)(
      false,
      '`@stream` directive not supported on subscription operations. Disable `@stream` by setting the `if` argument to `false`.',
    );
  return {
    initialCount: stream.initialCount,
    label: typeof stream.label === 'string' ? stream.label : undefined,
  };
}
/**
 * Complete a async iterator value by completing the result and calling
 * recursively until all the results are completed.
 */
async function completeAsyncIteratorValue(
  exeContext,
  itemType,
  fieldGroup,
  info,
  path,
  asyncIterator,
  incrementalDataRecord,
) {
  const stream = getStreamValues(exeContext, fieldGroup, path);
  let containsPromise = false;
  const completedResults = [];
  let index = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (
      stream &&
      typeof stream.initialCount === 'number' &&
      index >= stream.initialCount
    ) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      executeStreamAsyncIterator(
        index,
        asyncIterator,
        exeContext,
        fieldGroup,
        info,
        itemType,
        path,
        stream.label,
        incrementalDataRecord,
      );
      break;
    }
    const itemPath = (0, Path_js_1.addPath)(path, index, undefined);
    let iteration;
    try {
      // eslint-disable-next-line no-await-in-loop
      iteration = await asyncIterator.next();
      if (iteration.done) {
        break;
      }
    } catch (rawError) {
      throw (0, locatedError_js_1.locatedError)(
        rawError,
        fieldGroup,
        (0, Path_js_1.pathToArray)(path),
      );
    }
    if (
      completeListItemValue(
        iteration.value,
        completedResults,
        exeContext,
        itemType,
        fieldGroup,
        info,
        itemPath,
        incrementalDataRecord,
      )
    ) {
      containsPromise = true;
    }
    index += 1;
  }
  return containsPromise ? Promise.all(completedResults) : completedResults;
}
/**
 * Complete a list value by completing each item in the list with the
 * inner type
 */
function completeListValue(
  exeContext,
  returnType,
  fieldGroup,
  info,
  path,
  result,
  incrementalDataRecord,
) {
  const itemType = returnType.ofType;
  if ((0, isAsyncIterable_js_1.isAsyncIterable)(result)) {
    const asyncIterator = result[Symbol.asyncIterator]();
    return completeAsyncIteratorValue(
      exeContext,
      itemType,
      fieldGroup,
      info,
      path,
      asyncIterator,
      incrementalDataRecord,
    );
  }
  if (!(0, isIterableObject_js_1.isIterableObject)(result)) {
    throw new GraphQLError_js_1.GraphQLError(
      `Expected Iterable, but did not find one for field "${info.parentType.name}.${info.fieldName}".`,
    );
  }
  const stream = getStreamValues(exeContext, fieldGroup, path);
  // This is specified as a simple map, however we're optimizing the path
  // where the list contains no Promises by avoiding creating another Promise.
  let containsPromise = false;
  let previousIncrementalDataRecord = incrementalDataRecord;
  const completedResults = [];
  let index = 0;
  for (const item of result) {
    // No need to modify the info object containing the path,
    // since from here on it is not ever accessed by resolver functions.
    const itemPath = (0, Path_js_1.addPath)(path, index, undefined);
    if (
      stream &&
      typeof stream.initialCount === 'number' &&
      index >= stream.initialCount
    ) {
      previousIncrementalDataRecord = executeStreamField(
        path,
        itemPath,
        item,
        exeContext,
        fieldGroup,
        info,
        itemType,
        stream.label,
        previousIncrementalDataRecord,
      );
      index++;
      continue;
    }
    if (
      completeListItemValue(
        item,
        completedResults,
        exeContext,
        itemType,
        fieldGroup,
        info,
        itemPath,
        incrementalDataRecord,
      )
    ) {
      containsPromise = true;
    }
    index++;
  }
  return containsPromise ? Promise.all(completedResults) : completedResults;
}
/**
 * Complete a list item value by adding it to the completed results.
 *
 * Returns true if the value is a Promise.
 */
function completeListItemValue(
  item,
  completedResults,
  exeContext,
  itemType,
  fieldGroup,
  info,
  itemPath,
  incrementalDataRecord,
) {
  if ((0, isPromise_js_1.isPromise)(item)) {
    completedResults.push(
      completePromisedValue(
        exeContext,
        itemType,
        fieldGroup,
        info,
        itemPath,
        item,
        incrementalDataRecord,
      ),
    );
    return true;
  }
  try {
    const completedItem = completeValue(
      exeContext,
      itemType,
      fieldGroup,
      info,
      itemPath,
      item,
      incrementalDataRecord,
    );
    if ((0, isPromise_js_1.isPromise)(completedItem)) {
      // Note: we don't rely on a `catch` method, but we do expect "thenable"
      // to take a second callback for the error case.
      completedResults.push(
        completedItem.then(undefined, (rawError) => {
          handleFieldError(
            rawError,
            exeContext,
            itemType,
            fieldGroup,
            itemPath,
            incrementalDataRecord,
          );
          (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
            exeContext.subsequentPayloads,
            itemPath,
            incrementalDataRecord,
          );
          return null;
        }),
      );
      return true;
    }
    completedResults.push(completedItem);
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      itemType,
      fieldGroup,
      itemPath,
      incrementalDataRecord,
    );
    (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
      exeContext.subsequentPayloads,
      itemPath,
      incrementalDataRecord,
    );
    completedResults.push(null);
  }
  return false;
}
/**
 * Complete a Scalar or Enum by serializing to a valid value, returning
 * null if serialization is not possible.
 */
function completeLeafValue(returnType, result) {
  const serializedResult = returnType.serialize(result);
  if (serializedResult == null) {
    throw new Error(
      `Expected \`${(0, inspect_js_1.inspect)(returnType)}.serialize(${(0,
      inspect_js_1.inspect)(result)})\` to ` +
        `return non-nullable value, returned: ${(0, inspect_js_1.inspect)(
          serializedResult,
        )}`,
    );
  }
  return serializedResult;
}
/**
 * Complete a value of an abstract type by determining the runtime object type
 * of that value, then complete the value for that type.
 */
function completeAbstractValue(
  exeContext,
  returnType,
  fieldGroup,
  info,
  path,
  result,
  incrementalDataRecord,
) {
  const resolveTypeFn = returnType.resolveType ?? exeContext.typeResolver;
  const contextValue = exeContext.contextValue;
  const runtimeType = resolveTypeFn(result, contextValue, info, returnType);
  if ((0, isPromise_js_1.isPromise)(runtimeType)) {
    return runtimeType.then((resolvedRuntimeType) =>
      completeObjectValue(
        exeContext,
        ensureValidRuntimeType(
          resolvedRuntimeType,
          exeContext,
          returnType,
          fieldGroup,
          info,
          result,
        ),
        fieldGroup,
        info,
        path,
        result,
        incrementalDataRecord,
      ),
    );
  }
  return completeObjectValue(
    exeContext,
    ensureValidRuntimeType(
      runtimeType,
      exeContext,
      returnType,
      fieldGroup,
      info,
      result,
    ),
    fieldGroup,
    info,
    path,
    result,
    incrementalDataRecord,
  );
}
function ensureValidRuntimeType(
  runtimeTypeName,
  exeContext,
  returnType,
  fieldGroup,
  info,
  result,
) {
  if (runtimeTypeName == null) {
    throw new GraphQLError_js_1.GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}". Either the "${returnType.name}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`,
      { nodes: fieldGroup },
    );
  }
  // releases before 16.0.0 supported returning `GraphQLObjectType` from `resolveType`
  // TODO: remove in 17.0.0 release
  if ((0, definition_js_1.isObjectType)(runtimeTypeName)) {
    throw new GraphQLError_js_1.GraphQLError(
      'Support for returning GraphQLObjectType from resolveType was removed in graphql-js@16.0.0 please return type name instead.',
    );
  }
  if (typeof runtimeTypeName !== 'string') {
    throw new GraphQLError_js_1.GraphQLError(
      `Abstract type "${returnType.name}" must resolve to an Object type at runtime for field "${info.parentType.name}.${info.fieldName}" with ` +
        `value ${(0, inspect_js_1.inspect)(result)}, received "${(0,
        inspect_js_1.inspect)(runtimeTypeName)}".`,
    );
  }
  const runtimeType = exeContext.schema.getType(runtimeTypeName);
  if (runtimeType == null) {
    throw new GraphQLError_js_1.GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`,
      { nodes: fieldGroup },
    );
  }
  if (!(0, definition_js_1.isObjectType)(runtimeType)) {
    throw new GraphQLError_js_1.GraphQLError(
      `Abstract type "${returnType.name}" was resolved to a non-object type "${runtimeTypeName}".`,
      { nodes: fieldGroup },
    );
  }
  if (!exeContext.schema.isSubType(returnType, runtimeType)) {
    throw new GraphQLError_js_1.GraphQLError(
      `Runtime Object type "${runtimeType.name}" is not a possible type for "${returnType.name}".`,
      { nodes: fieldGroup },
    );
  }
  return runtimeType;
}
/**
 * Complete an Object value by executing all sub-selections.
 */
function completeObjectValue(
  exeContext,
  returnType,
  fieldGroup,
  info,
  path,
  result,
  incrementalDataRecord,
) {
  // If there is an isTypeOf predicate function, call it with the
  // current result. If isTypeOf returns false, then raise an error rather
  // than continuing execution.
  if (returnType.isTypeOf) {
    const isTypeOf = returnType.isTypeOf(result, exeContext.contextValue, info);
    if ((0, isPromise_js_1.isPromise)(isTypeOf)) {
      return isTypeOf.then((resolvedIsTypeOf) => {
        if (!resolvedIsTypeOf) {
          throw invalidReturnTypeError(returnType, result, fieldGroup);
        }
        return collectAndExecuteSubfields(
          exeContext,
          returnType,
          fieldGroup,
          path,
          result,
          incrementalDataRecord,
        );
      });
    }
    if (!isTypeOf) {
      throw invalidReturnTypeError(returnType, result, fieldGroup);
    }
  }
  return collectAndExecuteSubfields(
    exeContext,
    returnType,
    fieldGroup,
    path,
    result,
    incrementalDataRecord,
  );
}
function invalidReturnTypeError(returnType, result, fieldGroup) {
  return new GraphQLError_js_1.GraphQLError(
    `Expected value of type "${returnType.name}" but got: ${(0,
    inspect_js_1.inspect)(result)}.`,
    { nodes: fieldGroup },
  );
}
function collectAndExecuteSubfields(
  exeContext,
  returnType,
  fieldGroup,
  path,
  result,
  incrementalDataRecord,
) {
  // Collect sub-fields to execute to complete this value.
  const { groupedFieldSet: subGroupedFieldSet, patches: subPatches } =
    collectSubfields(exeContext, returnType, fieldGroup);
  const subFields = executeFields(
    exeContext,
    returnType,
    result,
    path,
    subGroupedFieldSet,
    incrementalDataRecord,
  );
  for (const subPatch of subPatches) {
    const { label, groupedFieldSet: subPatchGroupedFieldSet } = subPatch;
    executeDeferredFragment(
      exeContext,
      returnType,
      result,
      subPatchGroupedFieldSet,
      label,
      path,
      incrementalDataRecord,
    );
  }
  return subFields;
}
/**
 * If a resolveType function is not given, then a default resolve behavior is
 * used which attempts two strategies:
 *
 * First, See if the provided value has a `__typename` field defined, if so, use
 * that value as name of the resolved type.
 *
 * Otherwise, test each possible type for the abstract type by calling
 * isTypeOf for the object being coerced, returning the first type that matches.
 */
const defaultTypeResolver = function (value, contextValue, info, abstractType) {
  // First, look for `__typename`.
  if (
    (0, isObjectLike_js_1.isObjectLike)(value) &&
    typeof value.__typename === 'string'
  ) {
    return value.__typename;
  }
  // Otherwise, test each possible type.
  const possibleTypes = info.schema.getPossibleTypes(abstractType);
  const promisedIsTypeOfResults = [];
  for (let i = 0; i < possibleTypes.length; i++) {
    const type = possibleTypes[i];
    if (type.isTypeOf) {
      const isTypeOfResult = type.isTypeOf(value, contextValue, info);
      if ((0, isPromise_js_1.isPromise)(isTypeOfResult)) {
        promisedIsTypeOfResults[i] = isTypeOfResult;
      } else if (isTypeOfResult) {
        return type.name;
      }
    }
  }
  if (promisedIsTypeOfResults.length) {
    return Promise.all(promisedIsTypeOfResults).then((isTypeOfResults) => {
      for (let i = 0; i < isTypeOfResults.length; i++) {
        if (isTypeOfResults[i]) {
          return possibleTypes[i].name;
        }
      }
    });
  }
};
exports.defaultTypeResolver = defaultTypeResolver;
/**
 * If a resolve function is not given, then a default resolve behavior is used
 * which takes the property of the source object of the same name as the field
 * and returns it as the result, or if it's a function, returns the result
 * of calling that function while passing along args and context value.
 */
const defaultFieldResolver = function (source, args, contextValue, info) {
  // ensure source is a value for which property access is acceptable.
  if (
    (0, isObjectLike_js_1.isObjectLike)(source) ||
    typeof source === 'function'
  ) {
    const property = source[info.fieldName];
    if (typeof property === 'function') {
      return source[info.fieldName](args, contextValue, info);
    }
    return property;
  }
};
exports.defaultFieldResolver = defaultFieldResolver;
/**
 * Implements the "Subscribe" algorithm described in the GraphQL specification.
 *
 * Returns a Promise which resolves to either an AsyncIterator (if successful)
 * or an ExecutionResult (error). The promise will be rejected if the schema or
 * other arguments to this function are invalid, or if the resolved event stream
 * is not an async iterable.
 *
 * If the client-provided arguments to this function do not result in a
 * compliant subscription, a GraphQL Response (ExecutionResult) with descriptive
 * errors and no data will be returned.
 *
 * If the source stream could not be created due to faulty subscription resolver
 * logic or underlying systems, the promise will resolve to a single
 * ExecutionResult containing `errors` and no `data`.
 *
 * If the operation succeeded, the promise resolves to an AsyncIterator, which
 * yields a stream of ExecutionResults representing the response stream.
 *
 * This function does not support incremental delivery (`@defer` and `@stream`).
 * If an operation which would defer or stream data is executed with this
 * function, a field error will be raised at the location of the `@defer` or
 * `@stream` directive.
 *
 * Accepts an object with named arguments.
 */
function subscribe(args) {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const exeContext = buildExecutionContext(args);
  // Return early errors if execution context failed.
  if (!('schema' in exeContext)) {
    return { errors: exeContext };
  }
  const resultOrStream = createSourceEventStreamImpl(exeContext);
  if ((0, isPromise_js_1.isPromise)(resultOrStream)) {
    return resultOrStream.then((resolvedResultOrStream) =>
      mapSourceToResponse(exeContext, resolvedResultOrStream),
    );
  }
  return mapSourceToResponse(exeContext, resultOrStream);
}
exports.subscribe = subscribe;
function mapSourceToResponse(exeContext, resultOrStream) {
  if (!(0, isAsyncIterable_js_1.isAsyncIterable)(resultOrStream)) {
    return resultOrStream;
  }
  // For each payload yielded from a subscription, map it over the normal
  // GraphQL `execute` function, with `payload` as the rootValue.
  // This implements the "MapSourceToResponseEvent" algorithm described in
  // the GraphQL specification. The `execute` function provides the
  // "ExecuteSubscriptionEvent" algorithm, as it is nearly identical to the
  // "ExecuteQuery" algorithm, for which `execute` is also used.
  return (0, mapAsyncIterable_js_1.mapAsyncIterable)(
    resultOrStream,
    (payload) =>
      executeImpl(buildPerEventExecutionContext(exeContext, payload)),
  );
}
/**
 * Implements the "CreateSourceEventStream" algorithm described in the
 * GraphQL specification, resolving the subscription source event stream.
 *
 * Returns a Promise which resolves to either an AsyncIterable (if successful)
 * or an ExecutionResult (error). The promise will be rejected if the schema or
 * other arguments to this function are invalid, or if the resolved event stream
 * is not an async iterable.
 *
 * If the client-provided arguments to this function do not result in a
 * compliant subscription, a GraphQL Response (ExecutionResult) with
 * descriptive errors and no data will be returned.
 *
 * If the the source stream could not be created due to faulty subscription
 * resolver logic or underlying systems, the promise will resolve to a single
 * ExecutionResult containing `errors` and no `data`.
 *
 * If the operation succeeded, the promise resolves to the AsyncIterable for the
 * event stream returned by the resolver.
 *
 * A Source Event Stream represents a sequence of events, each of which triggers
 * a GraphQL execution for that event.
 *
 * This may be useful when hosting the stateful subscription service in a
 * different process or machine than the stateless GraphQL execution engine,
 * or otherwise separating these two steps. For more on this, see the
 * "Supporting Subscriptions at Scale" information in the GraphQL specification.
 */
function createSourceEventStream(args) {
  // If a valid execution context cannot be created due to incorrect arguments,
  // a "Response" with only errors is returned.
  const exeContext = buildExecutionContext(args);
  // Return early errors if execution context failed.
  if (!('schema' in exeContext)) {
    return { errors: exeContext };
  }
  return createSourceEventStreamImpl(exeContext);
}
exports.createSourceEventStream = createSourceEventStream;
function createSourceEventStreamImpl(exeContext) {
  try {
    const eventStream = executeSubscription(exeContext);
    if ((0, isPromise_js_1.isPromise)(eventStream)) {
      return eventStream.then(undefined, (error) => ({ errors: [error] }));
    }
    return eventStream;
  } catch (error) {
    return { errors: [error] };
  }
}
function executeSubscription(exeContext) {
  const { schema, fragments, operation, variableValues, rootValue } =
    exeContext;
  const rootType = schema.getSubscriptionType();
  if (rootType == null) {
    throw new GraphQLError_js_1.GraphQLError(
      'Schema is not configured to execute subscription operation.',
      { nodes: operation },
    );
  }
  const { groupedFieldSet } = (0, collectFields_js_1.collectFields)(
    schema,
    fragments,
    variableValues,
    rootType,
    operation,
  );
  const firstRootField = groupedFieldSet.entries().next().value;
  const [responseName, fieldGroup] = firstRootField;
  const fieldName = fieldGroup[0].name.value;
  const fieldDef = schema.getField(rootType, fieldName);
  if (!fieldDef) {
    throw new GraphQLError_js_1.GraphQLError(
      `The subscription field "${fieldName}" is not defined.`,
      { nodes: fieldGroup },
    );
  }
  const path = (0, Path_js_1.addPath)(undefined, responseName, rootType.name);
  const info = buildResolveInfo(
    exeContext,
    fieldDef,
    fieldGroup,
    rootType,
    path,
  );
  try {
    // Implements the "ResolveFieldEventStream" algorithm from GraphQL specification.
    // It differs from "ResolveFieldValue" due to providing a different `resolveFn`.
    // Build a JS object of arguments from the field.arguments AST, using the
    // variables scope to fulfill any variable references.
    const args = (0, values_js_1.getArgumentValues)(
      fieldDef,
      fieldGroup[0],
      variableValues,
    );
    // The resolve function's optional third argument is a context value that
    // is provided to every resolve function within an execution. It is commonly
    // used to represent an authenticated user, or request-specific caches.
    const contextValue = exeContext.contextValue;
    // Call the `subscribe()` resolver or the default resolver to produce an
    // AsyncIterable yielding raw payloads.
    const resolveFn = fieldDef.subscribe ?? exeContext.subscribeFieldResolver;
    const result = resolveFn(rootValue, args, contextValue, info);
    if ((0, isPromise_js_1.isPromise)(result)) {
      return result.then(assertEventStream).then(undefined, (error) => {
        throw (0, locatedError_js_1.locatedError)(
          error,
          fieldGroup,
          (0, Path_js_1.pathToArray)(path),
        );
      });
    }
    return assertEventStream(result);
  } catch (error) {
    throw (0, locatedError_js_1.locatedError)(
      error,
      fieldGroup,
      (0, Path_js_1.pathToArray)(path),
    );
  }
}
function assertEventStream(result) {
  if (result instanceof Error) {
    throw result;
  }
  // Assert field returned an event stream, otherwise yield an error.
  if (!(0, isAsyncIterable_js_1.isAsyncIterable)(result)) {
    throw new GraphQLError_js_1.GraphQLError(
      'Subscription field must return Async Iterable. ' +
        `Received: ${(0, inspect_js_1.inspect)(result)}.`,
    );
  }
  return result;
}
function executeDeferredFragment(
  exeContext,
  parentType,
  sourceValue,
  fields,
  label,
  path,
  parentContext,
) {
  const incrementalDataRecord =
    new IncrementalPublisher_js_1.DeferredFragmentRecord({
      label,
      path,
      parentContext,
      subsequentPayloads: exeContext.subsequentPayloads,
    });
  let promiseOrData;
  try {
    promiseOrData = executeFields(
      exeContext,
      parentType,
      sourceValue,
      path,
      fields,
      incrementalDataRecord,
    );
    if ((0, isPromise_js_1.isPromise)(promiseOrData)) {
      promiseOrData = promiseOrData.then(null, (e) => {
        incrementalDataRecord.errors.push(e);
        return null;
      });
    }
  } catch (e) {
    incrementalDataRecord.errors.push(e);
    promiseOrData = null;
  }
  incrementalDataRecord.addData(promiseOrData);
}
function executeStreamField(
  path,
  itemPath,
  item,
  exeContext,
  fieldGroup,
  info,
  itemType,
  label,
  parentContext,
) {
  const incrementalDataRecord = new IncrementalPublisher_js_1.StreamItemsRecord(
    {
      label,
      path: itemPath,
      parentContext,
      subsequentPayloads: exeContext.subsequentPayloads,
    },
  );
  if ((0, isPromise_js_1.isPromise)(item)) {
    const completedItems = completePromisedValue(
      exeContext,
      itemType,
      fieldGroup,
      info,
      itemPath,
      item,
      incrementalDataRecord,
    ).then(
      (value) => [value],
      (error) => {
        incrementalDataRecord.errors.push(error);
        (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
          exeContext.subsequentPayloads,
          path,
          incrementalDataRecord,
        );
        return null;
      },
    );
    incrementalDataRecord.addItems(completedItems);
    return incrementalDataRecord;
  }
  let completedItem;
  try {
    try {
      completedItem = completeValue(
        exeContext,
        itemType,
        fieldGroup,
        info,
        itemPath,
        item,
        incrementalDataRecord,
      );
    } catch (rawError) {
      handleFieldError(
        rawError,
        exeContext,
        itemType,
        fieldGroup,
        itemPath,
        incrementalDataRecord,
      );
      completedItem = null;
      (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
        exeContext.subsequentPayloads,
        itemPath,
        incrementalDataRecord,
      );
    }
  } catch (error) {
    incrementalDataRecord.errors.push(error);
    (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
      exeContext.subsequentPayloads,
      path,
      incrementalDataRecord,
    );
    incrementalDataRecord.addItems(null);
    return incrementalDataRecord;
  }
  if ((0, isPromise_js_1.isPromise)(completedItem)) {
    const completedItems = completedItem
      .then(undefined, (rawError) => {
        handleFieldError(
          rawError,
          exeContext,
          itemType,
          fieldGroup,
          itemPath,
          incrementalDataRecord,
        );
        (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
          exeContext.subsequentPayloads,
          itemPath,
          incrementalDataRecord,
        );
        return null;
      })
      .then(
        (value) => [value],
        (error) => {
          incrementalDataRecord.errors.push(error);
          (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
            exeContext.subsequentPayloads,
            path,
            incrementalDataRecord,
          );
          return null;
        },
      );
    incrementalDataRecord.addItems(completedItems);
    return incrementalDataRecord;
  }
  incrementalDataRecord.addItems([completedItem]);
  return incrementalDataRecord;
}
async function executeStreamAsyncIteratorItem(
  asyncIterator,
  exeContext,
  fieldGroup,
  info,
  itemType,
  incrementalDataRecord,
  path,
  itemPath,
) {
  let item;
  try {
    const { value, done } = await asyncIterator.next();
    if (done) {
      incrementalDataRecord.setIsCompletedAsyncIterator();
      return { done, value: undefined };
    }
    item = value;
  } catch (rawError) {
    throw (0, locatedError_js_1.locatedError)(
      rawError,
      fieldGroup,
      (0, Path_js_1.pathToArray)(path),
    );
  }
  let completedItem;
  try {
    completedItem = completeValue(
      exeContext,
      itemType,
      fieldGroup,
      info,
      itemPath,
      item,
      incrementalDataRecord,
    );
    if ((0, isPromise_js_1.isPromise)(completedItem)) {
      completedItem = completedItem.then(undefined, (rawError) => {
        handleFieldError(
          rawError,
          exeContext,
          itemType,
          fieldGroup,
          itemPath,
          incrementalDataRecord,
        );
        (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
          exeContext.subsequentPayloads,
          itemPath,
          incrementalDataRecord,
        );
        return null;
      });
    }
    return { done: false, value: completedItem };
  } catch (rawError) {
    handleFieldError(
      rawError,
      exeContext,
      itemType,
      fieldGroup,
      itemPath,
      incrementalDataRecord,
    );
    (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
      exeContext.subsequentPayloads,
      itemPath,
      incrementalDataRecord,
    );
    return { done: false, value: null };
  }
}
async function executeStreamAsyncIterator(
  initialIndex,
  asyncIterator,
  exeContext,
  fieldGroup,
  info,
  itemType,
  path,
  label,
  parentContext,
) {
  let index = initialIndex;
  let previousIncrementalDataRecord = parentContext ?? undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const itemPath = (0, Path_js_1.addPath)(path, index, undefined);
    const incrementalDataRecord =
      new IncrementalPublisher_js_1.StreamItemsRecord({
        label,
        path: itemPath,
        parentContext: previousIncrementalDataRecord,
        asyncIterator,
        subsequentPayloads: exeContext.subsequentPayloads,
      });
    let iteration;
    try {
      // eslint-disable-next-line no-await-in-loop
      iteration = await executeStreamAsyncIteratorItem(
        asyncIterator,
        exeContext,
        fieldGroup,
        info,
        itemType,
        incrementalDataRecord,
        path,
        itemPath,
      );
    } catch (error) {
      incrementalDataRecord.errors.push(error);
      (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
        exeContext.subsequentPayloads,
        path,
        incrementalDataRecord,
      );
      incrementalDataRecord.addItems(null);
      // entire stream has errored and bubbled upwards
      if (asyncIterator?.return) {
        asyncIterator.return().catch(() => {
          // ignore errors
        });
      }
      return;
    }
    const { done, value: completedItem } = iteration;
    let completedItems;
    if ((0, isPromise_js_1.isPromise)(completedItem)) {
      completedItems = completedItem.then(
        (value) => [value],
        (error) => {
          incrementalDataRecord.errors.push(error);
          (0, IncrementalPublisher_js_1.filterSubsequentPayloads)(
            exeContext.subsequentPayloads,
            path,
            incrementalDataRecord,
          );
          return null;
        },
      );
    } else {
      completedItems = [completedItem];
    }
    incrementalDataRecord.addItems(completedItems);
    if (done) {
      break;
    }
    previousIncrementalDataRecord = incrementalDataRecord;
    index++;
  }
}
