import { HttpError } from '../src/types/http-error.js';
import { registerSchema } from '../src/modules/auth/auth.validation.js';
import { passwordService } from '../src/modules/auth/password.service.js';
import { usersRepository } from '../src/modules/users/users.repository.js';
import { managedUser } from '../src/modules/users/users.types.js';

// Importing this helper does not run provisioning. Only the CLI invokes it.
export async function provisionInitialAdmin(
  input: unknown,
  repository = usersRepository,
  passwords = passwordService,
) {
  const credentials = registerSchema.parse(input);
  const passwordHash = await passwords.hash(credentials.password);
  return repository.transaction(async (tx) => {
    // Includes inactive ADMINs: this is bootstrap, not an account recovery backdoor.
    if ((await repository.countAdmins(tx)) > 0) {
      throw new HttpError(
        'An ADMIN account already exists; bootstrap is disabled',
        409,
      );
    }
    const role = await repository.findRole('ADMIN', tx);
    if (!role) throw new HttpError('Seeded ADMIN role is not configured', 409);
    return managedUser(
      await repository.create(
        {
          name: credentials.name,
          email: credentials.email,
          passwordHash,
          roleId: role.id,
          stationId: null,
        },
        tx,
      ),
    );
  });
}
