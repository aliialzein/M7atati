import bcrypt from 'bcryptjs';

// A real cost-12 hash keeps unknown-account verification on the bcrypt path.
const dummyHash = bcrypt.hashSync('Timing-only-password!42', 12);

export const passwordService = {
  hash: (password: string): Promise<string> => bcrypt.hash(password, 12),
  verify: (password: string, hash = dummyHash): Promise<boolean> =>
    bcrypt.compare(password, hash),
};
