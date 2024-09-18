import { BoxedPromiseOrValue } from "../jsutils/BoxedPromiseOrValue.mjs";
import { inspect } from "../jsutils/inspect.mjs";
import { invariant } from "../jsutils/invariant.mjs";
import { isAsyncIterable } from "../jsutils/isAsyncIterable.mjs";
import { isIterableObject } from "../jsutils/isIterableObject.mjs";
import { isObjectLike } from "../jsutils/isObjectLike.mjs";
import { isPromise } from "../jsutils/isPromise.mjs";
import { mapValue } from "../jsutils/mapValue.mjs";
import { memoize3 } from "../jsutils/memoize3.mjs";
import { addPath, pathToArray } from "../jsutils/Path.mjs";
import { promiseForObject } from "../jsutils/promiseForObject.mjs";
import { promiseReduce } from "../jsutils/promiseReduce.mjs";
import { GraphQLError } from "../error/GraphQLError.mjs";
import { locatedError } from "../error/locatedError.mjs";
import { OperationTypeNode } from "../language/ast.mjs";
import { Kind } from "../language/kinds.mjs";
import { isAbstractType, isLeafType, isListType, isNonNullType, isObjectType, } from "../type/definition.mjs";
import { GraphQLStreamDirective } from "../type/directives.mjs";
import { assertValidSchema } from "../type/validate.mjs";
import { buildExecutionPlan } from "./buildExecutionPlan.mjs";
import { collectFields, collectSubfields as _collectSubfields, } from "./collectFields.mjs";
import { getVariableSignature } from "./getVariableSignature.mjs";
import { buildIncrementalResponse } from "./IncrementalPublisher.mjs";
import { mapAsyncIterable } from "./mapAsyncIterable.mjs";
import { DeferredFragmentRecord } from "./types.mjs";
import { experimentalGetArgumentValues, getArgumentValues, getDirectiveValues, getVariableValues, } from "./values.mjs";
/* eslint-disable @typescript-eslint/max-params */
// This file contains a lot of such errors but we plan to refactor it anyway
// so just disable it for entire file.
/**
 * A memoized collection of relevant subfields with regard to the return
 * type. Memoizing ensures the subfields are not repeatedly calculated, which
 * saves overhead when resolving lists of values.
 */
