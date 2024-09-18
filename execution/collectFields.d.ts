import type { ObjMap } from '../jsutils/ObjMap.js';
import type { FieldNode, FragmentDefinitionNode, OperationDefinitionNode } from '../language/ast.js';
import type { GraphQLObjectType } from '../type/definition.js';
import type { GraphQLSchema } from '../type/schema.js';
import type { GraphQLVariableSignature } from './getVariableSignature.js';
export interface DeferUsage {
    label: string | undefined;
    parentDeferUsage: DeferUsage | undefined;
}
export interface FragmentVariables {
    signatures: ObjMap<GraphQLVariableSignature>;
    values: ObjMap<unknown>;
}
export interface FieldDetails {
    node: FieldNode;
    deferUsage?: DeferUsage | undefined;
    fragmentVariables?: FragmentVariables | undefined;
}
export type FieldGroup = ReadonlyArray<FieldDetails>;
export type GroupedFieldSet = ReadonlyMap<string, FieldGroup>;
export interface FragmentDetails {
    definition: FragmentDefinitionNode;
    variableSignatures?: ObjMap<GraphQLVariableSignature> | undefined;
}
/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
export declare function collectFields(schema: GraphQLSchema, fragments: ObjMap<FragmentDetails>, variableValues: {
    [variable: string]: unknown;
}, runtimeType: GraphQLObjectType, operation: OperationDefinitionNode): {
    groupedFieldSet: GroupedFieldSet;
    newDeferUsages: ReadonlyArray<DeferUsage>;
};
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
export declare function collectSubfields(schema: GraphQLSchema, fragments: ObjMap<FragmentDetails>, variableValues: {
    [variable: string]: unknown;
}, operation: OperationDefinitionNode, returnType: GraphQLObjectType, fieldGroup: FieldGroup): {
    groupedFieldSet: GroupedFieldSet;
    newDeferUsages: ReadonlyArray<DeferUsage>;
};
