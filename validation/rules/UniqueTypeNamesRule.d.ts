import type { ASTVisitor } from '../../language/visitor.js';
import type { SDLValidationContext } from '../ValidationContext.js';
/**
 * Unique type names
 *
 * A GraphQL document is only valid if all defined types have unique names.
 */
export declare function UniqueTypeNamesRule(context: SDLValidationContext): ASTVisitor;