const collectSubfields = memoize3((exeContext, returnType, fieldGroup) => _collectSubfields(exeContext.schema, exeContext.fragments, exeContext.variableValues, exeContext.operation, returnType, fieldGroup));
const UNEXPECTED_EXPERIMENTAL_DIRECTIVES = 'The provided schema unexpectedly contains experimental directives (@defer or @stream). These directives may only be utilized if experimental execution features are explicitly enabled.';
const UNEXPECTED_MULTIPLE_PAYLOADS = 'Executing this GraphQL operation would unexpectedly produce multiple payloads (due to @defer or @stream directive)';
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
export function execute(args) {
    if (args.schema.getDirective('defer') || args.schema.getDirective('stream')) {
        throw new Error(UNEXPECTED_EXPERIMENTAL_DIRECTIVES);
    }
    const result = experimentalExecuteIncrementally(args);
    if (!isPromise(result)) {
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
export function experimentalExecuteIncrementally(args) {
    // If a valid execution context cannot be created due to incorrect arguments,
    // a "Response" with only errors is returned.
    const exeContext = buildExecutionContext(args);
    // Return early errors if execution context failed.
    if (!('schema' in exeContext)) {
        return { errors: exeContext };
    }
    return executeOperation(exeContext);
}
/**
 * Implements the "Executing operations" section of the spec.
 *
 * Returns a Promise that will eventually resolve to the data described by
 * The "Response" section of the GraphQL specification.
 *
 * If errors are encountered while executing a GraphQL field, only that
 * field and its descendants will be omitted, and sibling fields will still
 * be executed. An execution which encounters errors will still result in a
 * resolved Promise.
 *
 * Errors from sub-fields of a NonNull type may propagate to the top level,
 * at which point we still log the error and null the parent field, which
 * in this case is the entire response.
 */
function executeOperation(exeContext) {
    try {
        const { operation, schema, fragments, variableValues, rootValue } = exeContext;
        const rootType = schema.getRootType(operation.operation);
        if (rootType == null) {
            throw new GraphQLError(`Schema is not configured to execute ${operation.operation} operation.`, { nodes: operation });
        }
        const collectedFields = collectFields(schema, fragments, variableValues, rootType, operation);
        const { groupedFieldSet, newDeferUsages } = collectedFields;
        const graphqlWrappedResult = newDeferUsages.length === 0
            ? executeRootGroupedFieldSet(exeContext, operation.operation, rootType, rootValue, groupedFieldSet, undefined)
            : executeExecutionPlan(exeContext, rootType, rootValue, newDeferUsages, buildExecutionPlan(groupedFieldSet));
        if (isPromise(graphqlWrappedResult)) {
            return graphqlWrappedResult.then((resolved) => buildDataResponse(exeContext, resolved[0], resolved[1]), (error) => ({
                data: null,
                errors: withError(exeContext.errors, error),
            }));
        }
        return buildDataResponse(exeContext, graphqlWrappedResult[0], graphqlWrappedResult[1]);
    }
    catch (error) {
        return { data: null, errors: withError(exeContext.errors, error) };
    }
}
function executeExecutionPlan(exeContext, returnType, sourceValue, newDeferUsages, executionPlan, path, incrementalContext, deferMap) {
    const newDeferMap = getNewDeferMap(newDeferUsages, deferMap, path);
    const { groupedFieldSet, newGroupedFieldSets } = executionPlan;
    const graphqlWrappedResult = executeFields(exeContext, returnType, sourceValue, path, groupedFieldSet, incrementalContext, newDeferMap);
    if (newGroupedFieldSets.size > 0) {
        const newPendingExecutionGroups = collectExecutionGroups(exeContext, returnType, sourceValue, path, incrementalContext?.deferUsageSet, newGroupedFieldSets, newDeferMap);
        return withNewExecutionGroups(graphqlWrappedResult, newPendingExecutionGroups);
    }
    return graphqlWrappedResult;
}
function withNewExecutionGroups(result, newPendingExecutionGroups) {
    if (isPromise(result)) {
        return result.then((resolved) => {
            addIncrementalDataRecords(resolved, newPendingExecutionGroups);
            return resolved;
        });
    }
    addIncrementalDataRecords(result, newPendingExecutionGroups);
    return result;
}
function addIncrementalDataRecords(graphqlWrappedResult, incrementalDataRecords) {
    if (incrementalDataRecords === undefined) {
        return;
    }
    if (graphqlWrappedResult[1] === undefined) {
        graphqlWrappedResult[1] = [...incrementalDataRecords];
    }
    else {
        graphqlWrappedResult[1].push(...incrementalDataRecords);
    }
}
function withError(errors, error) {
    return errors === undefined ? [error] : [...errors, error];
}
function buildDataResponse(exeContext, data, incrementalDataRecords) {
    const errors = exeContext.errors;
    if (incrementalDataRecords === undefined) {
        return errors !== undefined ? { errors, data } : { data };
    }
    return buildIncrementalResponse(exeContext, data, errors, incrementalDataRecords);
}
/**
 * Also implements the "Executing requests" section of the GraphQL specification.
 * However, it guarantees to complete synchronously (or throw an error) assuming
 * that all field resolvers are also synchronous.
 */
export function executeSync(args) {
    const result = experimentalExecuteIncrementally(args);
    // Assert that the execution was synchronous.
    if (isPromise(result) || 'initialResult' in result) {
        throw new Error('GraphQL execution failed to complete synchronously.');
    }
    return result;
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
export function buildExecutionContext(args) {
    const { schema, document, rootValue, contextValue, variableValues: rawVariableValues, operationName, fieldResolver, typeResolver, subscribeFieldResolver, enableEarlyExecution, } = args;
    // If the schema used for execution is invalid, throw an error.
    assertValidSchema(schema);
    let operation;
    const fragments = Object.create(null);
    for (const definition of document.definitions) {
        switch (definition.kind) {
            case Kind.OPERATION_DEFINITION:
                if (operationName == null) {
                    if (operation !== undefined) {
                        return [
                            new GraphQLError('Must provide operation name if query contains multiple operations.'),
                        ];
                    }
                    operation = definition;
                }
                else if (definition.name?.value === operationName) {
                    operation = definition;
                }
                break;
            case Kind.FRAGMENT_DEFINITION: {
                let variableSignatures;
                if (definition.variableDefinitions) {
                    variableSignatures = Object.create(null);
                    for (const varDef of definition.variableDefinitions) {
                        const signature = getVariableSignature(schema, varDef);
                        variableSignatures[signature.name] = signature;
                    }
                }
                fragments[definition.name.value] = { definition, variableSignatures };
                break;
            }
            default:
            // ignore non-executable definitions
        }
    }
    if (!operation) {
        if (operationName != null) {
            return [new GraphQLError(`Unknown operation named "${operationName}".`)];
        }
        return [new GraphQLError('Must provide an operation.')];
    }
    // FIXME: https://github.com/graphql/graphql-js/issues/2203
    /* c8 ignore next */
    const variableDefinitions = operation.variableDefinitions ?? [];
    const coercedVariableValues = getVariableValues(schema, variableDefinitions, rawVariableValues ?? {}, { maxErrors: 50 });
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
        fieldResolver: fieldResolver ?? defaultFieldResolver,
        typeResolver: typeResolver ?? defaultTypeResolver,
        subscribeFieldResolver: subscribeFieldResolver ?? defaultFieldResolver,
        enableEarlyExecution: enableEarlyExecution === true,
        errors: undefined,
        cancellableStreams: undefined,
    };
}
function buildPerEventExecutionContext(exeContext, payload) {
    return {
        ...exeContext,
        rootValue: payload,
        errors: undefined,
    };
}
function executeRootGroupedFieldSet(exeContext, operation, rootType, rootValue, groupedFieldSet, deferMap) {
    switch (operation) {
        case OperationTypeNode.QUERY:
            return executeFields(exeContext, rootType, rootValue, undefined, groupedFieldSet, undefined, deferMap);
        case OperationTypeNode.MUTATION:
            return executeFieldsSerially(exeContext, rootType, rootValue, undefined, groupedFieldSet, undefined, deferMap);
        case OperationTypeNode.SUBSCRIPTION:
            // TODO: deprecate `subscribe` and move all logic here
            // Temporary solution until we finish merging execute and subscribe together
            return executeFields(exeContext, rootType, rootValue, undefined, groupedFieldSet, undefined, deferMap);
    }
}
/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that must be executed serially.
 */
function executeFieldsSerially(exeContext, parentType, sourceValue, path, groupedFieldSet, incrementalContext, deferMap) {
    return promiseReduce(groupedFieldSet, (graphqlWrappedResult, [responseName, fieldGroup]) => {
        const fieldPath = addPath(path, responseName, parentType.name);
        const result = executeField(exeContext, parentType, sourceValue, fieldGroup, fieldPath, incrementalContext, deferMap);
        if (result === undefined) {
            return graphqlWrappedResult;
        }
        if (isPromise(result)) {
            return result.then((resolved) => {
                graphqlWrappedResult[0][responseName] = resolved[0];
                addIncrementalDataRecords(graphqlWrappedResult, resolved[1]);
                return graphqlWrappedResult;
            });
        }
        graphqlWrappedResult[0][responseName] = result[0];
        addIncrementalDataRecords(graphqlWrappedResult, result[1]);
        return graphqlWrappedResult;
    }, [Object.create(null), undefined]);
}
/**
 * Implements the "Executing selection sets" section of the spec
 * for fields that may be executed in parallel.
 */
function executeFields(exeContext, parentType, sourceValue, path, groupedFieldSet, incrementalContext, deferMap) {
    const results = Object.create(null);
    const graphqlWrappedResult = [
        results,
        undefined,
    ];
    let containsPromise = false;
    try {
        for (const [responseName, fieldGroup] of groupedFieldSet) {
            const fieldPath = addPath(path, responseName, parentType.name);
            const result = executeField(exeContext, parentType, sourceValue, fieldGroup, fieldPath, incrementalContext, deferMap);
            if (result !== undefined) {
                if (isPromise(result)) {
                    results[responseName] = result.then((resolved) => {
                        addIncrementalDataRecords(graphqlWrappedResult, resolved[1]);
                        return resolved[0];
                    });
                    containsPromise = true;
                }
                else {
                    results[responseName] = result[0];
                    addIncrementalDataRecords(graphqlWrappedResult, result[1]);
                }
            }
        }
    }
    catch (error) {
        if (containsPromise) {
            // Ensure that any promises returned by other fields are handled, as they may also reject.
            return promiseForObject(results, () => {
                /* noop */
            }).finally(() => {
                throw error;
            });
        }
        throw error;
    }
    // If there are no promises, we can just return the object and any incrementalDataRecords
    if (!containsPromise) {
        return graphqlWrappedResult;
    }
    // Otherwise, results is a map from field name to the result of resolving that
    // field, which is possibly a promise. Return a promise that will return this
    // same map, but with any promises replaced with the values they resolved to.
    return promiseForObject(results, (resolved) => [
        resolved,
        graphqlWrappedResult[1],
    ]);
}
function toNodes(fieldGroup) {
    return fieldGroup.map((fieldDetails) => fieldDetails.node);
}
/**
 * Implements the "Executing fields" section of the spec
 * In particular, this function figures out the value that the field returns by
 * calling its resolve function, then calls completeValue to complete promises,
 * serialize scalars, or execute the sub-selection-set for objects.
 */
function executeField(exeContext, parentType, source, fieldGroup, path, incrementalContext, deferMap) {
    const fieldName = fieldGroup[0].node.name.value;
    const fieldDef = exeContext.schema.getField(parentType, fieldName);
    if (!fieldDef) {
        return;
    }
    const returnType = fieldDef.type;
    const resolveFn = fieldDef.resolve ?? exeContext.fieldResolver;
    const info = buildResolveInfo(exeContext, fieldDef, toNodes(fieldGroup), parentType, path);
    // Get the resolve function, regardless of if its result is normal or abrupt (error).
    try {
        // Build a JS object of arguments from the field.arguments AST, using the
        // variables scope to fulfill any variable references.
        // TODO: find a way to memoize, in case this field is within a List type.
        const args = experimentalGetArgumentValues(fieldGroup[0].node, fieldDef.args, exeContext.variableValues, fieldGroup[0].fragmentVariables);
        // The resolve function's optional third argument is a context value that
        // is provided to every resolve function within an execution. It is commonly
        // used to represent an authenticated user, or request-specific caches.
        const contextValue = exeContext.contextValue;
        const result = resolveFn(source, args, contextValue, info);
        if (isPromise(result)) {
            return completePromisedValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap);
        }
        const completed = completeValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap);
        if (isPromise(completed)) {
            // Note: we don't rely on a `catch` method, but we do expect "thenable"
            // to take a second callback for the error case.
            return completed.then(undefined, (rawError) => {
                handleFieldError(rawError, exeContext, returnType, fieldGroup, path, incrementalContext);
                return [null, undefined];
            });
        }
        return completed;
    }
    catch (rawError) {
        handleFieldError(rawError, exeContext, returnType, fieldGroup, path, incrementalContext);
        return [null, undefined];
    }
}
/**
 * TODO: consider no longer exporting this function
 * @internal
 */
