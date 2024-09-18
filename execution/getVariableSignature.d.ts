import { GraphQLError } from '../error/GraphQLError.js';
import type { VariableDefinitionNode } from '../language/ast.js';
import type { GraphQLInputType, GraphQLSchema } from '../type/index.js';
/**
 * A GraphQLVariableSignature is required to coerce a variable value.
 *
 * Designed to have comparable interface to GraphQLArgument so that
 * getArgumentValues() can be reused for fragment arguments.
 * */
export interface GraphQLVariableSignature {
    name: string;
    type: GraphQLInputType;
    defaultValue: unknown;
}
export declare function getVariableSignature(schema: GraphQLSchema, varDefNode: VariableDefinitionNode): GraphQLVariableSignature | GraphQLError;
