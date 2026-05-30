import { SetMetadata } from '@nestjs/common';

export type Role = 'USER' | 'OPS' | 'ADMIN';
export const ROLES_KEY = 'roles';
/** Restricts a route to the given roles (RBAC — Section 13). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