export function buildResolveInfo(exeContext, fieldDef, fieldNodes, parentType, path) {
    // The resolve function's optional fourth argument is a collection of
    // information about the current execution state.
    return {
        fieldName: fieldDef.name,
        fieldNodes,
        returnType: fieldDef.type,
        parentType,
        path,
        schema: exeContext.schema,
        fragments: mapValue(exeContext.fragments, (fragment) => fragment.definition),
        rootValue: exeContext.rootValue,
        operation: exeContext.operation,
        variableValues: exeContext.variableValues,
    };
}
function handleFieldError(rawError, exeContext, returnType, fieldGroup, path, incrementalContext) {
    const error = locatedError(rawError, toNodes(fieldGroup), pathToArray(path));
    // If the field type is non-nullable, then it is resolved without any
    // protection from errors, however it still properly locates the error.
    if (isNonNullType(returnType)) {
        throw error;
    }
    // Otherwise, error protection is applied, logging the error and resolving
    // a null value for this field if one is encountered.
    const context = incrementalContext ?? exeContext;
    let errors = context.errors;
    if (errors === undefined) {
        errors = [];
        context.errors = errors;
    }
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
function completeValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap) {
    // If result is an Error, throw a located error.
    if (result instanceof Error) {
        throw result;
    }
    // If field type is NonNull, complete for inner type, and throw field error
    // if result is null.
    if (isNonNullType(returnType)) {
        const completed = completeValue(exeContext, returnType.ofType, fieldGroup, info, path, result, incrementalContext, deferMap);
        if (completed[0] === null) {
            throw new Error(`Cannot return null for non-nullable field ${info.parentType}.${info.fieldName}.`);
        }
        return completed;
    }
    // If result value is null or undefined then return null.
    if (result == null) {
        return [null, undefined];
    }
    // If field type is List, complete each item in the list with the inner type
    if (isListType(returnType)) {
        return completeListValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap);
    }
    // If field type is a leaf type, Scalar or Enum, serialize to a valid value,
    // returning null if serialization is not possible.
    if (isLeafType(returnType)) {
        return [completeLeafValue(returnType, result), undefined];
    }
    // If field type is an abstract type, Interface or Union, determine the
    // runtime Object type and complete for that type.
    if (isAbstractType(returnType)) {
        return completeAbstractValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap);
    }
    // If field type is Object, execute and complete all sub-selections.
    if (isObjectType(returnType)) {
        return completeObjectValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap);
    }
    /* c8 ignore next 6 */
    // Not reachable, all possible output types have been considered.
    (false) || invariant(false, 'Cannot complete value of unexpected output type: ' + inspect(returnType));
}
async function completePromisedValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap) {
    try {
        const resolved = await result;
        let completed = completeValue(exeContext, returnType, fieldGroup, info, path, resolved, incrementalContext, deferMap);
        if (isPromise(completed)) {
            completed = await completed;
        }
        return completed;
    }
    catch (rawError) {
        handleFieldError(rawError, exeContext, returnType, fieldGroup, path, incrementalContext);
        return [null, undefined];
    }
}
/**
 * Returns an object containing info for streaming if a field should be
 * streamed based on the experimental flag, stream directive present and
 * not disabled by the "if" argument.
 */
