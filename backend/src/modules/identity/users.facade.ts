import { Injectable } from '@nestjs/common';
import { UserRepository } from './infrastructure/user.repository';

export interface UserContact {
  userId: string;
  email: string;
  displayName: string;
}

/**
 * Minimal public surface of Identity for other contexts (Section 17.7). Lets Notifications
 * resolve a recipient without querying identity tables directly (Rule 8). On extraction this
 * becomes an HTTP call to the Identity service.
 */
@Injectable()
export class UsersFacade {
  constructor(private readonly users: UserRepository) {}

  async getContact(userId: string): Promise<UserContact | null> {
    const u = await this.users.findById(userId);
    if (!u) return null;
    return { userId: u.id, email: u.email, displayName: u.displayName };
  }
}
