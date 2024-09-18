import type { Maybe } from '../jsutils/Maybe.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import { GraphQLError } from '../error/GraphQLError.js';
import type { DirectiveNode, FieldNode, FragmentSpreadNode, VariableDefinitionNode } from '../language/ast.js';
import type { GraphQLArgument, GraphQLField } from '../type/definition.js';
import type { GraphQLDirective } from '../type/directives.js';
import type { GraphQLSchema } from '../type/schema.js';
import type { FragmentVariables } from './collectFields.js';
import type { GraphQLVariableSignature } from './getVariableSignature.js';
type CoercedVariableValues = {
    errors: ReadonlyArray<GraphQLError>;
    coerced?: never;
} | {
    coerced: {
        [variable: string]: unknown;
    };
    errors?: never;
};
/**
 * Prepares an object map of variableValues of the correct type based on the
 * provided variable definitions and arbitrary input. If the input cannot be
 * parsed to match the variable definitions, a GraphQLError will be thrown.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
export declare function getVariableValues(schema: GraphQLSchema, varDefNodes: ReadonlyArray<VariableDefinitionNode>, inputs: {
    readonly [variable: string]: unknown;
}, options?: {
    maxErrors?: number;
}): CoercedVariableValues;
/**
 * Prepares an object map of argument values given a list of argument
 * definitions and list of argument AST nodes.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */
export declare function getArgumentValues(def: GraphQLField<unknown, unknown> | GraphQLDirective, node: FieldNode | DirectiveNode, variableValues?: Maybe<ObjMap<unknown>>): {
    [argument: string]: unknown;
};
export declare function experimentalGetArgumentValues(node: FieldNode | DirectiveNode | FragmentSpreadNode, argDefs: ReadonlyArray<GraphQLArgument | GraphQLVariableSignature>, variableValues: Maybe<ObjMap<unknown>>, fragmentVariables?: Maybe<FragmentVariables>): {
    [argument: string]: unknown;
};
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
export declare function getDirectiveValues(directiveDef: GraphQLDirective, node: {
    readonly directives?: ReadonlyArray<DirectiveNode> | undefined;
}, variableValues?: Maybe<ObjMap<unknown>>, fragmentVariables?: Maybe<FragmentVariables>): undefined | {
    [argument: string]: unknown;
};
export {};