function getStreamUsage(exeContext, fieldGroup, path) {
    // do not stream inner lists of multi-dimensional lists
    if (typeof path.key === 'number') {
        return;
    }
    // TODO: add test for this case (a streamed list nested under a list).
    /* c8 ignore next 7 */
    if (fieldGroup._streamUsage !==
        undefined) {
        return fieldGroup
            ._streamUsage;
    }
    // validation only allows equivalent streams on multiple fields, so it is
    // safe to only check the first fieldNode for the stream directive
    const stream = getDirectiveValues(GraphQLStreamDirective, fieldGroup[0].node, exeContext.variableValues, fieldGroup[0].fragmentVariables);
    if (!stream) {
        return;
    }
    if (stream.if === false) {
        return;
    }
    (typeof stream.initialCount === 'number') || invariant(false, 'initialCount must be a number');
    (stream.initialCount >= 0) || invariant(false, 'initialCount must be a positive integer');
    (exeContext.operation.operation !== OperationTypeNode.SUBSCRIPTION) || invariant(false, '`@stream` directive not supported on subscription operations. Disable `@stream` by setting the `if` argument to `false`.');
    const streamedFieldGroup = fieldGroup.map((fieldDetails) => ({
        node: fieldDetails.node,
        deferUsage: undefined,
        fragmentVariables: fieldDetails.fragmentVariables,
    }));
    const streamUsage = {
        initialCount: stream.initialCount,
        label: typeof stream.label === 'string' ? stream.label : undefined,
        fieldGroup: streamedFieldGroup,
    };
    fieldGroup._streamUsage =
        streamUsage;
    return streamUsage;
}
/**
 * Complete a async iterator value by completing the result and calling
 * recursively until all the results are completed.
 */
async function completeAsyncIteratorValue(exeContext, itemType, fieldGroup, info, path, asyncIterator, incrementalContext, deferMap) {
    let containsPromise = false;
    const completedResults = [];
    const graphqlWrappedResult = [
        completedResults,
        undefined,
    ];
    let index = 0;
    const streamUsage = getStreamUsage(exeContext, fieldGroup, path);
    const earlyReturn = asyncIterator.return === undefined
        ? undefined
        : asyncIterator.return.bind(asyncIterator);
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (streamUsage && index >= streamUsage.initialCount) {
                const streamItemQueue = buildAsyncStreamItemQueue(index, path, asyncIterator, exeContext, streamUsage.fieldGroup, info, itemType);
                let streamRecord;
                if (earlyReturn === undefined) {
                    streamRecord = {
                        label: streamUsage.label,
                        path,
                        streamItemQueue,
                    };
                }
                else {
                    streamRecord = {
                        label: streamUsage.label,
                        path,
                        earlyReturn,
                        streamItemQueue,
                    };
                    if (exeContext.cancellableStreams === undefined) {
                        exeContext.cancellableStreams = new Set();
                    }
                    exeContext.cancellableStreams.add(streamRecord);
                }
                addIncrementalDataRecords(graphqlWrappedResult, [streamRecord]);
                break;
            }
            const itemPath = addPath(path, index, undefined);
            let iteration;
            try {
                // eslint-disable-next-line no-await-in-loop
                iteration = await asyncIterator.next();
            }
            catch (rawError) {
                throw locatedError(rawError, toNodes(fieldGroup), pathToArray(path));
            }
            // TODO: add test case for stream returning done before initialCount
            /* c8 ignore next 3 */
            if (iteration.done) {
                break;
            }
            const item = iteration.value;
            // TODO: add tests for stream backed by asyncIterator that returns a promise
            /* c8 ignore start */
            if (isPromise(item)) {
                completedResults.push(completePromisedListItemValue(item, graphqlWrappedResult, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap));
                containsPromise = true;
            }
            else if (
            /* c8 ignore stop */
            completeListItemValue(item, completedResults, graphqlWrappedResult, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap)
            // TODO: add tests for stream backed by asyncIterator that completes to a promise
            /* c8 ignore start */
            ) {
                containsPromise = true;
            }
            /* c8 ignore stop */
            index++;
        }
    }
    catch (error) {
        if (earlyReturn !== undefined) {
            earlyReturn().catch(() => {
                /* c8 ignore next 1 */
                // ignore error
            });
        }
        throw error;
    }
    return containsPromise
        ? /* c8 ignore start */ Promise.all(completedResults).then((resolved) => [
            resolved,
            graphqlWrappedResult[1],
        ])
        : /* c8 ignore stop */ graphqlWrappedResult;
}
/**
 * Complete a list value by completing each item in the list with the
 * inner type
 */
function completeListValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap) {
    const itemType = returnType.ofType;
    if (isAsyncIterable(result)) {
        const asyncIterator = result[Symbol.asyncIterator]();
        return completeAsyncIteratorValue(exeContext, itemType, fieldGroup, info, path, asyncIterator, incrementalContext, deferMap);
    }
    if (!isIterableObject(result)) {
        throw new GraphQLError(`Expected Iterable, but did not find one for field "${info.parentType}.${info.fieldName}".`);
    }
    return completeIterableValue(exeContext, itemType, fieldGroup, info, path, result, incrementalContext, deferMap);
}
function completeIterableValue(exeContext, itemType, fieldGroup, info, path, items, incrementalContext, deferMap) {
    // This is specified as a simple map, however we're optimizing the path
    // where the list contains no Promises by avoiding creating another Promise.
    let containsPromise = false;
    const completedResults = [];
    const graphqlWrappedResult = [
        completedResults,
        undefined,
    ];
    let index = 0;
    const streamUsage = getStreamUsage(exeContext, fieldGroup, path);
    const iterator = items[Symbol.iterator]();
    let iteration = iterator.next();
    while (!iteration.done) {
        const item = iteration.value;
        if (streamUsage && index >= streamUsage.initialCount) {
            const syncStreamRecord = {
                label: streamUsage.label,
                path,
                streamItemQueue: buildSyncStreamItemQueue(item, index, path, iterator, exeContext, streamUsage.fieldGroup, info, itemType),
            };
            addIncrementalDataRecords(graphqlWrappedResult, [syncStreamRecord]);
            break;
        }
        // No need to modify the info object containing the path,
        // since from here on it is not ever accessed by resolver functions.
        const itemPath = addPath(path, index, undefined);
        if (isPromise(item)) {
            completedResults.push(completePromisedListItemValue(item, graphqlWrappedResult, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap));
            containsPromise = true;
        }
        else if (completeListItemValue(item, completedResults, graphqlWrappedResult, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap)) {
            containsPromise = true;
        }
        index++;
        iteration = iterator.next();
    }
    return containsPromise
        ? Promise.all(completedResults).then((resolved) => [
            resolved,
            graphqlWrappedResult[1],
        ])
        : graphqlWrappedResult;
}
/**
 * Complete a list item value by adding it to the completed results.
 *
 * Returns true if the value is a Promise.
 */
function completeListItemValue(item, completedResults, parent, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap) {
    try {
        const completedItem = completeValue(exeContext, itemType, fieldGroup, info, itemPath, item, incrementalContext, deferMap);
        if (isPromise(completedItem)) {
            // Note: we don't rely on a `catch` method, but we do expect "thenable"
            // to take a second callback for the error case.
            completedResults.push(completedItem.then((resolved) => {
                addIncrementalDataRecords(parent, resolved[1]);
                return resolved[0];
            }, (rawError) => {
                handleFieldError(rawError, exeContext, itemType, fieldGroup, itemPath, incrementalContext);
                return null;
            }));
            return true;
        }
        completedResults.push(completedItem[0]);
        addIncrementalDataRecords(parent, completedItem[1]);
    }
    catch (rawError) {
        handleFieldError(rawError, exeContext, itemType, fieldGroup, itemPath, incrementalContext);
        completedResults.push(null);
    }
    return false;
}
async function completePromisedListItemValue(item, parent, exeContext, itemType, fieldGroup, info, itemPath, incrementalContext, deferMap) {
    try {
        const resolved = await item;
        let completed = completeValue(exeContext, itemType, fieldGroup, info, itemPath, resolved, incrementalContext, deferMap);
        if (isPromise(completed)) {
            completed = await completed;
        }
        addIncrementalDataRecords(parent, completed[1]);
        return completed[0];
    }
    catch (rawError) {
        handleFieldError(rawError, exeContext, itemType, fieldGroup, itemPath, incrementalContext);
        return null;
    }
}
/**
 * Complete a Scalar or Enum by serializing to a valid value, returning
 * null if serialization is not possible.
 */
function completeLeafValue(returnType, result) {
    const serializedResult = returnType.serialize(result);
    if (serializedResult == null) {
        throw new Error(`Expected \`${inspect(returnType)}.serialize(${inspect(result)})\` to ` +
            `return non-nullable value, returned: ${inspect(serializedResult)}`);
    }
    return serializedResult;
}
/**
 * Complete a value of an abstract type by determining the runtime object type
 * of that value, then complete the value for that type.
 */
function completeAbstractValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap) {
    const resolveTypeFn = returnType.resolveType ?? exeContext.typeResolver;
    const contextValue = exeContext.contextValue;
    const runtimeType = resolveTypeFn(result, contextValue, info, returnType);
    if (isPromise(runtimeType)) {
        return runtimeType.then((resolvedRuntimeType) => completeObjectValue(exeContext, ensureValidRuntimeType(resolvedRuntimeType, exeContext, returnType, fieldGroup, info, result), fieldGroup, info, path, result, incrementalContext, deferMap));
    }
    return completeObjectValue(exeContext, ensureValidRuntimeType(runtimeType, exeContext, returnType, fieldGroup, info, result), fieldGroup, info, path, result, incrementalContext, deferMap);
}
function ensureValidRuntimeType(runtimeTypeName, exeContext, returnType, fieldGroup, info, result) {
    if (runtimeTypeName == null) {
        throw new GraphQLError(`Abstract type "${returnType}" must resolve to an Object type at runtime for field "${info.parentType}.${info.fieldName}". Either the "${returnType}" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.`, { nodes: toNodes(fieldGroup) });
    }
    if (typeof runtimeTypeName !== 'string') {
        throw new GraphQLError(`Abstract type "${returnType}" must resolve to an Object type at runtime for field "${info.parentType}.${info.fieldName}" with ` +
            `value ${inspect(result)}, received "${inspect(runtimeTypeName)}", which is not a valid Object type name.`);
    }
    const runtimeType = exeContext.schema.getType(runtimeTypeName);
    if (runtimeType == null) {
        throw new GraphQLError(`Abstract type "${returnType}" was resolved to a type "${runtimeTypeName}" that does not exist inside the schema.`, { nodes: toNodes(fieldGroup) });
    }
    if (!isObjectType(runtimeType)) {
        throw new GraphQLError(`Abstract type "${returnType}" was resolved to a non-object type "${runtimeTypeName}".`, { nodes: toNodes(fieldGroup) });
    }
    if (!exeContext.schema.isSubType(returnType, runtimeType)) {
        throw new GraphQLError(`Runtime Object type "${runtimeType}" is not a possible type for "${returnType}".`, { nodes: toNodes(fieldGroup) });
    }
    return runtimeType;
}
/**
 * Complete an Object value by executing all sub-selections.
 */
function completeObjectValue(exeContext, returnType, fieldGroup, info, path, result, incrementalContext, deferMap) {
    // If there is an isTypeOf predicate function, call it with the
    // current result. If isTypeOf returns false, then raise an error rather
    // than continuing execution.
    if (returnType.isTypeOf) {
        const isTypeOf = returnType.isTypeOf(result, exeContext.contextValue, info);
        if (isPromise(isTypeOf)) {
            return isTypeOf.then((resolvedIsTypeOf) => {
                if (!resolvedIsTypeOf) {
                    throw invalidReturnTypeError(returnType, result, fieldGroup);
                }
                return collectAndExecuteSubfields(exeContext, returnType, fieldGroup, path, result, incrementalContext, deferMap);
            });
        }
        if (!isTypeOf) {
            throw invalidReturnTypeError(returnType, result, fieldGroup);
        }
    }
    return collectAndExecuteSubfields(exeContext, returnType, fieldGroup, path, result, incrementalContext, deferMap);
}
function invalidReturnTypeError(returnType, result, fieldGroup) {
    return new GraphQLError(`Expected value of type "${returnType}" but got: ${inspect(result)}.`, { nodes: toNodes(fieldGroup) });
}
/**
 * Instantiates new DeferredFragmentRecords for the given path within an
 * incremental data record, returning an updated map of DeferUsage
 * objects to DeferredFragmentRecords.
 *
 * Note: As defer directives may be used with operations returning lists,
 * a DeferUsage object may correspond to many DeferredFragmentRecords.
 */
function getNewDeferMap(newDeferUsages, deferMap, path) {
    const newDeferMap = new Map(deferMap);
    // For each new deferUsage object:
    for (const newDeferUsage of newDeferUsages) {
        const parentDeferUsage = newDeferUsage.parentDeferUsage;
        const parent = parentDeferUsage === undefined
            ? undefined
            : deferredFragmentRecordFromDeferUsage(parentDeferUsage, newDeferMap);
        // Instantiate the new record.
        const deferredFragmentRecord = new DeferredFragmentRecord(path, newDeferUsage.label, parent);
        // Update the map.
        newDeferMap.set(newDeferUsage, deferredFragmentRecord);
    }
    return newDeferMap;
}
function deferredFragmentRecordFromDeferUsage(deferUsage, deferMap) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return deferMap.get(deferUsage);
}
function collectAndExecuteSubfields(exeContext, returnType, fieldGroup, path, result, incrementalContext, deferMap) {
    // Collect sub-fields to execute to complete this value.
    const collectedSubfields = collectSubfields(exeContext, returnType, fieldGroup);
    const { groupedFieldSet, newDeferUsages } = collectedSubfields;
    return deferMap === undefined && newDeferUsages.length === 0
        ? executeFields(exeContext, returnType, result, path, groupedFieldSet, incrementalContext, undefined)
        : executeExecutionPlan(exeContext, returnType, result, newDeferUsages, buildSubExecutionPlan(groupedFieldSet, incrementalContext?.deferUsageSet), path, incrementalContext, deferMap);
}
function buildSubExecutionPlan(originalGroupedFieldSet, deferUsageSet) {
    let executionPlan = originalGroupedFieldSet._executionPlan;
    if (executionPlan !== undefined) {
        return executionPlan;
    }
    executionPlan = buildExecutionPlan(originalGroupedFieldSet, deferUsageSet);
    originalGroupedFieldSet._executionPlan = executionPlan;
    return executionPlan;
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
export const defaultTypeResolver = function (value, contextValue, info, abstractType) {
    // First, look for `__typename`.
    if (isObjectLike(value) && typeof value.__typename === 'string') {
        return value.__typename;
    }
    // Otherwise, test each possible type.
    const possibleTypes = info.schema.getPossibleTypes(abstractType);
    const promisedIsTypeOfResults = [];
    for (let i = 0; i < possibleTypes.length; i++) {
        const type = possibleTypes[i];
        if (type.isTypeOf) {
            const isTypeOfResult = type.isTypeOf(value, contextValue, info);
            if (isPromise(isTypeOfResult)) {
                promisedIsTypeOfResults[i] = isTypeOfResult;
            }
            else if (isTypeOfResult) {
                if (promisedIsTypeOfResults.length > 0) {
                    Promise.all(promisedIsTypeOfResults).then(undefined, () => {
                        /* ignore errors */
                    });
                }
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
/**
 * If a resolve function is not given, then a default resolve behavior is used
 * which takes the property of the source object of the same name as the field
 * and returns it as the result, or if it's a function, returns the result
 * of calling that function while passing along args and context value.
 */
export const defaultFieldResolver = function (source, args, contextValue, info) {
    // ensure source is a value for which property access is acceptable.
    if (isObjectLike(source) || typeof source === 'function') {
        const property = source[info.fieldName];
        if (typeof property === 'function') {
            return source[info.fieldName](args, contextValue, info);
        }
        return property;
    }
};
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
export function subscribe(args) {
    // If a valid execution context cannot be created due to incorrect arguments,
    // a "Response" with only errors is returned.
    const exeContext = buildExecutionContext(args);
    // Return early errors if execution context failed.
    if (!('schema' in exeContext)) {
        return { errors: exeContext };
    }
    const resultOrStream = createSourceEventStreamImpl(exeContext);
    if (isPromise(resultOrStream)) {
        return resultOrStream.then((resolvedResultOrStream) => mapSourceToResponse(exeContext, resolvedResultOrStream));
    }
    return mapSourceToResponse(exeContext, resultOrStream);
}
function mapSourceToResponse(exeContext, resultOrStream) {
    if (!isAsyncIterable(resultOrStream)) {
        return resultOrStream;
    }
    // For each payload yielded from a subscription, map it over the normal
    // GraphQL `execute` function, with `payload` as the rootValue.
    // This implements the "MapSourceToResponseEvent" algorithm described in
    // the GraphQL specification. The `execute` function provides the
    // "ExecuteSubscriptionEvent" algorithm, as it is nearly identical to the
    // "ExecuteQuery" algorithm, for which `execute` is also used.
    return mapAsyncIterable(resultOrStream, (payload) => executeOperation(buildPerEventExecutionContext(exeContext, payload)));
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
export function createSourceEventStream(args) {
    // If a valid execution context cannot be created due to incorrect arguments,
    // a "Response" with only errors is returned.
    const exeContext = buildExecutionContext(args);
    // Return early errors if execution context failed.
    if (!('schema' in exeContext)) {
        return { errors: exeContext };
    }
    return createSourceEventStreamImpl(exeContext);
}
function createSourceEventStreamImpl(exeContext) {
    try {
        const eventStream = executeSubscription(exeContext);
        if (isPromise(eventStream)) {
            return eventStream.then(undefined, (error) => ({
                errors: [error],
            }));
        }
        return eventStream;
    }
    catch (error) {
        return { errors: [error] };
    }
}
function executeSubscription(exeContext) {
    const { schema, fragments, operation, variableValues, rootValue } = exeContext;
    const rootType = schema.getSubscriptionType();
    if (rootType == null) {
        throw new GraphQLError('Schema is not configured to execute subscription operation.', { nodes: operation });
    }
    const { groupedFieldSet } = collectFields(schema, fragments, variableValues, rootType, operation);
    const firstRootField = groupedFieldSet.entries().next().value;
    const [responseName, fieldGroup] = firstRootField;
    const fieldName = fieldGroup[0].node.name.value;
    const fieldDef = schema.getField(rootType, fieldName);
    const fieldNodes = fieldGroup.map((fieldDetails) => fieldDetails.node);
    if (!fieldDef) {
        throw new GraphQLError(`The subscription field "${fieldName}" is not defined.`, { nodes: fieldNodes });
    }
    const path = addPath(undefined, responseName, rootType.name);
    const info = buildResolveInfo(exeContext, fieldDef, fieldNodes, rootType, path);
    try {
        // Implements the "ResolveFieldEventStream" algorithm from GraphQL specification.
        // It differs from "ResolveFieldValue" due to providing a different `resolveFn`.
        // Build a JS object of arguments from the field.arguments AST, using the
        // variables scope to fulfill any variable references.
        const args = getArgumentValues(fieldDef, fieldNodes[0], variableValues);
        // The resolve function's optional third argument is a context value that
        // is provided to every resolve function within an execution. It is commonly
        // used to represent an authenticated user, or request-specific caches.
        const contextValue = exeContext.contextValue;
        // Call the `subscribe()` resolver or the default resolver to produce an
        // AsyncIterable yielding raw payloads.
        const resolveFn = fieldDef.subscribe ?? exeContext.subscribeFieldResolver;
        const result = resolveFn(rootValue, args, contextValue, info);
        if (isPromise(result)) {
            return result
                .then(assertEventStream)
                .then(undefined, (error) => {
                throw locatedError(error, fieldNodes, pathToArray(path));
            });
        }
        return assertEventStream(result);
    }
    catch (error) {
        throw locatedError(error, fieldNodes, pathToArray(path));
    }
}
function assertEventStream(result) {
    if (result instanceof Error) {
        throw result;
    }
    // Assert field returned an event stream, otherwise yield an error.
    if (!isAsyncIterable(result)) {
        throw new GraphQLError('Subscription field must return Async Iterable. ' +
            `Received: ${inspect(result)}.`);
    }
    return result;
}
function collectExecutionGroups(exeContext, parentType, sourceValue, path, parentDeferUsages, newGroupedFieldSets, deferMap) {
    const newPendingExecutionGroups = [];
    for (const [deferUsageSet, groupedFieldSet] of newGroupedFieldSets) {
        const deferredFragmentRecords = getDeferredFragmentRecords(deferUsageSet, deferMap);
        const pendingExecutionGroup = {
            deferredFragmentRecords,
            result: undefined,
        };
        const executor = () => executeExecutionGroup(pendingExecutionGroup, exeContext, parentType, sourceValue, path, groupedFieldSet, {
            errors: undefined,
            deferUsageSet,
        }, deferMap);
        if (exeContext.enableEarlyExecution) {
            pendingExecutionGroup.result = new BoxedPromiseOrValue(shouldDefer(parentDeferUsages, deferUsageSet)
                ? Promise.resolve().then(executor)
                : executor());
        }
        else {
            pendingExecutionGroup.result = () => new BoxedPromiseOrValue(executor());
        }
        newPendingExecutionGroups.push(pendingExecutionGroup);
    }
    return newPendingExecutionGroups;
}
function shouldDefer(parentDeferUsages, deferUsages) {
    // If we have a new child defer usage, defer.
    // Otherwise, this defer usage was already deferred when it was initially
    // encountered, and is now in the midst of executing early, so the new
    // deferred grouped fields set can be executed immediately.
    return (parentDeferUsages === undefined ||
        !Array.from(deferUsages).every((deferUsage) => parentDeferUsages.has(deferUsage)));
}
function executeExecutionGroup(pendingExecutionGroup, exeContext, parentType, sourceValue, path, groupedFieldSet, incrementalContext, deferMap) {
    let result;
    try {
        result = executeFields(exeContext, parentType, sourceValue, path, groupedFieldSet, incrementalContext, deferMap);
    }
    catch (error) {
        return {
            pendingExecutionGroup,
            path: pathToArray(path),
            errors: withError(incrementalContext.errors, error),
        };
    }
    if (isPromise(result)) {
        return result.then((resolved) => buildCompletedExecutionGroup(incrementalContext.errors, pendingExecutionGroup, path, resolved), (error) => ({
            pendingExecutionGroup,
            path: pathToArray(path),
            errors: withError(incrementalContext.errors, error),
        }));
    }
    return buildCompletedExecutionGroup(incrementalContext.errors, pendingExecutionGroup, path, result);
}
function buildCompletedExecutionGroup(errors, pendingExecutionGroup, path, result) {
    return {
        pendingExecutionGroup,
        path: pathToArray(path),
        result: errors === undefined ? { data: result[0] } : { data: result[0], errors },
        incrementalDataRecords: result[1],
    };
}
function getDeferredFragmentRecords(deferUsages, deferMap) {
    return Array.from(deferUsages).map((deferUsage) => deferredFragmentRecordFromDeferUsage(deferUsage, deferMap));
}
function buildSyncStreamItemQueue(initialItem, initialIndex, streamPath, iterator, exeContext, fieldGroup, info, itemType) {
    const streamItemQueue = [];
    const enableEarlyExecution = exeContext.enableEarlyExecution;
    const firstExecutor = () => {
        const initialPath = addPath(streamPath, initialIndex, undefined);
        const firstStreamItem = new BoxedPromiseOrValue(completeStreamItem(initialPath, initialItem, exeContext, { errors: undefined }, fieldGroup, info, itemType));
        let iteration = iterator.next();
        let currentIndex = initialIndex + 1;
        let currentStreamItem = firstStreamItem;
        while (!iteration.done) {
            // TODO: add test case for early sync termination
            /* c8 ignore next 6 */
            if (currentStreamItem instanceof BoxedPromiseOrValue) {
                const result = currentStreamItem.value;
                if (!isPromise(result) && result.errors !== undefined) {
                    break;
                }
            }
            const itemPath = addPath(streamPath, currentIndex, undefined);
            const value = iteration.value;
            const currentExecutor = () => completeStreamItem(itemPath, value, exeContext, { errors: undefined }, fieldGroup, info, itemType);
            currentStreamItem = enableEarlyExecution
                ? new BoxedPromiseOrValue(currentExecutor())
                : () => new BoxedPromiseOrValue(currentExecutor());
            streamItemQueue.push(currentStreamItem);
            iteration = iterator.next();
            currentIndex = initialIndex + 1;
        }
        streamItemQueue.push(new BoxedPromiseOrValue({}));
        return firstStreamItem.value;
    };
    streamItemQueue.push(enableEarlyExecution
        ? new BoxedPromiseOrValue(Promise.resolve().then(firstExecutor))
        : () => new BoxedPromiseOrValue(firstExecutor()));
    return streamItemQueue;
}
function buildAsyncStreamItemQueue(initialIndex, streamPath, asyncIterator, exeContext, fieldGroup, info, itemType) {
    const streamItemQueue = [];
    const executor = () => getNextAsyncStreamItemResult(streamItemQueue, streamPath, initialIndex, asyncIterator, exeContext, fieldGroup, info, itemType);
    streamItemQueue.push(exeContext.enableEarlyExecution
        ? new BoxedPromiseOrValue(executor())
        : () => new BoxedPromiseOrValue(executor()));
    return streamItemQueue;
}
async function getNextAsyncStreamItemResult(streamItemQueue, streamPath, index, asyncIterator, exeContext, fieldGroup, info, itemType) {
    let iteration;
    try {
        iteration = await asyncIterator.next();
    }
    catch (error) {
        return {
            errors: [
                locatedError(error, toNodes(fieldGroup), pathToArray(streamPath)),
            ],
        };
    }
    if (iteration.done) {
        return {};
    }
    const itemPath = addPath(streamPath, index, undefined);
    const result = completeStreamItem(itemPath, iteration.value, exeContext, { errors: undefined }, fieldGroup, info, itemType);
    const executor = () => getNextAsyncStreamItemResult(streamItemQueue, streamPath, index + 1, asyncIterator, exeContext, fieldGroup, info, itemType);
    streamItemQueue.push(exeContext.enableEarlyExecution
        ? new BoxedPromiseOrValue(executor())
        : () => new BoxedPromiseOrValue(executor()));
    return result;
}
function completeStreamItem(itemPath, item, exeContext, incrementalContext, fieldGroup, info, itemType) {
    if (isPromise(item)) {
        return completePromisedValue(exeContext, itemType, fieldGroup, info, itemPath, item, incrementalContext, new Map()).then((resolvedItem) => buildStreamItemResult(incrementalContext.errors, resolvedItem), (error) => ({
            errors: withError(incrementalContext.errors, error),
        }));
    }
    let result;
    try {
        try {
            result = completeValue(exeContext, itemType, fieldGroup, info, itemPath, item, incrementalContext, new Map());
        }
        catch (rawError) {
            handleFieldError(rawError, exeContext, itemType, fieldGroup, itemPath, incrementalContext);
            result = [null, undefined];
        }
    }
    catch (error) {
        return {
            errors: withError(incrementalContext.errors, error),
        };
    }
    if (isPromise(result)) {
        return result
            .then(undefined, (rawError) => {
            handleFieldError(rawError, exeContext, itemType, fieldGroup, itemPath, incrementalContext);
            return [null, undefined];
        })
            .then((resolvedItem) => buildStreamItemResult(incrementalContext.errors, resolvedItem), (error) => ({
            errors: withError(incrementalContext.errors, error),
        }));
    }
    return buildStreamItemResult(incrementalContext.errors, result);
}
function buildStreamItemResult(errors, result) {
    return {
        item: result[0],
        errors,
        incrementalDataRecords: result[1],
    };
}
